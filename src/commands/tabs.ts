// vixtab tabs [--json] [--load] | clear — every Claude Code tab on this machine, by VS Code window, and the tabs VixTab opened
// that have closed since. The VS Code panel's Tabs section shows the same (it runs `tabs --json` every few seconds: keep it cheap).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { has, parseArgs } from "../core/args.ts";
import { CACHE, windows } from "../core/bridge.ts";
import { registry, type SessionEntry } from "../core/claude.ts";
import { loadConfig } from "../core/config.ts";
import { alive, ancestors } from "../core/proc.ts";
import { measure } from "../core/resources.ts";
import {
  buildOverview, type Busiest, emptyState, formatOverview, type Gate, goneEvents, type Load, logTab, parseCodeStatus, projectResolver, readTabLog, type Session,
  type TabState,
} from "../core/tabs.ts";
import { platform } from "../platform/index.ts";
import { IS_WIN } from "../core/util.ts";
import { gate as sessionGate } from "./session.ts";

export const HELP = `vixtab tabs — every Claude Code tab on this machine, by VS Code window

  tabs [--json] [--load]   a summary (tabs, busy / idle / asking, windows, free RAM and CPU from the resource gate, can a new
                           tab open), then each VS Code window running VixTab with its Claude tabs: label, busy or idle and for
                           how long, the ticket's status for ticket tabs, the model VixTab opened it on. Then "Finished and
                           closed": the tabs VixTab opened that have closed since, newest first (last 50).
                           --load adds each window's renderer load (busiest thread, from \`code --status\`; it samples for a
                           few seconds; ≥ ~90 % = that window's tabs lag). --json is what the VS Code panel reads.
                           Windows without the VixTab extension are not listed (their tabs are only counted).
  tabs clear               empty the "Finished and closed" list

History: ~/.cache/vixtab/tabs.jsonl (written by session open / close, last ~500 events).`;

const stateFile = () => join(CACHE, "tabs-state.json");
function readState(): TabState {
  try {
    return { ...emptyState(), ...JSON.parse(readFileSync(stateFile(), "utf8")) };
  } catch {
    return emptyState();
  }
}
function writeState(s: TabState) {
  try {
    mkdirSync(CACHE, { recursive: true });
    const tmp = `${stateFile()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s));
    renameSync(tmp, stateFile());
  } catch {}
}

/** The resource gate of the project we run in (its limits, its recent opens); outside a project only RAM and CPU. */
async function measureGate(): Promise<Gate> {
  let c = null;
  try {
    c = loadConfig();
  } catch {}
  const g = c ? await sessionGate(c) : await measure({ minFreeMB: 0, maxCommit: 1, maxCpu: 1 });
  return { open: c ? !g.missing.length : null, missing: c ? g.missing : [], line: g.line, freeMB: g.freeMB, cpuPct: Math.round(g.cpu * 100) };
}

/** Renderer load of each window (extension host pid → load) and the busiest renderer, or null when not measurable here. */
async function windowLoads(): Promise<{ loads: Map<number, Load>; busiest: Busiest } | null> {
  const code = Bun.which("code");
  // Started first: it runs while rendererLoad() samples (both take a few seconds).
  const p = code ? Bun.spawn(IS_WIN ? ["cmd.exe", "/d", "/c", code, "--status"] : [code, "--status"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" }) : null;
  const kill = setTimeout(() => p?.kill(), 20_000);
  try {
    const pct = platform.rendererLoad();
    if (!pct.length) return null; // VS Code Remote: the renderers are not on this machine
    const top = pct.reduce((a, b) => (b.pct > a.pct ? b : a));
    const loads = new Map<number, Load>();
    for (const [host, renderer] of p ? parseCodeStatus(await new Response(p.stdout).text()) : []) {
      const r = pct.find((x) => x.pid === renderer);
      if (r) loads.set(host, { pct: r.pct, renderer });
    }
    return { loads, busiest: { ...top, window: [...loads].find(([, l]) => l.renderer === top.pid)?.[0] ?? null } };
  } finally {
    clearTimeout(kill);
    try {
      p?.kill();
    } catch {}
  }
}

export async function overview(o: { load?: boolean } = {}) {
  const now = Date.now();
  const st = readState();
  const wins = windows();
  const winPids = wins.map((w) => w.pid);
  const sessions = (registry() as (SessionEntry & Session)[]).filter(
    (s) => s.entrypoint === "claude-vscode" && typeof s.sessionId === "string" && typeof s.cwd === "string" && alive(s.pid),
  );

  // pid → window by process ancestry (a tab's CLI descends from its window's extension host). Listing processes takes a second
  // or two on Windows, so only for tabs not seen before, or when a window registered since.
  const sameWindows = st.windows.length === winPids.length && st.windows.every((p) => winPids.includes(p));
  const known = (s: Session) => {
    const k = st.win[s.pid];
    return k && k.sid === s.sessionId && (k.win ? winPids.includes(k.win) : sameWindows);
  };
  const need = sessions.filter((s) => !known(s));
  if (need.length) {
    const list = platform.processes();
    for (const s of need) st.win[s.pid] = { sid: s.sessionId, win: ancestors(s.pid, list).find((p) => winPids.includes(p)) ?? 0 };
  }
  st.windows = winPids;
  st.win = Object.fromEntries(sessions.map((s) => [String(s.pid), st.win[s.pid]]));

  // Tabs VixTab opened that disappeared without `session close`.
  let events = readTabLog();
  const live = new Set(sessions.map((s) => s.sessionId));
  const gone = goneEvents(events, live, st.seen, now);
  for (const e of gone) logTab(e);
  if (gone.length) events = readTabLog();

  if (o.load || !st.gate || now - st.gate.at > 20_000) st.gate = { ...(await measureGate()), at: now };
  const { at: _, ...gate } = st.gate;
  const loads = o.load ? await windowLoads() : null;
  const view = buildOverview({
    now, sessions, windows: wins, windowOf: (pid) => st.win[pid]?.win ?? 0, events, project: projectResolver(), gate,
    loads: loads?.loads ?? null, busiest: loads?.busiest ?? null,
  });
  if (o.load && !loads) view.summary.loadMeasured = false;

  const opened = new Set(events.flatMap((e) => (e.ev === "open" ? [e.sessionId] : [])));
  for (const t of view.windows.flatMap((w) => w.tabs)) st.seen[t.sessionId] = { at: now, status: t.ticket?.status ?? null };
  st.seen = Object.fromEntries(Object.entries(st.seen).filter(([sid]) => opened.has(sid) || live.has(sid)));
  writeState(st);
  return view;
}

export async function tabs(argv: string[]): Promise<void> {
  const a = parseArgs(argv);
  const action = a._[0];
  if (action === "clear") {
    logTab({ ev: "clear", at: Date.now() });
    return void console.log("Cleared the finished-and-closed list.");
  }
  if (action) {
    console.log(HELP);
    if (action !== "help") process.exitCode = 2;
    return;
  }
  const view = await overview({ load: has(a, "load") });
  console.log(has(a, "json") ? JSON.stringify(view) : formatOverview(view));
}

