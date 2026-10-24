// Running external programs (git, the Claude CLI, test commands).
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { IS_WIN, VixError } from "./util.ts";

export type RunResult = { code: number; out: string; err: string };

/** Run and wait, capturing output (nothing is printed). */
export function run(cmd: string[], cwd?: string, env?: Record<string, string | undefined>): RunResult {
  try {
    const r = Bun.spawnSync(cmd, { cwd, env: env ?? process.env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    return { code: r.exitCode ?? 1, out: r.stdout.toString(), err: r.stderr.toString() };
  } catch (e) {
    return { code: 127, out: "", err: String((e as Error).message ?? e) };
  }
}

/** Run with the terminal attached; returns the exit code. */
export async function runInherit(cmd: string[], cwd?: string, env?: Record<string, string | undefined>): Promise<number> {
  const p = Bun.spawn(cmd, { cwd, env: env ?? process.env, stdio: ["inherit", "inherit", "inherit"] });
  return await p.exited;
}

/**
 * Git Bash on Windows (next to git.exe). NOT whatever "bash" is on PATH: C:\Windows\System32\bash.exe is the WSL launcher and
 * would run the command inside Linux, where Windows paths do not exist.
 */
export function gitBash(): string | null {
  const git = Bun.which("git");
  const roots = [git ? dirname(dirname(git)) : "", process.env.ProgramFiles ? join(process.env.ProgramFiles, "Git") : "", "C:/Program Files/Git"];
  for (const r of roots) if (r && existsSync(join(r, "bin", "bash.exe"))) return join(r, "bin", "bash.exe");
  return null;
}

const posixBash = () => (existsSync("/bin/bash") ? "/bin/bash" : Bun.which("bash"));

/**
 * A shell command line from the config ("bun test", "npm run check && npm test"), always with pipefail: without it
 * `bun test | tail -3` exits with tail's code and red tests would be pushed. (Ubuntu's sh is dash, which has no pipefail.)
 */
export function shellCommand(line: string): string[] {
  const bash = IS_WIN ? gitBash() : posixBash();
  if (bash) return [bash, "-o", "pipefail", "-c", line];
  return IS_WIN ? ["cmd.exe", "/d", "/s", "/c", line] : ["sh", "-c", line];
}

/** A test command given after `--`: `bash -c '…'` / `sh -c '…'` get pipefail too (sh becomes bash where sh lacks it). */
export function withPipefail(cmd: string[]): string[] {
  const m = /^(.*[\\/])?(bash|sh)(\.exe)?$/i.exec(cmd[0] ?? "");
  if (!m || cmd[1] !== "-c") return cmd;
  const shell = m[2].toLowerCase() === "sh" && !IS_WIN ? posixBash() : cmd[0];
  return shell ? [shell, "-o", "pipefail", ...cmd.slice(1)] : cmd;
}

export const git = (cwd: string, ...args: string[]) => run(["git", ...args], cwd);
/** git, and throw with git's own message when it fails. */
export function gitOk(cwd: string, ...args: string[]): string {
  const r = git(cwd, ...args);
  if (r.code !== 0) throw new VixError(`git ${args.join(" ")} (in ${cwd}) failed:\n${(r.err || r.out).trim()}`);
  return r.out;
}
