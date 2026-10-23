// vixtab.config.json (optional, at the repo root) + defaults + VIXTAB_* environment overrides.
import { existsSync, readFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { git } from "./run.ts";
import { fail, norm, parseSizeMB } from "./util.ts";

export type Config = {
  /** Main checkout (worktrees share its .git). */
  repo: string;
  configFile: string | null;
  /** Folder with the board (README.md table) and the ticket files, relative to the repo root. */
  board: string;
  prefix: string;
  digits: number;
  remote: string;
  branch: string;
  /** Where VixTab keeps ticket worktrees, locks and logs (outside the repo). */
  home: string;
  locks: string;
  ports: { base: number };
  /** Extra lines for each ticket's .vixtab.env; values may use {port} {n} {ticket} {worktree}. */
  env: Record<string, string>;
  /** Printed after claim (e.g. "bun install"). */
  setup: string;
  /** Default test command for `ticket merge` when none is given after `--`. */
  test: string;
  /** Files that many tickets touch: overlap there is expected, rebase carefully instead of queueing. */
  hotFiles: string[];
  sessions: { max: number; minFreeRamMB: number; maxSwapMB: number; maxCommit: number; maxCpu: number; reserveMB: number };
  heavy: { slots: number; memMB: number; headroomMB: number; maxCpu: number; maxCommit: number };
};

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** The main checkout that contains `cwd` (also when `cwd` is inside a linked worktree). */
export function findRepo(cwd = process.cwd()): string {
  if (process.env.VIXTAB_REPO) return norm(resolve(process.env.VIXTAB_REPO));
  const r = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (r.code !== 0) fail(`not inside a git repository: ${cwd}\n(run vixtab from your project, or set VIXTAB_REPO)`, 2);
  const common = norm(r.out.trim());
  if (basename(common) !== ".git") fail(`${common} is a bare repository; run vixtab from a normal checkout`, 2);
  return norm(dirname(common));
}

export function loadConfig(cwd = process.cwd()): Config {
  const repo = findRepo(cwd);
  const file = join(repo, "vixtab.config.json");
  let raw: any = {};
  let configFile: string | null = null;
  const parse = (text: string, where: string) => {
    try {
      return JSON.parse(text);
    } catch (e) {
      fail(`${where}: invalid JSON (${(e as Error).message})`, 2);
    }
  };
  if (existsSync(file)) {
    raw = parse(readFileSync(file, "utf8"), file);
    configFile = norm(file);
  }
  const env = process.env;
  const totalMB = Math.round(totalmem() / 1048576);
  const s = raw.sessions ?? {}, h = raw.heavy ?? {};
  const remote = raw.remote ?? "origin";
  const homeRaw = env.VIXTAB_HOME ?? raw.home;
  const home = norm(homeRaw ? (isAbsolute(homeRaw) ? homeRaw : resolve(repo, homeRaw)) : join(dirname(repo), `${basename(repo)}.vixtab`));
  const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : d);
  return {
    repo,
    configFile,
    board: norm(raw.board ?? "tickets"),
    prefix: raw.ticketPrefix ?? "T-",
    digits: raw.ticketDigits ?? 3,
    remote,
    branch: raw.branch ?? "main",
    home,
    locks: norm(env.VIXTAB_LOCKS ?? join(home, "locks")),
    ports: { base: raw.ports?.base ?? 4000 },
    env: raw.env ?? {},
    setup: raw.setup ?? "",
    test: raw.test ?? "",
    hotFiles: raw.hotFiles ?? [],
    sessions: {
      // 0 = no fixed cap: the resource gate decides how many sessions run.
      max: num(env.VIXTAB_MAX_SESSIONS, s.max ?? 0),
      minFreeRamMB: num(env.VIXTAB_MIN_FREE_RAM_MB, s.minFreeRamMB ?? clamp(Math.round(totalMB / 8), 4096, 16384)),
      maxSwapMB: num(env.VIXTAB_MAX_SWAP_MB, s.maxSwapMB ?? clamp(Math.round(totalMB / 4), 4096, 16384)),
      maxCommit: num(env.VIXTAB_MAX_COMMIT, s.maxCommit ?? 0.85),
      maxCpu: num(env.VIXTAB_MAX_CPU, s.maxCpu ?? 0.85),
      // RAM a just-opened session will soon use (it has not grown yet when the next gate check runs).
      reserveMB: num(env.VIXTAB_SESSION_RESERVE_MB, s.reserveMB ?? 1024),
    },
    heavy: {
      slots: num(env.VIXTAB_HEAVY_SLOTS, h.slots ?? Math.max(2, Math.floor(cpus().length / 4))),
      memMB: parseSizeMB(env.VIXTAB_HEAVY_MEM ?? h.mem, 6144),
      headroomMB: num(env.VIXTAB_HEAVY_HEADROOM_MB, h.headroomMB ?? 4096),
      maxCpu: num(env.VIXTAB_MAX_CPU, h.maxCpu ?? 0.85),
      maxCommit: num(env.VIXTAB_MAX_COMMIT, h.maxCommit ?? 0.85),
    },
  };
}

/** Ticket ids look like T-001 (prefix + at least `digits` digits). */
export const idPattern = (c: Config) => `${c.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d{${c.digits},}`;
export const isId = (c: Config, s: string | undefined) => !!s && new RegExp(`^${idPattern(c)}$`).test(s);
export function requireId(c: Config, s: string | undefined): string {
  if (!isId(c, s)) fail(`ticket id must look like ${c.prefix}${"0".repeat(c.digits - 1)}1, got '${s ?? ""}'`, 2);
  return s!;
}
export const idNumber = (c: Config, id: string) => Number(id.slice(c.prefix.length));
export const formatId = (c: Config, n: number) => `${c.prefix}${String(n).padStart(c.digits, "0")}`;
export const worktreeOf = (c: Config, id: string) => `${c.home}/wt-${id}`;
export const branchOf = (id: string) => `vixtab/${id}`;
export const mainRef = (c: Config) => `${c.remote}/${c.branch}`;
