// File-command bridge to the VixTab VS Code extension. The extension registers its window in ~/.cache/vixtab/windows/<pid>.json
// (pid = its extension host) and executes commands written to ~/.cache/vixtab/commands/<pid>-<id>.cmd.json, answering in
// <pid>-<id>.result.json. Only the window whose pid is in the file name acts, so tabs open in the window you are working in.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { platform } from "../platform/index.ts";
import { alive, ancestors } from "./proc.ts";
import { HOME, fail, isInside, pathKey, sleep } from "./util.ts";

export const CACHE = join(HOME, ".cache", "vixtab");
export const COMMANDS = join(CACHE, "commands");
export const WINDOWS = join(CACHE, "windows");

export type WindowInfo = { pid: number; folders: string[]; version: string; at: string };

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
