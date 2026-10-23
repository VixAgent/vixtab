// Processes: liveness, ancestry, "which processes belong to this folder", and stopping them safely.
import { platform, type Proc } from "../platform/index.ts";
import { IS_WIN, isInside, longPath, native, pathKey, sleep } from "./util.ts";

/** Alive? (EPERM = exists but we may not signal it ⇒ alive.) */
export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

/** Ancestor chain of pid, nearest first. A "parent" started after its child is a reused Windows pid and ends the chain. */
export function ancestors(pid: number, list: Proc[]): number[] {
  const byPid = new Map(list.map((p) => [p.pid, p]));
  const out: number[] = [];
  let p = byPid.get(pid);
  while (p && out.length < 64) {
    const parent = byPid.get(p.ppid);
    if (!parent || parent.pid === p.pid || (parent.started && p.started && parent.started > p.started) || out.includes(parent.pid)) break;
    out.push(parent.pid);
    p = parent;
  }
  return out;
}

// Never stopped, whatever their folder: Claude sessions, VS Code, ssh, the desktop shell and session managers.
const PROTECTED_NAMES = /^(claude(\.exe)?|code(\.exe)?|code-.*|cursor(\.exe)?|sshd(\.exe|-session(\.exe)?)?|explorer\.exe|conhost\.exe|csrss\.exe|winlogon\.exe|services\.exe|svchost\.exe|systemd|tmux.*|screen|SCREEN)$/i;
export const isProtected = (p: Proc) => PROTECTED_NAMES.test(p.name) || /\.vscode-server|Microsoft VS Code|[\\/]resources[\\/]app[\\/]out[\\/]/i.test(p.cmdline);

/**
 * Processes that belong to folder `dir`: working directory inside it, or a path inside it on the command line — plus all of
 * their descendants. Excludes this process, its ancestors, its own children, and protected processes.
 */
export function processesInside(dir: string, list = platform.processes()): Proc[] {
  const me = process.pid, mine = new Set([me, ...ancestors(me, list)]);
  const forms = [...new Set([dir, longPath(dir)])];
  const keys = forms.flatMap((d) => [pathKey(d) + "/", pathKey(d).replace(/\//g, "\\") + "\\"]);
  const inside = (cwd: string) => forms.some((d) => isInside(longPath(cwd), d) || isInside(cwd, d));
  const hits = new Set<number>();
  for (const p of list) {
    if (mine.has(p.pid) || isProtected(p)) continue;
    const cmd = IS_WIN ? p.cmdline.toLowerCase() : p.cmdline;
    if ((p.cwd && inside(p.cwd)) || keys.some((k) => cmd.includes(k)) || forms.some((d) => pathKey(p.cmdline).endsWith(pathKey(d)))) hits.add(p.pid);
  }
  const out = new Map<number, Proc>();
  for (const p of list) {
    if (mine.has(p.pid) || isProtected(p)) continue;
    const up = ancestors(p.pid, list);
    if (up.includes(me)) continue;
    if (hits.has(p.pid) || up.some((a) => hits.has(a))) out.set(p.pid, p);
  }
  return [...out.values()];
}

export function printProcesses(list: Proc[]): void {
  for (const p of list) console.log(`    ${String(p.pid).padEnd(7)} ${(p.name || "").padEnd(16)} ${native(p.cwd ?? "?").slice(0, 60).padEnd(60)} ${p.cmdline.slice(0, 110)}`);
}

/** Stop pids. Linux: SIGTERM, 5 s, SIGKILL. Windows: TerminateProcess (console programs have no SIGTERM). */
export async function stopPids(pids: number[]): Promise<boolean> {
  if (!pids.length) return true;
  for (const p of pids) {
    try {
      process.kill(p, IS_WIN ? "SIGKILL" : "SIGTERM");
    } catch {}
  }
  for (let i = 0; i < 50 && pids.some(alive); i++) await sleep(100);
  const left = pids.filter(alive);
  if (left.length) {
    console.log(`  SIGKILL (still running after 5 s): ${left.join(" ")}`);
    for (const p of left) {
      try {
        process.kill(p, "SIGKILL");
      } catch {}
    }
    await sleep(300);
  }
  const still = pids.filter(alive);
  if (still.length) {
    console.error(`  STILL RUNNING: ${still.join(" ")}`);
    return false;
  }
  console.log(`  Stopped ${pids.length} process(es).`);
  return true;
}
