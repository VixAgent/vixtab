// The tabs overview: every Claude Code tab on this machine grouped by the VS Code window it runs in, and the history of the tabs
// VixTab opened and that have closed since. The history is an append-only log, ~/.cache/vixtab/tabs.jsonl, written by
// `session open`, `session close` and by the overview itself when a tab it saw disappears ("gone"). Never inside a repository.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Row } from "./board.ts";
import { isLegacy, readBoard } from "./boardstore.ts";
import { CACHE } from "./bridge.ts";
import { type Config, isId, loadConfig } from "./config.ts";
import { fmtMB, norm } from "./util.ts";

export const tabLogFile = () => join(CACHE, "tabs.jsonl");
export const LOG_MAX = 500;
export const CLOSED_MAX = 50;

export type TabEvent =
  | { ev: "open"; at: number; label: string; sessionId: string; pid: number; cwd: string; window: number; model: string | null }
  /** close: by `session close`; gone: the overview saw the tab disappear (closed by hand, window closed). */
  | { ev: "close" | "gone"; at: number; label: string; sessionId: string | null; status: string | null }
  /** The panel's "Clear": closed tabs up to this moment are no longer listed. */
  | { ev: "clear"; at: number };

export function readTabLog(file = tabLogFile()): TabEvent[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((l) => {
      try {
        return l.trim() ? [JSON.parse(l)] : [];
      } catch {
        return [];
      }
    });
}

/**
 * The last `max` lines, plus the older `open` lines of tabs that have no close or gone line at all: they may still run, and
 * without their open line the overview would no longer know that VixTab opened them (nor their model).
 */
export function trimLog(lines: string[], max = LOG_MAX): string[] {
  if (lines.length <= max) return lines;
  const ended = new Set<string>();
  for (const l of lines) {
    try {
      const e = JSON.parse(l);
      if ((e.ev === "close" || e.ev === "gone") && e.sessionId) ended.add(e.sessionId);
    } catch {}
  }
  const cut = lines.length - max;
  const kept = lines.slice(0, cut).filter((l) => {
    try {
      const e = JSON.parse(l);
      return e.ev === "open" && !ended.has(e.sessionId);
    } catch {
      return false;
    }
  });
  return [...kept, ...lines.slice(cut)];
}

/** Append one event; past LOG_MAX + 100 lines the file is rewritten to the last LOG_MAX (trimLog). Lines are counted past 64 KB. */
export function logTab(e: TabEvent, file = tabLogFile()): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(e) + "\n");
    if (statSync(file).size < 65536) return;
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
    if (lines.length > LOG_MAX + 100) {
      writeFileSync(`${file}.tmp`, trimLog(lines).join("\n") + "\n");
      renameSync(`${file}.tmp`, file);
    }
  } catch {} // the history is a convenience: never fail a tab action over it
}

/** The latest open event of each session. */
export function latestOpens(events: TabEvent[]): Map<string, Extract<TabEvent, { ev: "open" }>> {
  const m = new Map<string, Extract<TabEvent, { ev: "open" }>>();
  for (const e of events) if (e.ev === "open" && (!m.has(e.sessionId) || m.get(e.sessionId)!.at <= e.at)) m.set(e.sessionId, e);
  return m;
}
/** The latest close or gone event of each session. */
export function latestEnds(events: TabEvent[]): Map<string, Extract<TabEvent, { ev: "close" | "gone" }>> {
  const m = new Map<string, Extract<TabEvent, { ev: "close" | "gone" }>>();
  for (const e of events) if ((e.ev === "close" || e.ev === "gone") && e.sessionId && (!m.has(e.sessionId) || m.get(e.sessionId)!.at <= e.at)) m.set(e.sessionId, e);
  return m;
}
/** The open event of the tab labeled `label` that has not been closed yet (the newest one). */
export function openTabByLabel(events: TabEvent[], label: string) {
  const ends = latestEnds(events);
  const open = (o: { sessionId: string; at: number }) => (ends.get(o.sessionId)?.at ?? -1) < o.at;
  return [...latestOpens(events).values()].filter((o) => o.label === label && open(o)).sort((a, b) => b.at - a.at)[0] ?? null;
}

export type ClosedTab = {
  label: string; sessionId: string; cwd: string; project: string; openedAt: number; closedAt: number; ranMs: number;
  status: string | null; model: string | null; how: "close" | "gone";
};

/** Tabs VixTab opened that are closed now (not running again), newest first, after the last "clear", at most `limit`. */
export function closedTabs(events: TabEvent[], live: Set<string>, limit = CLOSED_MAX): ClosedTab[] {
  const cleared = Math.max(0, ...events.filter((e) => e.ev === "clear").map((e) => e.at));
  const opens = latestOpens(events);
  const out: ClosedTab[] = [];
  for (const [sid, end] of latestEnds(events)) {
    const o = opens.get(sid);
    if (!o || live.has(sid) || end.at < o.at || end.at <= cleared) continue;
    out.push({ label: o.label, sessionId: sid, cwd: o.cwd, project: basename(norm(o.cwd)), openedAt: o.at, closedAt: end.at, ranMs: end.at - o.at, status: end.status, model: o.model, how: end.ev });
  }
  return out.sort((a, b) => b.closedAt - a.closedAt).slice(0, limit);
}

/** What the overview remembers between runs (~/.cache/vixtab/tabs-state.json): it is a cache, losing it costs one slow run. */
export type TabState = {
  /** Registered window pids when `win` was computed: a new window can be the one of a tab that had none. */
  windows: number[];
  /** Claude pid → its window's extension host pid (0 = none registered); `sid` guards against a reused pid. */
  win: Record<string, { sid: string; win: number }>;
  /** Last time each session was seen running, with its ticket status then (for "gone" events). */
  seen: Record<string, { at: number; status: string | null }>;
  gate?: Gate & { at: number };
};
export const emptyState = (): TabState => ({ windows: [], win: {}, seen: {} });

/**
 * "gone" events for tabs VixTab opened that no longer run and have no close/gone event since they were last seen (15 s grace).
 * A `close` is final: its CLI keeps running for a while after the tab closed. A `gone` is not: a window reload restarts every
 * CLI of the window, and a tab that comes back and disappears again gets a new one.
 */
export function goneEvents(events: TabEvent[], live: Set<string>, seen: TabState["seen"], now: number, graceMs = 15_000): TabEvent[] {
  const ends = latestEnds(events);
  const out: TabEvent[] = [];
  for (const [sid, o] of latestOpens(events)) {
    const end = ends.get(sid);
    if (live.has(sid) || (end?.ev === "close" && end.at >= o.at)) continue;
    const last = seen[sid]?.at ?? o.at;
    if ((end?.at ?? -1) >= last || now - last < graceMs) continue;
    out.push({ ev: "gone", at: seen[sid]?.at ?? now, label: o.label, sessionId: sid, status: seen[sid]?.status ?? null });
  }
  return out;
}

// ── The overview ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export type Gate = { open: boolean | null; missing: string[]; line: string; freeMB: number; cpuPct: number };
/** Busiest thread of the window's workbench renderer, % of one core. */
export type Load = { pct: number; renderer: number };
/** Busiest renderer of all, webviews included; `window` = its window when it is a workbench renderer. */
export type Busiest = { pid: number; pct: number; window: number | null };
export type Ticket = { id: string; status: string; title: string };
export type Tab = {
  pid: number; sessionId: string; label: string; cwd: string; project: string; repo: string | null;
  /** busy / idle from Claude Code's registry; "asking" when the ticket is ❓ ASK. */
  state: string; since: number | null; startedAt: number | null; openedAt: number | null;
  /** VixTab opened it (there is an open event). */
  vixtab: boolean; model: string | null; ticket: Ticket | null;
};
export type Window = { pid: number; project: string; folders: string[]; kind: "main" | "tickets"; version: string; load: Load | null; tabs: Tab[] };
export type Overview = {
  at: number;
  summary: {
    text: string; tabs: number; busy: number; idle: number; asking: number; windows: number;
    /** Claude tabs whose window does not run the VixTab extension: counted here, not listed. */
    unlisted: number;
    gate: Gate | null; busiestRenderer: Busiest | null; loadMeasured: boolean;
  };
  windows: Window[];
  closed: ClosedTab[];
};

export type Session = { pid: number; sessionId: string; cwd: string; name?: string; status?: string; statusUpdatedAt?: number; startedAt?: number };
export type WindowFile = { pid: number; folders: string[]; version: string; kind?: "main" | "tickets" };
export type Project = { repo: string | null; name: string; ticket: (label: string) => Ticket | null };

/** Board lookups of one run, one board read per project. */
export function projectResolver(): (cwd: string) => Project {
  const byCwd = new Map<string, Project>();
  const byRepo = new Map<string, Project>();
  return (cwd) => {
    const k = norm(cwd);
    if (byCwd.has(k)) return byCwd.get(k)!;
    let c: Config | null = null;
    try {
      c = loadConfig(cwd);
    } catch {}
    let p: Project = { repo: null, name: basename(k), ticket: () => null };
    if (c) {
      const conf = c;
      p = byRepo.get(conf.repo) ?? (() => {
        let rows: Row[] | null | undefined;
        const q: Project = {
          repo: conf.repo,
          name: basename(conf.repo),
          ticket: (label) => {
            if (!isId(conf, label)) return null;
            if (rows === undefined) {
              try {
                isLegacy(conf, true); // the overview runs every few seconds: no legacy-board warning
                rows = readBoard(conf).rows;
              } catch {
                rows = null;
              }
            }
            const r = rows?.find((x) => x.id === label);
            return r ? { id: r.id, status: r.status, title: r.title } : null;
          },
        };
        byRepo.set(conf.repo, q);
        return q;
      })();
    }
    byCwd.set(k, p);
    return p;
  };
}

export const ticketStatus = (cwd: string, label: string) => projectResolver()(cwd).ticket(label)?.status ?? null;

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Group live Claude tabs by window. `windowOf(pid)` = the window's extension host pid, 0 when it has none registered. */
export function buildOverview(o: {
  now: number; sessions: Session[]; windows: WindowFile[]; windowOf: (pid: number) => number; events: TabEvent[];
  project: (cwd: string) => Project; gate: Gate | null; loads: Map<number, Load> | null; busiest?: Busiest | null;
}): Overview {
  const opens = latestOpens(o.events);
  const ws: Window[] = o.windows.map((w) => ({
    pid: w.pid, project: basename(norm(w.folders[0] ?? "")) || "(no folder)", folders: w.folders, kind: w.kind ?? "main", version: w.version,
    load: o.loads?.get(w.pid) ?? null, tabs: [],
  }));
  let unlisted = 0;
  for (const s of o.sessions) {
    const w = ws.find((x) => x.pid === o.windowOf(s.pid));
    if (!w) {
      unlisted++;
      continue;
    }
    const open = opens.get(s.sessionId);
    const label = open?.label ?? s.name ?? s.sessionId.slice(0, 8);
    const p = o.project(open?.cwd ?? s.cwd);
    const ticket = p.ticket(label);
    w.tabs.push({
      pid: s.pid, sessionId: s.sessionId, label, cwd: s.cwd, project: p.name, repo: p.repo,
      state: ticket?.status.startsWith("❓") ? "asking" : (s.status ?? "unknown"),
      since: s.statusUpdatedAt ?? s.startedAt ?? null, startedAt: s.startedAt ?? null, openedAt: open?.at ?? null,
      vixtab: !!open, model: open?.model ?? null, ticket,
    });
  }
  for (const w of ws) w.tabs.sort((a, b) => collator.compare(a.label, b.label));
  ws.sort((a, b) => collator.compare(a.project, b.project) || (a.kind === b.kind ? a.pid - b.pid : a.kind === "main" ? -1 : 1));
  const all = ws.flatMap((w) => w.tabs);
  const n = (st: string) => all.filter((t) => t.state === st).length;
  const summary = { tabs: all.length, busy: n("busy"), idle: n("idle"), asking: n("asking"), windows: ws.length, unlisted, gate: o.gate, busiestRenderer: o.busiest ?? null, loadMeasured: !!o.loads };
  const live = new Set(o.sessions.map((s) => s.sessionId));
  return { at: o.now, summary: { text: summaryText(summary), ...summary }, windows: ws, closed: closedTabs(o.events, live) };
}

export function summaryText(s: { tabs: number; busy: number; idle: number; asking: number; windows: number; gate: Gate | null; busiestRenderer: Busiest | null }): string {
  const parts = [`${s.tabs} tab${s.tabs === 1 ? "" : "s"}`, `${s.busy} busy`, `${s.idle} idle`, `${s.asking} asking`, `${s.windows} window${s.windows === 1 ? "" : "s"}`];
  if (s.gate) parts.push(`RAM ${fmtMB(s.gate.freeMB)}B free`, `CPU ${s.gate.cpuPct} %`);
  if (s.busiestRenderer) parts.push(`busiest renderer ${s.busiestRenderer.pct} %${s.busiestRenderer.pct >= 90 ? " ⚠" : ""}`);
  return parts.join(" · ");
}

// ── Renderer load per window (`code --status`) ─────────────────────────────────────────────────────────────────────────────
/**
 * `code --status` lists VS Code's processes: "window [N] (title)" is the workbench renderer of window N and "extension-host [N]"
 * its extension host — the pid VixTab registers. Returns extension host pid → workbench renderer pid. The other renderers
 * (webviews, where Claude Code tabs draw) are listed as a bare "window", indented under unrelated processes (checked with VS
 * Code 1.143 on Windows): they cannot be attributed to a window.
 */
export function parseCodeStatus(text: string): Map<number, number> {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^CPU %\s+Mem MB\s+PID\s+Process/.test(l));
  const hosts = new Map<number, number>(), renderers = new Map<number, number>();
  for (const l of start < 0 ? [] : lines.slice(start + 1)) {
    const cols = l.split("\t");
    const pid = Number(cols[2]?.trim()), name = cols.slice(3).join("\t").trim();
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const win = /^window \[(\d+)\]/.exec(name), host = /^extension-host \[(\d+)\]/.exec(name);
    if (win) renderers.set(Number(win[1]), pid);
    if (host) hosts.set(pid, Number(host[1]));
  }
  const out = new Map<number, number>();
  for (const [pid, n] of hosts) if (renderers.has(n)) out.set(pid, renderers.get(n)!);
  return out;
}

// ── Text form ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
const clock = (t: number) => {
  const d = new Date(t), p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
/** "⏳ DOING (T-006)" → "⏳ DOING". */
export const shortStatus = (s: string) => s.replace(/\s*\(.*\)\s*$/, "");

export function formatOverview(o: Overview): string {
  const s = o.summary, out: string[] = [];
  const g = s.gate;
  out.push(`${s.text}${g ? ` · new tab: ${g.open === null ? "?" : g.open ? "yes" : `no — ${g.missing.join("; ")}`}` : ""}`);
  out.push(`(windows without the VixTab extension are not listed${s.unlisted ? `: ${s.unlisted} Claude tab${s.unlisted === 1 ? "" : "s"} there` : ""})`);
  const b = s.busiestRenderer;
  if (b) out.push(`(busiest renderer ${b.pid}: ${b.pct} %, ${b.window ? `the workbench of window ${b.window}` : "a webview renderer, where Claude tabs draw: VS Code does not say of which window"}; ≥ ~90 % = tabs lag)`);
  for (const w of o.windows) {
    const load = w.load ? ` · renderer ${w.load.pct} %${w.load.pct >= 90 ? " ⚠ its tabs lag" : ""}` : "";
    out.push("", `${w.project} — ${w.kind === "tickets" ? "ticket window" : "main window"} ${w.pid} · ${w.tabs.length} Claude tab${w.tabs.length === 1 ? "" : "s"}${load}`);
    for (const t of w.tabs) {
      const state = `${t.state}${t.since ? " " + fmtDuration(o.at - t.since) : ""}`;
      const tk = t.ticket ? shortStatus(t.ticket.status) + (t.ticket.status.startsWith("✅") ? " (waiting to be closed)" : "") : "";
      out.push(`  ${t.label.padEnd(26)} ${state.padEnd(14)} ${tk.padEnd(34)} ${t.model ?? ""}`.trimEnd());
    }
  }
  out.push("", `Finished and closed (${o.closed.length}${o.closed.length >= CLOSED_MAX ? `, last ${CLOSED_MAX}` : ""})${o.closed.length ? ":" : ""}`);
  for (const c of o.closed)
    out.push(`  ${c.label.padEnd(26)} ${c.project.padEnd(20)} ran ${fmtDuration(c.ranMs).padEnd(8)} closed ${clock(c.closedAt)}  ${c.status ?? ""}`.trimEnd());
  if (!s.loadMeasured) out.push("", "(renderer load: vixtab tabs --load)");
  return out.join("\n");
}
