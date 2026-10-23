// vixtab procs list|kill <dir> · vixtab procs orphans [--kill]
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { has, parseArgs } from "../core/args.ts";
import { idPattern, loadConfig } from "../core/config.ts";
import { ancestors, isProtected, printProcesses, processesInside, stopPids } from "../core/proc.ts";
import { escapeRe, fail, isInside, native, norm, pathKey } from "../core/util.ts";
import { platform } from "../platform/index.ts";
import { isDone, readClaim } from "./ticket.ts";

export const HELP = `vixtab procs — processes left behind by ticket sessions (dev servers, browsers, test runners)

  procs list <dir>          processes whose working directory or command line is inside <dir> (+ their children)
  procs kill <dir>          stop them (never Claude, VS Code, sshd or the desktop shell)
  procs orphans [--kill]    processes inside worktrees of tickets that are done or released (Linux: also deleted folders)
`;

export async function procs(argv: string[]): Promise<void> {
  const [action, ...rest] = argv;
  const a = parseArgs(rest);
  if (action === "list" || action === "kill") {
    const dir = a._[0];
    if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) fail(`usage: vixtab procs ${action} <dir>`, 2);
    const ps = processesInside(norm(dir));
    if (!ps.length) return void console.log(`No process runs inside ${native(dir)}.`);
    console.log(`${ps.length} process(es) inside ${native(dir)}:`);
    printProcesses(ps);
    if (action === "kill" && !(await stopPids(ps.map((p) => p.pid)))) process.exitCode = 1;
    return;
  }
  if (action === "orphans") {
    const c = loadConfig();
    const list = platform.processes(), mine = new Set([process.pid, ...ancestors(process.pid, list)]);
    const re = new RegExp(`${escapeRe(pathKey(c.home))}/wt-(${idPattern(c)})(?=[/\\s"']|$)[^\\s"']*`, "i");
    const tdir = join(c.locks, "tickets");
    const known = new Map((existsSync(tdir) ? readdirSync(tdir) : []).map((x) => [x.toLowerCase(), x]));
    const found: { pid: number; why: string; where: string; cmd: string }[] = [];
    for (const p of list) {
      if (mine.has(p.pid) || isProtected(p)) continue;
      const fromCwd = p.cwd && isInside(p.cwd, c.home) ? norm(p.cwd) : null;
      const where = (fromCwd && re.test(pathKey(fromCwd)) ? fromCwd : null) ?? re.exec(norm(p.cmdline))?.[0] ?? fromCwd;
      if (!where) continue;
      const raw = re.exec(pathKey(where))?.[1];
      const id = raw ? (known.get(raw.toLowerCase()) ?? raw) : undefined;
      let why = "";
      if (fromCwd === where && !existsSync(where)) why = "folder deleted";
      else if (id && !readClaim(c, id)) why = `${id} released`;
      else if (id && isDone(c, id)) why = `${id} done`;
      if (why) found.push({ pid: p.pid, why, where, cmd: p.cmdline });
    }
    if (!found.length) return void console.log("No orphan processes.");
    for (const x of found) console.log(`${String(x.pid).padEnd(8)} ${x.why.padEnd(20)} ${native(x.where)} · ${x.cmd.slice(0, 110)}`);
    if (has(a, "kill")) {
      if (!(await stopPids(found.map((x) => x.pid)))) process.exitCode = 1;
    } else console.log(`${found.length} orphan process(es) — stop them with: vixtab procs orphans --kill`);
    return;
  }
  console.log(HELP);
  if (action && action !== "help") process.exitCode = 2;
}
