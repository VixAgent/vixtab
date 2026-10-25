// Where the board lives, and every read and write of it.
//  - private board: a local git repository at <home>/board, outside the project and never pushed. It holds README.md (the
//    table), TEMPLATE.md, the ticket files and whatever the orchestrator keeps there (HANDOVER.md). Its history is the audit log.
//  - legacy board: a <board> folder on <remote>/<branch>, published with the code (boards created by `vixtab init --push`).
//    Read and written there as before, with a warning, until `vixtab board migrate` moves it into the private board.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Row, boardReadme, parseRows, setRowStatus, setTicketStatus, ticketBodyTemplate } from "./board.ts";
import { type Config, mainRef } from "./config.ts";
import { commitOnMain, fetchMain, locksOf } from "./mainline.ts";
import { git, gitOk } from "./run.ts";
import { fail, native } from "./util.ts";

export const boardDir = (c: Config) => `${c.home}/board`;

export type BoardKind = "private" | "legacy" | "none";
/** private: <home>/board exists · legacy: no private board, but <board>/README.md on <remote>/<branch> · none: neither. */
export function boardKind(c: Config): BoardKind {
  if (existsSync(boardDir(c))) return "private";
  return git(c.repo, "cat-file", "-e", `${mainRef(c)}:${c.board}/README.md`).code === 0 ? "legacy" : "none";
}
export const legacyNotice = (c: Config) => `this board is on ${mainRef(c)}, published with your code: vixtab board migrate moves it into the private board`;

let noticed = false;
/** A legacy board? The first call of a command prints the notice on stderr; `quiet`: the caller shows it itself. */
export function isLegacy(c: Config, quiet = false): boolean {
  const legacy = boardKind(c) === "legacy";
  if (legacy && !noticed) {
    noticed = true;
    if (!quiet) console.error(`Warning: ${legacyNotice(c)}`);
  }
  return legacy;
}

/** Where the board is, for messages. */
export const boardWhere = (c: Config) => (isLegacy(c) ? mainRef(c) : native(boardDir(c)));

/** Before reading the board: a legacy one is read from <remote>/<branch>, so fetch it. The private board needs nothing. */
export function syncBoard(c: Config): void {
  if (!existsSync(boardDir(c))) fetchMain(c);
}

/** A filter for changed files: drops the legacy board folder (board edits are not code). A private board is not in the repo. */
export function codeOnly(c: Config): (f: string) => boolean {
  const prefix = isLegacy(c) ? `${c.board}/` : null;
  return (f) => !!f && !(prefix && f.startsWith(prefix));
}

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
function showMain(c: Config, path: string): string | null {
  const r = git(c.repo, "show", `${mainRef(c)}:${path}`);
  return r.code === 0 ? r.out : null;
}

/** A board file (README.md, a ticket file…), path relative to the board; null when it does not exist. */
export function readBoardFile(c: Config, path: string): string | null {
  if (isLegacy(c)) return showMain(c, `${c.board}/${path}`);
  try {
    return readFileSync(join(boardDir(c), path), "utf8");
  } catch {
    return null;
  }
}
export function boardFiles(c: Config): string[] {
  if (isLegacy(c)) {
    const r = git(c.repo, "ls-tree", "--name-only", `${mainRef(c)}:${c.board}`);
    return r.code === 0 ? r.out.split("\n").filter(Boolean) : [];
  }
  return existsSync(boardDir(c)) ? readdirSync(boardDir(c)).filter((n) => n !== ".git") : [];
}
const ticketName = (files: string[], id: string) => files.find((n) => (n.startsWith(`${id}-`) || n === `${id}.md`) && n.endsWith(".md")) ?? null;
/** The name of a ticket's file on the board (T-001-slug.md), or null. */
export const ticketFileName = (c: Config, id: string) => ticketName(boardFiles(c), id);

export function readBoard(c: Config): { readme: string; rows: Row[] } {
  const readme = readBoardFile(c, "README.md");
  if (readme === null) fail(`no board: ${native(boardDir(c))} is missing (run: vixtab init)`, 2);
  return { readme, rows: parseRows(c, readme) };
}
export function ticketOnBoard(c: Config, id: string): { file: string; text: string } | null {
  const file = ticketFileName(c, id);
  const text = file ? readBoardFile(c, file) : null;
  return file && text !== null ? { file, text } : null;
}

/** The ticket file a session edits (its ## Answer): on the private board, or (legacy) inside the ticket's worktree W. */
export function ticketFile(c: Config, id: string, W: string): string | null {
  if (isLegacy(c)) return ticketFileIn(c, W, id);
  const f = ticketFileName(c, id);
  return f ? `${boardDir(c)}/${f}` : null;
}

// ── Writing ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The user's git identity, or VixTab's own where none is set: board commits must not fail on a fresh machine. */
function identity(dir: string): string[] {
  const set = (k: string) => git(dir, "config", k).out.trim() !== "";
  return [...(set("user.name") ? [] : ["-c", "user.name=VixTab"]), ...(set("user.email") ? [] : ["-c", "user.email=vixtab@localhost"])];
}
/** Commit exactly `paths` (as they are on disk) in the board repository; null when they did not change. */
function commitPaths(dir: string, message: string, paths: string[]): string | null {
  gitOk(dir, "add", "--", ...paths);
  if (git(dir, "diff", "--cached", "--quiet", "--", ...paths).code === 0) return null;
  gitOk(dir, ...identity(dir), "commit", "-q", "-m", message, "--", ...paths);
  return gitOk(dir, "rev-parse", "HEAD").trim();
}

/**
 * Edit board files and commit them, under the "board" lock. Same contract as commitOnMain, with paths relative to the board:
 * `edit` receives a reader and returns the new contents of the files it changes (path → text), or null to do nothing. The
 * private board is local (no fetch, no push, no retry); a legacy board goes through commitOnMain.
 */
export async function commitOnBoard(
  c: Config,
  message: string,
  edit: (read: (path: string) => string | null) => Record<string, string> | null,
): Promise<string | null> {
  if (isLegacy(c))
    return commitOnMain(c, message, (read) => {
      const files = edit((p) => read(`${c.board}/${p}`));
      return files && Object.fromEntries(Object.entries(files).map(([p, t]) => [`${c.board}/${p}`, t]));
    });
  const dir = boardDir(c);
  const release = await locksOf(c).take("board", Infinity, message.slice(0, 80));
  try {
    if (!existsSync(join(dir, ".git"))) fail(`no board: ${native(dir)} is not a git repository (run: vixtab init)`, 2);
    // Read from disk, not from HEAD: a session's Answer that done has not committed yet is kept.
    const files = edit((p) => readBoardFile(c, p));
    if (!files || !Object.keys(files).length) return null;
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), text);
    }
    return commitPaths(dir, message, Object.keys(files));
  } finally {
    release();
  }
}

/** Create the private board: git init, README.md, TEMPLATE.md (+ `extra` files, which win), first commit. False when it exists. */
export function createBoard(c: Config, extra: Record<string, string | Uint8Array> = {}, message = "vixtab: create the board"): boolean {
  const dir = boardDir(c);
  if (existsSync(join(dir, ".git"))) return false;
  mkdirSync(dir, { recursive: true });
  gitOk(dir, "init", "-q");
  gitOk(dir, "config", "core.autocrlf", "false");
  const files = { "README.md": boardReadme(c), "TEMPLATE.md": ticketBodyTemplate(), ...extra };
  for (const [p, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), data);
  }
  commitPaths(dir, message, Object.keys(files));
  return true;
}

// ── Legacy boards: the ticket file inside a worktree, status cells written there after the rebase ─────────────────────────
/** Ticket file inside a checkout or worktree W. */
export function ticketFileIn(c: Config, W: string, id: string): string | null {
  const d = join(W, c.board);
  if (!existsSync(d)) return null;
  const f = ticketName(readdirSync(d), id);
  return f ? join(d, f) : null;
}

/** Write DOING/DONE… into README + ticket inside worktree W; returns repo-relative paths to stage. */
export function writeStatusIn(c: Config, W: string, id: string, cell: string, ticketLine: string): string[] {
  const readme = join(W, c.board, "README.md");
  const changed: string[] = [];
  if (existsSync(readme)) {
    const next = setRowStatus(c, readFileSync(readme, "utf8"), id, cell);
    if (next !== null) {
      writeFileSync(readme, next);
      changed.push(`${c.board}/README.md`);
    } else console.log(`  (no row for ${id} in ${c.board}/README.md — skipped)`);
  }
  const t = ticketFileIn(c, W, id);
  if (t) {
    writeFileSync(t, setTicketStatus(readFileSync(t, "utf8"), ticketLine));
    changed.push(`${c.board}/${t.split(/[\\/]/).pop()}`);
  }
  return changed;
}
