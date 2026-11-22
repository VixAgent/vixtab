// File-command bridge to the VixTab VS Code extension. The extension registers its window in ~/.cache/vixtab/windows/<pid>.json
// (pid = its extension host) and executes commands written to ~/.cache/vixtab/commands/<pid>-<id>.cmd.json, answering in
// <pid>-<id>.result.json. Only the window whose pid is in the file name acts, so tabs open in the window you are working in.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { platform } from "../platform/index.ts";
import { registry } from "./claude.ts";
import { alive } from "./proc.ts";
import { run } from "./run.ts";
import { HOME, IS_WIN, fail, isInside, norm, samePath, sleep, writeAtomic } from "./util.ts";

/** The extension's Marketplace ID. Up to 0.6.0 it was LEGACY_EXTENSION_ID; setup and the extension itself remove that one. */
export const EXTENSION_ID = "vixagent.vixtab";
export const LEGACY_EXTENSION_ID = "phanthaitrung.vixtab";

/** VIXTAB_CACHE_DIR is for tests (fixture folders): the extension always uses ~/.cache/vixtab. */
export const CACHE = process.env.VIXTAB_CACHE_DIR ? norm(process.env.VIXTAB_CACHE_DIR) : join(HOME, ".cache", "vixtab");
export const COMMANDS = join(CACHE, "commands");
export const WINDOWS = join(CACHE, "windows");

/** kind "tickets" = a ticket window opened by VixTab (workspace file under <repo>/.vixtab/windows/). */
export type WindowInfo = { pid: number; folders: string[]; version: string; at: string; kind?: "main" | "tickets"; workspaceFile?: string | null };

/**
 * A registration whose pid started after the registration was written belongs to a window that closed without removing its
 * file (killed, crashed): Windows hands its pid to new processes quickly, and a live unrelated process (a shell, a build) would
 * otherwise pass for that window and leave every caller waiting for an answer that never comes.
 */
export function reusedPid(w: { pid: number; at?: string }, started = platform.startedAt(w.pid)): boolean {
  const at = Date.parse(w.at ?? "");
  return started > 0 && at > 0 && started > at + 60_000; // a minute of slack: a wall-clock step must not hide a live window
}

export function windows(): WindowInfo[] {
  if (!existsSync(WINDOWS)) return [];
  return readdirSync(WINDOWS)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      try {
        const w = JSON.parse(readFileSync(join(WINDOWS, f), "utf8"));
        return alive(w.pid) && !reusedPid(w) ? [w] : [];
      } catch {
        return [];
      }
    });
}

/**
 * The window to act on: VIXTAB_EXT_HOST_PID; else the window whose folder is exactly `cwd` (Claude Code only opens sessions
 * of the window's own folder) — the one we run inside if several; else the registered extension host among our ancestors;
 * else the only window.
 */
export function findWindow(cwd = process.cwd()): number {
  if (process.env.VIXTAB_EXT_HOST_PID) return Number(process.env.VIXTAB_EXT_HOST_PID);
  const ws = windows();
  if (!ws.length) fail("no VS Code window with the VixTab extension is running (install the extension, or reload the window)", 7);
  const up = new Set(platform.ancestorPids(process.pid));
  const exact = ws.filter((w) => w.folders.some((f) => samePath(f, cwd)));
  if (exact.length) return (exact.find((w) => up.has(w.pid)) ?? exact[0]).pid;
  const mine = ws.find((w) => up.has(w.pid));
  if (mine) return mine.pid;
  const byFolder = ws.filter((w) => w.folders.some((f) => isInside(cwd, f)));
  if (byFolder.length === 1) return byFolder[0].pid;
  if (ws.length === 1) return ws[0].pid;
  fail(`several VS Code windows run VixTab; set VIXTAB_EXT_HOST_PID to one of: ${ws.map((w) => `${w.pid} (${w.folders.join(", ")})`).join("; ")}`, 7);
}
export const windowInfo = (pid: number) => windows().find((w) => w.pid === pid) ?? null;

/**
 * The orchestrator's window: VIXTAB_ORCHESTRATOR_WINDOW (when the orchestrator drives VixTab from outside VS Code, e.g. over SSH
 * or Remote Control), else the registered window this process runs in (its extension host is one of our ancestors), else 0.
 * Unlike VIXTAB_EXT_HOST_PID it does not pin tabs to that window: the tabs policy still applies.
 */
let caller = 0;
export function callerWindow(): number {
  if (process.env.VIXTAB_ORCHESTRATOR_WINDOW) return Number(process.env.VIXTAB_ORCHESTRATOR_WINDOW);
  const pids = new Set(windows().map((w) => w.pid));
  if (caller && pids.has(caller)) return caller;
  return (caller = pids.size ? (platform.ancestorPids(process.pid).find((p) => pids.has(p)) ?? 0) : 0);
}

/** Default of the extension setting vixtab.maxTabsPerWindow, also for extensions up to 0.8.0 (they do not report it). */
export const MAX_TABS_DEFAULT = 6;

export type WindowTabs = { n: number; max: number; layout: Layout | null };

/** Claude tabs and the vixtab.maxTabsPerWindow setting from a window's layout answer. */
export function tabsIn(r: { layout: Layout; maxTabs?: unknown }): WindowTabs {
  const max = Number(r.maxTabs) >= 1 ? Math.floor(Number(r.maxTabs)) : MAX_TABS_DEFAULT;
  return { n: r.layout.flatMap((g) => g.tabs).filter((t) => t.claude).length, max, layout: r.layout };
}

// ── Counting tabs without asking the windows ─────────────────────────────────────────────────────────────────────────────
// A window running this extension keeps its Claude tabs in ~/.cache/vixtab/window-tabs/<pid>.json (count, labels, layout,
// its vixtab.maxTabsPerWindow), rewritten at every tab change and every 15 s: VixTab reads that instead of asking. A window
// without the file (an older extension, until the window is reloaded) is counted from its processes: every Claude tab runs a
// CLI (registry entrypoint claude-vscode) that descends from the window's extension host; its label is the one VixTab
// opened it with (tab history), else its registry name. Such a count lags a little (a closing tab's CLI can take a minute
// to exit, a tab restored after a reload may start its CLI later), which is why the window still counts its own tabs right
// before it opens one. A window does not answer when its file stopped beating, or when the last command sent to it timed
// out (since its last beat; for an older extension, within the last 10 minutes): no new tab goes there.
export const TAB_FILES = join(CACHE, "window-tabs");
export const BEAT_STALE_MS = 60_000;
const OLD_SILENT_MS = 600_000;
/** from: who counted (the window's own file, or its processes); answers: the window takes commands. n = -1 when it does not. */
export type Census = WindowTabs & { labels: string[]; from: "window" | "processes"; answers: boolean };
type Published = { pid: number; at: string; beat: number; maxTabs?: number; claude: number; labels?: string[]; layout?: Layout };

export const silentFile = () => join(CACHE, "silent-windows.json");
/** Windows whose last command timed out: since = first timeout in a row, last = latest. */
type SilentMap = Record<string, { at: string; since: number; last: number }>;
const readJsonFile = (p: string): any => {
  for (let i = 0; i < 2; i++) {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch (e: any) {
      if (e?.code === "ENOENT" || i) return null;
      Bun.sleepSync(20); // being replaced (Windows refuses to read a file while it is renamed over)
    }
  }
  return null;
};
const readSilent = (): SilentMap => readJsonFile(silentFile()) ?? {};
function noteSilence(win: number, silent: boolean): void {
  const m = readSilent();
  if (!silent && !m[win]) return;
  const at = windowInfo(win)?.at;
  if (silent && at) m[win] = { at, since: m[win]?.at === at ? m[win].since : Date.now(), last: Date.now() };
  else delete m[win];
  for (const [pid, s] of Object.entries(m)) if (!alive(Number(pid)) || Date.now() - s.last > 86_400_000) delete m[pid];
  try {
    mkdirSync(CACHE, { recursive: true });
    writeAtomic(silentFile(), JSON.stringify(m));
  } catch {} // a cache: at worst one more command times out
}

/** Live Claude tab CLIs by window (extension host pid → their labels), from one process snapshot. */
function claudeByWindow(winPids: number[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const live = registry().filter((s) => s.entrypoint === "claude-vscode" && typeof s.sessionId === "string" && alive(s.pid));
  if (!live.length || !winPids.length) return out;
  const label = new Map<string, string>();
  try {
    for (const l of readFileSync(join(CACHE, "tabs.jsonl"), "utf8").split("\n")) {
      if (!l.includes('"ev":"open"')) continue;
      try {
        const e = JSON.parse(l);
        if (e.ev === "open" && e.sessionId && e.label) label.set(e.sessionId, e.label);
      } catch {}
    }
  } catch {}
  const wins = new Set(winPids), parents = platform.parents();
  for (const s of live) {
    const win = platform.ancestorPids(s.pid, parents).find((p) => wins.has(p));
    if (win) out.set(win, [...(out.get(win) ?? []), label.get(s.sessionId) ?? s.name ?? ""]);
  }
  return out;
}

/** Every registered window's Claude tabs, without asking any window. */
export function census(ws: WindowInfo[] = windows(), now = Date.now()): Map<number, Census> {
  const out = new Map<number, Census>(), silent = readSilent(), old: WindowInfo[] = [];
  for (const w of ws) {
    const p = readJsonFile(join(TAB_FILES, `${w.pid}.json`)) as Published | null;
    if (!p || p.pid !== w.pid || p.at !== w.at) {
      old.push(w);
      continue;
    }
    const s = silent[w.pid]?.at === w.at ? silent[w.pid] : null;
    const answers = now - p.beat < BEAT_STALE_MS && !(s && s.last > p.beat);
    const max = Number(p.maxTabs) >= 1 ? Math.floor(Number(p.maxTabs)) : MAX_TABS_DEFAULT;
    out.set(w.pid, { n: answers ? p.claude : -1, max, layout: p.layout ?? null, labels: p.labels ?? [], from: "window", answers });
  }
  const byWin = claudeByWindow(old.map((w) => w.pid));
  for (const w of old) {
    const labels = byWin.get(w.pid) ?? [];
    const s = silent[w.pid]?.at === w.at ? silent[w.pid] : null;
    const answers = !(s && now - s.last < OLD_SILENT_MS);
    out.set(w.pid, { n: answers ? labels.length : -1, max: MAX_TABS_DEFAULT, layout: null, labels, from: "processes", answers });
  }
  return out;
}

let cached: { at: number; c: Map<number, Census> } | null = null;
/** census() at most maxAgeMs old: choosing a window looks at several windows in a row. */
export function censusNow(maxAgeMs = 500): Map<number, Census> {
  if (!cached || Date.now() - cached.at > maxAgeMs) cached = { at: Date.now(), c: census() };
  return cached.c;
}
/** The next censusNow() counts again (a window just said it is full). */
export const forgetCensus = () => void (cached = null);
const NO_ANSWER: Census = { n: -1, max: MAX_TABS_DEFAULT, layout: null, labels: [], from: "processes", answers: false };

/** The Claude tabs a window holds, from the census (n = -1: it does not answer, or is not registered). */
export async function windowTabs(win: number): Promise<Census> {
  return censusNow().get(win) ?? NO_ANSWER;
}

/** Claude tabs in a window (-1 = it does not answer). */
export const claudeTabCount = async (win: number) => (await windowTabs(win)).n;

/** Windows (any kind) that show a Claude tab with exactly this label, from the census: no window is asked. */
export async function windowsWithLabel(label: string): Promise<number[]> {
  return [...census()].filter(([, t]) => t.labels.includes(label)).map(([pid]) => pid);
}

export const ticketWindowTitle = (project: string, n: number) => `[${project}] VixTab tickets ${n} — \${activeEditorShort}`;

/**
 * Open a new ticket window on `repo`: VS Code window from a workspace file under <repo>/.vixtab/windows/ (kept out of git through
 * .git/info/exclude). The file must live inside the trusted repository — a workspace file elsewhere opens in Restricted Mode, where
 * Claude Code and VixTab do not run. A new file each time: `code -n` on a workspace that is already open only focuses it.
 */
export async function openTicketWindow(repo: string, waitMs = 60_000): Promise<number> {
  const before = new Set(windows().map((w) => w.pid));
  const dir = join(repo, ".vixtab", "windows");
  mkdirSync(dir, { recursive: true });
  const exclude = join(repo, ".git", "info", "exclude");
  try {
    const cur = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!cur.split(/\r?\n/).includes("/.vixtab/")) writeFileSync(exclude, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + "/.vixtab/\n");
  } catch {}
  // The project's name leads the title, in brackets, so a ticket window says which project opened it: "[my-app] VixTab tickets 2".
  const project = basename(repo);
  let n = 1;
  while (existsSync(join(dir, `${project}-tickets-${n}.code-workspace`)) || existsSync(join(dir, `tickets-${n}.code-workspace`))) n++;
  const file = join(dir, `${project}-tickets-${n}.code-workspace`);
  writeFileSync(file, JSON.stringify({ folders: [{ path: "../..", name: project }], settings: { "window.title": ticketWindowTitle(project, n) } }, null, 2) + "\n");
  const code = Bun.which("code") ?? fail("the `code` command is not on PATH (VS Code: Shell Command: Install 'code' command)", 7);
  const r = run(IS_WIN ? ["cmd.exe", "/d", "/c", code, "-n", file] : [code, "-n", file]);
  if (r.code !== 0) fail(`code -n failed: ${(r.err || r.out).trim()}`, 7);
  for (const t = Date.now(); Date.now() - t < waitMs; await sleep(500)) {
    const w = windows().find((x) => !before.has(x.pid) && x.folders.some((f) => samePath(f, repo)));
    if (w) return w.pid;
  }
  fail(`the new ticket window (${file}) did not register within ${waitMs / 1000} s (a trust prompt in VS Code? the screen locked?)`, 7);
}

/** Wait until a window with exactly this folder registers (after `code -n <folder>`). */
export async function waitForWindow(folder: string, ms = 45_000): Promise<number | null> {
  for (const t = Date.now(); Date.now() - t < ms; await sleep(500)) {
    const w = windows().find((x) => x.folders.some((f) => samePath(f, folder)));
    if (w) return w.pid;
  }
  return null;
}

export async function send(action: string, args: Record<string, unknown> = {}, timeoutMs = 60_000, win = findWindow()): Promise<any> {
  mkdirSync(COMMANDS, { recursive: true });
  // Results that arrived after their caller gave up.
  for (const f of readdirSync(COMMANDS)) {
    try {
      if (f.endsWith(".result.json") && Date.now() - statSync(join(COMMANDS, f)).mtimeMs > 600_000) rmSync(join(COMMANDS, f), { force: true });
    } catch {}
  }
  const id = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const cmd = join(COMMANDS, `${win}-${id}.cmd.json`), result = join(COMMANDS, `${win}-${id}.result.json`);
  writeFileSync(`${cmd}.tmp`, JSON.stringify({ action, ...args }));
  renameSync(`${cmd}.tmp`, cmd);
  for (const start = Date.now(); Date.now() - start < timeoutMs; await sleep(100)) {
    if (existsSync(result)) {
      const r = JSON.parse(readFileSync(result, "utf8"));
      rmSync(result, { force: true });
      noteSilence(win, false);
      if (!r.ok) fail(`VixTab extension: ${r.error}`, 4);
      return r;
    }
  }
  rmSync(cmd, { force: true });
  noteSilence(win, true);
  fail(`timeout: the VixTab extension in window ${win} did not answer (is it installed and enabled there?)`, 4);
}

export type Layout = { column: number; active: boolean; tabs: { label: string; claude: boolean; active: boolean }[] }[];
export const layout = async (win?: number): Promise<Layout> => (await send("layout", {}, 60_000, win)).layout;
