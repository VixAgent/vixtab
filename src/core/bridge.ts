// File-command bridge to the VixTab VS Code extension. The extension registers its window in ~/.cache/vixtab/windows/<pid>.json
// (pid = its extension host) and executes commands written to ~/.cache/vixtab/commands/<pid>-<id>.cmd.json, answering in
// <pid>-<id>.result.json. Only the window whose pid is in the file name acts, so tabs open in the window you are working in.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { platform } from "../platform/index.ts";
import { alive, ancestors } from "./proc.ts";
import { run } from "./run.ts";
import { HOME, IS_WIN, fail, isInside, norm, pathKey, sleep } from "./util.ts";

/** The extension's Marketplace ID. Up to 0.6.0 it was LEGACY_EXTENSION_ID; setup and the extension itself remove that one. */
export const EXTENSION_ID = "vixagent.vixtab";
export const LEGACY_EXTENSION_ID = "phanthaitrung.vixtab";

/** VIXTAB_CACHE_DIR is for tests (fixture folders): the extension always uses ~/.cache/vixtab. */
export const CACHE = process.env.VIXTAB_CACHE_DIR ? norm(process.env.VIXTAB_CACHE_DIR) : join(HOME, ".cache", "vixtab");
export const COMMANDS = join(CACHE, "commands");
export const WINDOWS = join(CACHE, "windows");

/** kind "tickets" = a ticket window opened by VixTab (workspace file under <repo>/.vixtab/windows/). */
export type WindowInfo = { pid: number; folders: string[]; version: string; at: string; kind?: "main" | "tickets"; workspaceFile?: string | null };

export function windows(): WindowInfo[] {
  if (!existsSync(WINDOWS)) return [];
  return readdirSync(WINDOWS)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      try {
        const w = JSON.parse(readFileSync(join(WINDOWS, f), "utf8"));
        return alive(w.pid) ? [w] : [];
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
  const up = new Set(ancestors(process.pid, platform.processes()));
  const exact = ws.filter((w) => w.folders.some((f) => pathKey(f) === pathKey(cwd)));
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
export function callerWindow(): number {
  if (process.env.VIXTAB_ORCHESTRATOR_WINDOW) return Number(process.env.VIXTAB_ORCHESTRATOR_WINDOW);
  const pids = new Set(windows().map((w) => w.pid));
  return pids.size ? (ancestors(process.pid, platform.processes()).find((p) => pids.has(p)) ?? 0) : 0;
}

/** Claude tabs in a window (-1 = the window did not answer). */
export async function claudeTabCount(win: number): Promise<number> {
  try {
    return (await layout(win)).flatMap((g) => g.tabs).filter((t) => t.claude).length;
  } catch {
    return -1;
  }
}

/** Windows (any kind) that show a Claude tab with exactly this label. */
export async function windowsWithLabel(label: string): Promise<number[]> {
  const out: number[] = [];
  for (const w of windows()) {
    try {
      if ((await layout(w.pid)).some((g) => g.tabs.some((t) => t.claude && t.label === label))) out.push(w.pid);
    } catch {}
  }
  return out;
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
    const w = windows().find((x) => !before.has(x.pid) && x.folders.some((f) => pathKey(f) === pathKey(repo)));
    if (w) return w.pid;
  }
  fail(`the new ticket window (${file}) did not register within ${waitMs / 1000} s (a trust prompt in VS Code? the screen locked?)`, 7);
}

/** Wait until a window with exactly this folder registers (after `code -n <folder>`). */
export async function waitForWindow(folder: string, ms = 45_000): Promise<number | null> {
  for (const t = Date.now(); Date.now() - t < ms; await sleep(500)) {
    const w = windows().find((x) => x.folders.some((f) => pathKey(f) === pathKey(folder)));
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
      if (!r.ok) fail(`VixTab extension: ${r.error}`, 4);
      return r;
    }
  }
  rmSync(cmd, { force: true });
  fail(`timeout: the VixTab extension in window ${win} did not answer (is it installed and enabled there?)`, 4);
}

export type Layout = { column: number; active: boolean; tabs: { label: string; claude: boolean; active: boolean }[] }[];
export const layout = async (win?: number): Promise<Layout> => (await send("layout", {}, 60_000, win)).layout;
