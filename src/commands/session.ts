// vixtab session open | close | count | list | queue — Claude Code tabs, one fresh session per ticket.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { has, parseArgs, str } from "../core/args.ts";
import {
  type WindowInfo, type WindowTabs, callerWindow, census, censusNow, findWindow, forgetCensus, openTicketWindow, send, windowInfo, windowTabs,
  windows,
  windowsWithLabel,
} from "../core/bridge.ts";
import { type SessionEntry, TrustNeeded, claudeVersion, createLabeledSession, liveSessionsUnder, registry } from "../core/claude.ts";
import { isModelName, modelArg, sessionModel } from "../core/board.ts";
import { syncBoard, ticketOnBoard } from "../core/boardstore.ts";
import { type Config, isId, labelName, loadConfig, sessionLabel } from "../core/config.ts";
import { type Owner, type WaitState, gone } from "../core/locks.ts";
import { locksOf } from "../core/mainline.ts";
import { alive } from "../core/proc.ts";
import { measure } from "../core/resources.ts";
import { type TabEvent, fmtDuration, logTab, openTabByLabel, readTabLog, ticketStatus } from "../core/tabs.ts";
import { usageGate } from "../core/usage.ts";
import { platform } from "../platform/index.ts";
import { VixError, fail, isInside, native, norm, samePath, sleep, writeAtomic } from "../core/util.ts";

export const HELP = `vixtab session — fresh, labeled Claude Code tabs in VS Code

  session open <name> [<name>…] [--cwd DIR] [--prompt TEXT] [--model M] [--focus] [--here] [--trust] [--no-gate]
               [--wait S] [--wait-gate[=S]] [--parallel N] [--timings]
        New session whose tab is labeled <prefix>-<name> (VE-T-001), without stealing focus (unless --focus). <prefix> is the
        project's "sessionPrefix" in vixtab.config.json, by default the initials of the project folder's name
        (Vixtab-extension → VE) or the first 3 letters of a one-word name (recipes → REC): tabs of different projects never
        share a label. <name> is usually a ticket id. No model turn: no tokens. --prompt
        pre-fills the input box (it is not sent). --model (sonnet, opus, haiku or an id such as claude-sonnet-5-5): the tab
        runs on that model; without it, on the Model line of the ticket <name> if it has one, else on the user's default
        (never changed: the model is set for this session only, at the cost of one one-word turn on it; "default" forces the
        default). Where the tab goes follows "tabs" in vixtab.config.json: by default the
        orchestrator's own window until it holds 6 Claude tabs (new columns up to 3, then stacked in the last one), then
        ticket windows (separate VS Code windows, 6 Claude tabs each; a new one only when all are full), because all tabs of
        one window share one renderer thread. 6 is each window's setting VixTab: Max Tabs Per Window
        (vixtab.maxTabsPerWindow); "tabs" inWindowMax / perWindowMax override it for the project. The Claude tabs of each
        window are counted when the tab opens, and once more by that window right before. --here: the caller's column,
        no cap. No trust prompt when the folder is open in a VS Code window running VixTab (VS Code trusts it); --trust
        answers the CLI's prompt in other cases.
        Several names: one command opens them all (up to --parallel N at a time, default 3), prints one session= line per
        tab as it opens, then "batch: opened=<names> not_opened=<names>"; each failure on stderr as "<name> (exit <n>): …".
        A failure that would stop the others too (exit 3,
        4 "reload needed", 6, 7) leaves the rest unopened; other failures (2, 5) skip that name only. Exit code: 0; else
        that of the failure that stopped the batch; else that of the first name that failed.
        Openers of one project wait for each other only while one of them checks the resource gate (seconds), first come
        first served; creating the session, choosing the window, opening the tab and waiting for its CLI run side by side.
        --wait S: how long to wait in that line (default 600; 0 = do not wait). --wait-gate[=S]: when the resource gate is
        closed (RAM, swap, commit, CPU, sessions.max), wait until it opens (default 900 s, checked every 10 s) instead of exit
        6; the usage limit still exits 6 at once. vixtab session queue shows the line. --timings prints how long each
        step took (also kept in the tab history).
        Prints: session=<uuid> name=<address> pid=<pid> label=<label> auto_name=<registry name> window=<extension host pid>
        … model=<model or default>
        Exit codes: 2 bad label · 3 Claude CLI problem (3 + "trust" = folder not trusted: re-run with --trust after the
        user agrees) · 4 tab problem (4 + "reload needed" = Claude Code's tab state is broken: the user must reload the
        window) · 5 label already open, or being opened by another command (when this project's tab is found, its
        session=… line is printed with existing=yes, so a caller that was interrupted can carry on) · 6 resource gate
        closed, every window full, or the line did not move within --wait (queue the ticket, retry later; with "usage:"
        the Claude account is at the usage limit: wait for it with vixtab usage wait)
  session close <name> [<pid>]     close this project's tab labeled <prefix>-<name> (windows of other projects are never
        searched); with pid, wait until that CLI has exited.
        Tab actions run one at a time; closing a tab can take up to a minute while Claude Code shuts the session down.
        Exit codes: 1 no tab or several tabs with this label · 2 the CLI did not exit · 4 extension did not answer
  session count                    sessions of this repo, the resource gate ("open: yes" or what is missing), the Claude tabs
                                   of each VS Code window and its cap (claude_tabs=3/6) and who counted them, and the busiest
                                   renderer thread of each local VS Code window. No window is asked: each window keeps its
                                   tabs in ~/.cache/vixtab/window-tabs, and a window with an older extension is counted
                                   from its Claude processes
  session queue                    this project's openers: who checks the gate now (and what it waits for), who is in line,
                                   the tabs being opened and their step, how long recent opens took, windows not answering
  session list                     live Claude sessions of this repo (pid, name, session id, cwd)
  (every Claude tab of this machine by window, and the closed ones: vixtab tabs)

Resource gate (no fixed session cap by default): RAM in use ≤ 92 % (maxRam), counting the RAM reserved for tabs being opened
and for those opened in the last 90 s (or free RAM ≥ minFreeRamMB when that is set), swap ≤ maxSwapMB, commit ≤ 85 %
(Windows), CPU ≤ 85 %. Configure in vixtab.config.json "sessions" or VIXTAB_* variables.
The Claude account's 5-hour session and week must also be below the usage limit (vixtab usage limit, default 96 %); an
unknown usage does not close the gate.`;

// ── Opens in flight ────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * One tab being opened, or opened moments ago: <locks>/opens/<label>.<pid>.<time>.json, written only by its opener (one file
 * per open: a failed open of a label never removes the reservation of an earlier one). From the moment the
 * gate lets it through until RESERVE_MS after its tab started, it reserves sessions.reserveMB of RAM for the gate (so openers
 * that pass the gate one after the other do not all count the same free RAM); `phase` says which step it is at.
 */
export type OpenRecord = {
  label: string; pid: number; host: string; started: number; phase: string; since: number; at: number; reserved: boolean;
  window?: number; done?: number;
};
export const RESERVE_MS = 90_000;
const GATE_POLL_MS = 10_000;
export const opensDir = (c: Config) => join(c.locks, "opens");
/** File-name form of a label: letters, digits, . _ - kept, anything else as _<hex>. */
export const labelKey = (label: string) => label.replace(/[^A-Za-z0-9_.-]/g, (ch) => `_${ch.codePointAt(0)!.toString(16)}`);

const readJson = (p: string): any => {
  for (let i = 0; i < 2; i++) {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      if (i === 0) Bun.sleepSync(25); // replaced at this very moment (Windows refuses to read a file being renamed over)
    }
  }
  return null;
};
const ownerOf = (r: OpenRecord): Owner => ({ pid: r.pid, host: r.host, at: "", note: "", started: r.started });

/**
 * Opens still in flight (their opener alive) and opens done within RESERVE_MS. Records of dead openers are removed. A record
 * that cannot be read (being replaced right now) counts as an open in flight while it is recent: better one reservation too
 * many than two openers on the same free RAM.
 */
export function openRecords(c: Config, now = Date.now()): OpenRecord[] {
  const d = opensDir(c);
  if (!existsSync(d)) return [];
  const out: OpenRecord[] = [];
  for (const f of readdirSync(d).filter((x) => x.endsWith(".json"))) {
    const r = readJson(join(d, f)) as OpenRecord | null;
    if (!r) {
      let age = Infinity;
      try {
        age = now - statSync(join(d, f)).mtimeMs;
      } catch {}
      const label = f.split(".")[0];
      if (age < 600_000) out.push({ label, pid: 0, host: hostname(), started: 0, phase: "?", since: now - age, at: now - age, reserved: true });
      else rmSync(join(d, f), { force: true });
      continue;
    }
    if (r.done ? now - r.done < RESERVE_MS : !gone(ownerOf(r))) out.push(r);
    else if (!r.done || now - r.done > 600_000) rmSync(join(d, f), { force: true });
  }
  return out;
}

class OpenTrack {
  file: string;
  r: OpenRecord;
  constructor(c: Config, label: string) {
    mkdirSync(opensDir(c), { recursive: true });
    const now = Date.now();
    this.file = join(opensDir(c), `${labelKey(label)}.${process.pid}.${now}.json`);
    this.r = { label, pid: process.pid, host: hostname(), started: platform.startKey(process.pid), phase: "check", since: now, at: now, reserved: false };
    this.write();
  }
  write(must = false) {
    try {
      writeAtomic(this.file, JSON.stringify(this.r));
    } catch (e) {
      if (must) throw e; // the reservation: without it the gate would count this tab's RAM as free
    }
  }
  set(phase: string, window?: number) {
    Object.assign(this.r, { phase, since: Date.now() }, window ? { window } : {});
    if (phase === "window") delete this.r.window; // choosing (again): no target yet
    this.write();
  }
  reserve() {
    this.r.reserved = true;
    this.write(true);
  }
  done(window?: number) {
    Object.assign(this.r, { phase: "done", done: Date.now() }, window ? { window } : {});
    this.write();
  }
  drop() {
    rmSync(this.file, { force: true });
  }
}
export async function gate(c: Config) {
  const n = liveSessionsUnder([c.repo, c.home]).length;
  const opens = openRecords(c).filter((r) => r.reserved);
  // A tab being opened has no CLI yet: count it against sessions.max, or parallel openers would all fit under the cap.
  const flying = opens.filter((r) => !r.done).length;
  const reserved = opens.length * c.sessions.reserveMB;
  const [g, u] = await Promise.all([
    measure({ minFreeMB: c.sessions.minFreeRamMB, maxRam: c.sessions.maxRam, maxSwapMB: c.sessions.maxSwapMB, maxCommit: c.sessions.maxCommit, maxCpu: c.sessions.maxCpu }, reserved),
    usageGate(),
  ]);
  if (c.sessions.max > 0 && n + flying >= c.sessions.max) g.missing.unshift(`sessions ${n}${flying ? ` + ${flying} opening` : ""} ≥ max ${c.sessions.max}`);
  g.missing.push(...u.missing);
  return { ...g, line: `sessions=${n}${flying ? `+${flying}` : ""}${c.sessions.max > 0 ? "/" + c.sessions.max : ""} ${g.line} ${u.line}` };
}

/** A window of this project: it has the repository open, or the folder a tab was opened in. */
const ofProject = (c: Config, win: number, cwd?: string) => windowInfo(win)?.folders.some((f) => samePath(f, c.repo) || (!!cwd && samePath(f, cwd))) ?? false;

/** The most Claude tabs VixTab puts in a window: "tabs" in vixtab.config.json (or VIXTAB_TABS_*) when set, else the window's own setting. */
export const capOf = (c: Config, kind: string | undefined, setting: number) => (kind === "tickets" ? c.tabs.perWindowMax : c.tabs.inWindowMax) ?? setting;
const holds = (win: number, n: number, max: number) => `window ${win} holds ${n} Claude tab${n === 1 ? "" : "s"} (max ${max})`;

export type Target = { win: number; stack: boolean; max: number; note?: string };

/** What chooseWindow asks of the VS Code windows: the bridge, or fakes in the tests. */
export type WindowIO = {
  /** The caller's window, and whether VIXTAB_EXT_HOST_PID pins it. */
  base: (cwd: string) => { win: number; pinned: boolean };
  windows: () => WindowInfo[];
  tabs: (win: number) => Promise<WindowTabs>;
  openTicketWindow: (cwd: string) => Promise<number>;
  /** Hold a lock of the project (opening a ticket window); absent: no lock (tests). */
  lock?: (c: Config, name: string) => Promise<() => void>;
  /** Tabs other openers are opening in that window right now, not counted by it yet; absent: none (tests). */
  pending?: (c: Config, win: number) => number;
  /** Count afresh: called once at the start of each choice. */
  recount?: () => void;
};
/** Opens of this project in flight towards `win` (session created or tab opening) whose tab the window does not count yet. */
export function pendingIn(c: Config, win: number, labels: string[], records = openRecords(c)): number {
  return records.filter((r) => !r.done && r.window === win && ["create", "open", "cli"].includes(r.phase) && !labels.includes(r.label)).length;
}
const bridgeIO: WindowIO = {
  base: (cwd) => {
    const pinned = Number(process.env.VIXTAB_EXT_HOST_PID ?? 0);
    return { win: pinned || callerWindow() || findWindow(cwd), pinned: pinned > 0 };
  },
  windows,
  tabs: windowTabs,
  openTicketWindow,
  lock: (c, name) => locksOf(c).take(name, 180_000, "open a ticket window"),
  pending: (c, win) => pendingIn(c, win, censusNow().get(win)?.labels ?? []),
  recount: forgetCensus,
};

/**
 * Window for a new tab. Every window's Claude tabs are counted now, when the tab is about to open (tickets end, the user opens
 * and closes tabs), against its cap (capOf). --here ⇒ the caller's column, no cap (the Start orchestrator button).
 * VIXTAB_EXT_HOST_PID or mode columns ⇒ that / the caller's window as a column. Otherwise by the tabs policy: the orchestrator's
 * window below its cap (mode auto; columns up to columnsMax, then stacked), then the ticket window with the fewest Claude tabs
 * below its cap, else a new ticket window; if that cannot open, the caller's window. A full window is never used: exit 6.
 * The counts come from the census (no window is asked; see bridge.ts), plus the tabs other openers are about to put there. A
 * window that does not answer is never used. A new ticket window opens under the project's "ticket-window" lock, after one
 * more look: openers running side by side would otherwise each open one.
 */
export async function chooseWindow(c: Config, cwd: string, here: boolean, io: WindowIO = bridgeIO): Promise<Target> {
  const { win: base, pinned } = io.base(cwd);
  if (here) return { win: base, stack: false, max: 0 };
  io.recount?.();
  const all = io.windows();
  const count = async (win: number) => {
    const t = await io.tabs(win);
    return t.n < 0 ? t : { ...t, n: t.n + (io.pending?.(c, win) ?? 0) };
  };
  const baseKind = all.find((w) => w.pid === base)?.kind;
  if (pinned || c.tabs.mode === "columns") {
    const t = await count(base), max = capOf(c, baseKind, t.max);
    if (t.n >= max) fail(`NOT OPENED: ${holds(base, t.n, max)} — queue the ticket and retry when a tab has closed`, 6);
    return { win: base, stack: false, max };
  }
  // The orchestrator's own window first (user's rule, 25/10/2026: a new window for a handful of tabs is waste and clutter):
  // up to its cap in all, new columns up to columnsMax, then stacked into the last column.
  if (c.tabs.mode === "auto" && baseKind !== "tickets") {
    // Columns: the window's own layout; a window counted from its processes has one column per tab, as VixTab placed them.
    const t = await count(base), max = capOf(c, baseKind, t.max);
    if (t.n >= 0 && t.n < max) return { win: base, stack: (t.layout ? t.layout.length : t.n) >= c.tabs.columnsMax, max };
  }
  const roomy = async (ws: WindowInfo[]): Promise<Target | null> => {
    const ticketWs = ws.filter((x) => x.kind === "tickets" && x.pid !== base && x.folders.some((f) => samePath(f, cwd)));
    const counts = await Promise.all(ticketWs.map((w) => count(w.pid)));
    let best: Target | null = null, fewest = Infinity;
    ticketWs.forEach((w, i) => {
      const t = counts[i], max = capOf(c, "tickets", t.max);
      if (t.n >= 0 && t.n < max && t.n < fewest) [best, fewest] = [{ win: w.pid, stack: true, max }, t.n];
    });
    return best;
  };
  const best = await roomy(all);
  if (best) return best;
  const release = io.lock ? await io.lock(c, "ticket-window").catch(() => () => {}) : () => {};
  try {
    const now = await roomy(io.windows()); // another opener may have opened one meanwhile
    if (now) return now;
    try {
      const win = await io.openTicketWindow(cwd);
      return { win, stack: true, max: capOf(c, "tickets", (await io.tabs(win)).max) };
    } catch (e) {
      const why = (e as Error).message.split("\n")[0];
      const t = await count(base), max = capOf(c, baseKind, t.max);
      if (t.n < 0 || t.n >= max) fail(`NOT OPENED: every window is full and a ticket window could not open (${why}) — queue the ticket and retry later`, 6);
      return { win: base, stack: false, max, note: `WARNING: could not open a ticket window (${why}) — opened as a column instead` };
    }
  } finally {
    release();
  }
}

// ── Opening ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type OpenOptions = {
  cwd: string; prompt?: string; model: string | undefined; focus: boolean; here: boolean; trust: boolean; gate: boolean;
  /** Longest wait in line for the session-open lock, ms. */
  waitMs: number;
  /** Longest wait for a closed resource gate to open, ms (0: exit 6 at once), and how often it is measured meanwhile. */
  gateWaitMs: number;
  gatePollMs?: number;
  timings: boolean;
  /** Progress lines (stderr). */
  say: (line: string) => void;
};

/** What opening a tab talks to: VS Code windows, the Claude CLI, the machine. Fakes in the tests. */
export type OpenDeps = {
  holders: (label: string) => Promise<number[]>;
  choose: (c: Config, cwd: string, here: boolean) => Promise<Target>;
  create: typeof createLabeledSession;
  send: (action: string, args: Record<string, unknown>, timeoutMs: number, win: number) => Promise<any>;
  registry: () => SessionEntry[];
  gate: (c: Config) => Promise<{ line: string; missing: string[] }>;
  log: (e: TabEvent) => void;
};
export const realDeps: OpenDeps = { holders: windowsWithLabel, choose: (c, cwd, here) => chooseWindow(c, cwd, here), create: createLabeledSession, send, registry, gate, log: (e) => logTab(e) };

/** The session= line, from the tab's registry entry. */
function sessionLine(e: SessionEntry, label: string, win: number, model: string | null, stacked = false): string {
  // SendMessage address: Claude Code 2.1.308 (checked on Windows) uses the /rename title (= label); 2.1.280 (Linux) the
  // auto-generated name. Print the one that should work as name=, and both for the fallback.
  const v = claudeVersion();
  const byLabel = !v || v[0] > 2 || (v[0] === 2 && (v[1] > 1 || v[2] >= 300));
  return `session=${e.sessionId} name=${byLabel ? label : (e.name ?? label)} pid=${e.pid} label=${label} auto_name=${e.name ?? ""} window=${win}${windowInfo(win)?.kind === "tickets" ? " (ticket window)" : ""}${stacked ? " stacked" : ""} model=${model ?? "default"}`;
}

/** This project's tab that already has the label: its session= line, so a caller whose open was interrupted can carry on. */
function existingLine(c: Config, label: string, holders: number[], d: OpenDeps): string | null {
  const opened = openTabByLabel(readTabLog(), label);
  const own = holders.filter((w) => ofProject(c, w, opened?.cwd));
  if (own.length !== 1) return null;
  const live = d.registry().filter((x) => x.entrypoint === "claude-vscode" && alive(x.pid));
  const e = (opened && live.find((x) => x.sessionId === opened.sessionId)) || live.find((x) => x.name === label && (!x.cwd || isInside(x.cwd, c.repo) || (!!opened && samePath(x.cwd, opened.cwd))));
  return e ? `${sessionLine(e, label, own[0], opened?.sessionId === e.sessionId ? opened.model : null)} existing=yes` : null;
}

const secs = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`);
const STEPS = ["check", "queue", "gate", "window", "create", "open", "cli"] as const;

/** Durations of this project's recent opens (tab history), for the queue's estimates. */
export function recentTimings(c: Config, n = 10, events = readTabLog()): Record<string, number>[] {
  return events.flatMap((e) => (e.ev === "open" && e.ms && isInside(e.cwd, c.repo) ? [e.ms] : [])).slice(-n);
}
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

class GateClosed extends Error {}

/** Wait in line for the session-open lock, then for the resource gate; reserve RAM for this tab. */
async function passGate(c: Config, label: string, track: OpenTrack, o: OpenOptions, lap: (step: string) => void, d: OpenDeps): Promise<void> {
  const L = locksOf(c);
  const hold = median(recentTimings(c, 20).map((m) => (m.gate ?? 0))) || 2000;
  let said = "", saidAt = 0;
  const onWait = (s: WaitState) => {
    // The holder waits for a closed gate: without --wait-gate this opener would only find it closed too.
    if (!o.gateWaitMs && s.status.includes("waits for the resource gate:")) throw new GateClosed(s.status.replace(/^.*waits for the resource gate: /, ""));
    if (s.waitedMs < 1000) return;
    const holder = s.owner ? `pid ${s.owner.pid} ${s.owner.note}${s.status ? ` (${s.status})` : ""}` : "?";
    const what = `${s.position}/${s.waiting} ${holder}`;
    if (what === said || Date.now() - saidAt < 5000) return;
    [said, saidAt] = [what, Date.now()];
    o.say(`  … ${label}: in line for the session-open lock, ${s.position === 1 ? "next" : `${s.position - 1} ahead`} (holder: ${holder})${s.status ? "" : ` — about ${secs(s.position * hold)}`}`);
  };
  track.set("queue");
  let release: () => void;
  try {
    // With --wait-gate, the openers ahead may each wait for the gate as long: wait in line for that too.
    release = await L.take("session-open", o.waitMs + o.gateWaitMs, `open ${label}`, { queue: true, onWait });
  } catch (e) {
    if (e instanceof GateClosed) fail(`NOT OPENED: ${label}: resource gate closed — ${e.message} (the opener ahead waits for it; pass --wait-gate to wait too)`, 6);
    fail(`NOT OPENED: ${label}: ${(e as Error).message} — waited ${Math.round(o.waitMs / 1000)} s in line (--wait); vixtab session queue shows the line`, 6);
  }
  lap("queue");
  try {
    track.set("gate");
    const until = Date.now() + o.gateWaitMs;
    let why = "";
    for (;;) {
      const g = await d.gate(c);
      if (!g.missing.length) break;
      const now = g.missing.join("; ");
      // The usage limit resets after hours: that is a pause for the orchestrator (vixtab usage wait), not a wait here.
      if (Date.now() >= until || g.missing.some((m) => m.startsWith("usage:"))) fail(`NOT OPENED: ${g.line} — ${now}`, 6);
      L.setStatus("session-open", `${label} waits for the resource gate: ${now}`);
      if (now !== why) o.say(`  … ${label}: resource gate closed (${now}) — waiting up to ${Math.round((until - Date.now()) / 1000)} s more (--wait-gate)`);
      why = now;
      await sleep(Math.max(0, Math.min(o.gatePollMs ?? GATE_POLL_MS, until - Date.now())));
    }
    track.reserve();
  } finally {
    release();
  }
}

/** Open one tab; returns the lines to print. Throws a VixError with the exit code on failure. */
export async function openOne(c: Config, rawName: string, o: OpenOptions, d: OpenDeps = realDeps): Promise<string[]> {
  const t0 = Date.now(), ms: Record<string, number> = {};
  let mark = t0;
  const lap = (k: string) => {
    const now = Date.now();
    ms[k] = (ms[k] ?? 0) + now - mark;
    mark = now;
  };
  // The label is <prefix>-<name> (VE-T-001): tabs of other projects never share a label with this project's.
  const name = labelName(c, rawName);
  const label = sessionLabel(c, name);
  if ([...label].length > 25 || !/^[\p{L}\p{N} ._#-]+$/u.test(label)) fail(`label ${label}: at most 25 letters, digits, spaces or . _ # - (the project prefix included)`, 2);
  const cwd = o.cwd;
  // --model, else the Model line of the ticket named <name> (on the board), else the user's default.
  let ticketText: string | null = null;
  if (o.model === undefined && isId(c, name)) {
    syncBoard(c);
    ticketText = ticketOnBoard(c, name)?.text ?? null;
  }
  const model = sessionModel(o.model, ticketText);
  if (model && !isModelName(model)) fail(`the Model line of ${name} is not a model name: ${model}`, 2);

  // This label is opened by one command at a time (two openers of one label would both find it free in every window).
  const L = locksOf(c);
  const claimName = `open-${labelKey(label)}`;
  const claim = L.tryTake(claimName, `open ${label}`);
  if (!claim) {
    const w = L.owner(claimName);
    fail(`a tab labeled "${label}" is being opened right now by another command (pid ${w?.pid ?? "?"}, since ${w?.at ?? "?"})`, 5);
  }
  const track = new OpenTrack(c, label);
  let ok = false;
  try {
    // Labels must be unique across every window: close finds the tab by label, SendMessage the session by name. The census
    // knows the labels of every window's tabs without asking it.
    const holders = await d.holders(label);
    if (holders.length) {
      const line = existingLine(c, label, holders, d);
      if (line) console.log(line);
      fail(`a Claude tab labeled "${label}" is already open (window ${holders.join(", ")})${holders.some((w) => !ofProject(c, w)) ? ` in another project: give one of them its own "sessionPrefix" in vixtab.config.json` : ""}`, 5);
    }
    lap("check");
    if (o.gate) await passGate(c, label, track, o, lap, d);
    else track.reserve();
    lap("gate");
    const ownFolder = (win: number) => {
      const info = windowInfo(win);
      if (info && !info.folders.some((x) => samePath(x, cwd)))
        fail(`the VS Code window ${win} has ${info.folders.map(native).join(", ") || "no folder"} open, but Claude Code only opens sessions of the window's own folder. Open ${native(cwd)} in VS Code (code -n "${native(cwd)}") and run this there, or pass --cwd <that folder>.`, 2);
      return info;
    };
    track.set("window");
    let target = await d.choose(c, cwd, o.here);
    const info = ownFolder(target.win);
    lap("window");
    track.set("create", target.win);
    let id: string;
    try {
      // The target window has the folder open and runs VixTab, so VS Code trusts it: no CLI trust prompt (see claude.ts).
      id = await d.create(label, cwd, o.trust, { vscodeTrusted: !!info, model });
    } catch (e) {
      if (e instanceof TrustNeeded)
        fail(`trust: Claude Code has not been told to trust ${native(cwd)} yet. Ask the user; if they agree, run the same command with --trust (VixTab then answers "Yes, I trust this folder" once).`, 3);
      throw e;
    }
    lap("create");
    // The window counts its Claude tabs once more right before opening, in its queue of tab actions: creating the session
    // took seconds, and other openers may have filled it meanwhile. Full ⇒ choose again (extensions up to 0.8.0 ignore max).
    track.set("open", target.win);
    let opened: any;
    for (let tries = 1; ; tries++) {
      opened = await d.send("open", { session: id, label, prompt: o.prompt, focus: o.focus, here: o.here, stack: target.stack, max: target.max }, 240_000, target.win);
      lap("open");
      if (!opened.full) break;
      if (tries >= 5) fail(`NOT OPENED: session=${id}: ${holds(target.win, opened.held, opened.max)} — queue the ticket and retry later`, 6);
      track.set("window"); // not pending in the full window any more while choosing again
      target = await d.choose(c, cwd, o.here);
      ownFolder(target.win);
      lap("window");
      track.set("open", target.win);
    }
    if (opened.labeled === false) fail(`session=${id}: Claude Code kept opening an empty tab instead of the session (3 attempts) — the window may be overloaded; retry later`, 4);
    // A busy machine can take well over 20 s before the tab has started its CLI.
    track.set("cli", target.win);
    let entry: SessionEntry | null = null;
    for (let i = 0; i < 90 && !entry; i++, await sleep(500)) entry = d.registry().find((x) => x.sessionId === id && x.entrypoint === "claude-vscode" && alive(x.pid)) ?? null;
    if (!entry) {
      track.done(target.win); // the tab may still start its CLI: keep its RAM reserved
      fail(`session=${id}: the tab (window ${target.win}, column ${opened.column}) did not start its Claude process within 45 s`, 4);
    }
    lap("cli");
    ms.total = Date.now() - t0;
    track.done(target.win);
    ok = true;
    d.log({ ev: "open", at: Date.now(), label, sessionId: entry.sessionId, pid: entry.pid, cwd, window: target.win, model: model ?? null, ms });
    const out = [sessionLine(entry, label, target.win, model ?? null, target.stack)];
    if (target.note) out.push(target.note);
    if (o.timings) out.push(`timings ${label}: ${STEPS.filter((k) => ms[k] !== undefined).map((k) => `${k}=${secs(ms[k])}`).join(" ")} total=${secs(ms.total)}`);
    const dup = d.registry().filter((x) => (x.name === label || x.name === entry!.name) && x.pid !== entry!.pid && alive(x.pid)).length;
    if (dup) out.push(`WARNING: another live session is also named ${label}/${entry.name}; use the [ref] shown by ListAgents`);
    return out;
  } finally {
    if (!ok && track.r.phase !== "done") track.drop();
    claim();
  }
}

/** A failure that every other name of the batch would hit too: stop opening. */
const stopsBatch = (e: VixError) => e.code === 3 || e.code === 6 || e.code === 7 || (e.code === 4 && /reload needed/.test(e.message));

/** Open several tabs, up to `parallel` at a time. */
export async function openMany(c: Config, names: string[], o: OpenOptions, parallel: number, open = openOne): Promise<number> {
  const result: ("opened" | "failed" | "skipped")[] = names.map(() => "skipped");
  const codes: number[] = names.map(() => 0);
  let next = 0, stopped: string | null = null;
  const worker = async () => {
    while (next < names.length && !stopped) {
      const i = next++;
      try {
        console.log((await open(c, names[i], o)).join("\n"));
        result[i] = "opened";
      } catch (e) {
        const err = e instanceof VixError ? e : new VixError(e instanceof Error ? (e.stack ?? e.message) : String(e), 1);
        console.error(`${names[i]} (exit ${err.code}): ${err.message}`);
        [result[i], codes[i]] = ["failed", err.code];
        if (stopsBatch(err)) stopped ??= names[i];
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, names.length)) }, worker));
  const pick = (s: string) => names.filter((_, i) => result[i] === s).join(",");
  const skipped = pick("skipped");
  console.log(`batch: opened=${pick("opened")} not_opened=${names.filter((_, i) => result[i] !== "opened").join(",")}${skipped ? ` (not tried after ${stopped}: ${skipped})` : ""}`);
  return stopped ? codes[names.indexOf(stopped)] : (codes.find((x) => x !== 0) ?? 0);
}

/** argv with "--wait-gate 900" turned into "--wait-gate=900" (the flag takes an optional number). */
export const joinOptional = (argv: string[]) => argv.flatMap((x, i) => (x === "--wait-gate" && /^\d+$/.test(argv[i + 1] ?? "") ? [`--wait-gate=${argv[i + 1]}`] : i > 0 && argv[i - 1] === "--wait-gate" && /^\d+$/.test(x) ? [] : [x]));
const seconds = (v: string | undefined, dflt: number, what: string) => {
  if (v === undefined) return dflt;
  if (!/^\d+(\.\d+)?$/.test(v)) fail(`${what}: a number of seconds, not "${v}"`, 2);
  return Number(v) * 1000;
};

function queueReport(c: Config): string[] {
  const L = locksOf(c), now = Date.now(), out: string[] = [];
  const o = L.owner("session-open"), st = L.status("session-open");
  out.push(`session-open lock: ${o && !gone(o) ? `pid ${o.pid} ${o.note}, for ${fmtDuration(now - Date.parse(o.at))}${st ? ` — ${st}` : " — checking the resource gate"}` : "free"}`);
  const q = L.waiters("session-open");
  out.push(`in line: ${q.length ? q.map((w, i) => `${i + 1}. pid ${w.pid} ${w.note} (${fmtDuration(now - Date.parse(w.at))})`).join(" · ") : "nobody"}`);
  const fl = openRecords(c, now).filter((r) => !r.done);
  out.push(`opening: ${fl.length ? fl.map((r) => `${r.label} pid ${r.pid} ${r.phase}${r.window ? ` (window ${r.window})` : ""} for ${fmtDuration(now - r.since)}`).join(" · ") : "nothing"}`);
  const t = recentTimings(c);
  if (t.length) {
    const m = (k: string) => secs(median(t.map((x) => x[k] ?? 0)));
    out.push(`recent opens (last ${t.length}): median ${m("total")}, slowest ${secs(Math.max(...t.map((x) => x.total ?? 0)))} — ${STEPS.map((k) => `${k} ${m(k)}`).join(" · ")}`);
  } else out.push("recent opens: no timings recorded yet");
  const ws = windows(), cs = census(ws, now);
  const mute = ws.filter((w) => cs.get(w.pid)?.answers === false);
  if (mute.length) out.push(`windows not answering (no new tab goes there): ${mute.map((w) => `${w.pid} (${w.folders.map(native).join(", ")})`).join(" · ")}`);
  return out;
}

export async function session(argv: string[]): Promise<void> {
  const [action, ...rest] = argv;
  const a = parseArgs(joinOptional(rest), ["cwd", "prompt", "model", "wait", "parallel"]);
  switch (action) {
    case "count": {
      const c = loadConfig();
      const g = await gate(c);
      console.log(`${g.line} open: ${g.missing.length ? "no — " + g.missing.join("; ") : "yes"}`);
      const me = callerWindow();
      const ws = windows(), cs = census(ws);
      for (const w of ws) {
        const t = cs.get(w.pid)!;
        const how = !t.answers ? "not answering" : t.from === "window" ? "counted by the window" : "counted from its processes";
        console.log(`window=${w.pid} kind=${w.kind ?? "main"} claude_tabs=${t.n}/${capOf(c, w.kind, t.max)} (${how})${w.pid === me ? " (this window)" : ""} ${w.folders.map(native).join(", ")}`);
      }
      const load = platform.rendererLoad();
      if (load.length) console.log(`vscode_renderers busiest_thread=${load.map((r) => `${r.pid}:${r.pct}%`).join(" ")}  (≥ ~90 % = that window's tabs lag)`);
      return;
    }
    case "list": {
      const c = loadConfig();
      for (const s of liveSessionsUnder([c.repo, c.home])) console.log(`${String(s.pid).padEnd(8)} ${(s.name ?? "?").padEnd(26)} ${s.sessionId} ${s.entrypoint ?? ""} ${native(s.cwd)}`);
      return;
    }
    case "queue": {
      for (const l of queueReport(loadConfig())) console.log(l);
      return;
    }
    case "open": {
      const c = loadConfig();
      if (!a._.length) fail("usage: vixtab session open <name> [<name>…]", 2);
      const cwd = norm(str(a, "cwd") ?? c.repo);
      if (!existsSync(cwd)) fail(`no such folder: ${cwd}`, 2);
      const wg = a.flags["wait-gate"];
      const o: OpenOptions = {
        cwd, prompt: str(a, "prompt"), model: modelArg(a), focus: has(a, "focus"), here: has(a, "here"), trust: has(a, "trust"),
        gate: !has(a, "no-gate"), waitMs: seconds(str(a, "wait"), 600_000, "--wait"),
        gateWaitMs: wg === undefined ? 0 : wg === true ? 900_000 : seconds(wg, 0, "--wait-gate"), timings: has(a, "timings"),
        say: (l) => console.error(l),
      };
      if (a._.length === 1) {
        for (const l of await openOne(c, a._[0], o)) console.log(l);
        return;
      }
      const parallel = Number(str(a, "parallel") ?? 3);
      if (!Number.isInteger(parallel) || parallel < 1) fail("--parallel: a whole number ≥ 1", 2);
      process.exitCode = await openMany(c, a._, o, parallel);
      return;
    }
    case "close": {
      const c = loadConfig();
      const name = labelName(c, a._[0] ?? fail("usage: vixtab session close <name> [<pid>]", 2));
      const pid = Number(a._[1] ?? 0);
      const log = readTabLog();
      // The tab may live in the orchestrator's window or in any ticket window — of THIS project only: another project may
      // show a tab with the same label. A tab opened before labels had the project prefix (0.9.0 and older) has the bare name.
      const pinned = Number(process.env.VIXTAB_EXT_HOST_PID ?? 0);
      const find = async (l: string) => (pinned ? [pinned] : (await windowsWithLabel(l)).filter((w) => ofProject(c, w, openTabByLabel(log, l)?.cwd)));
      let label = sessionLabel(c, name);
      let where = await find(label);
      if (!pinned && !where.length && name !== label) {
        const bare = await find(name);
        if (bare.length) [label, where] = [name, bare];
      }
      if (where.length !== 1) fail(`NOT CLOSED: ${where.length ? `several windows (${where.join(", ")}) have` : "no window of this project has"} a Claude tab labeled "${label}"`, 1);
      let r = await send("close", { label }, 240_000, where[0]);
      if (pinned && !r.closed && !r.matches && name !== label) r = await send("close", { label: (label = name) }, 240_000, pinned);
      if (!r.closed) fail(`NOT CLOSED: ${r.matches} Claude tabs are labeled "${label}" (need exactly 1)`, 1);
      // History for the panel (vixtab tabs): the ticket status at closing time is the final one.
      const opened = openTabByLabel(log, label);
      if (opened) logTab({ ev: "close", at: Date.now(), label, sessionId: opened.sessionId, status: ticketStatus(opened.cwd, label) });
      if (!pid) return void console.log(`Closed "${label}".`);
      for (let i = 0; i < 60; i++, await sleep(500)) if (!alive(pid)) return void console.log(`Closed "${label}" (pid ${pid} exited).`);
      fail(`tab closed but pid ${pid} still runs after 30 s`, 2);
    }
    default:
      console.log(HELP);
      if (action && action !== "help") process.exitCode = 2;
  }
}
