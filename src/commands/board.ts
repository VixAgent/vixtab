// vixtab board path | write | migrate — the private board (<home>/board), and moving a board made by older versions into it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type Args, has, parseArgs, str } from "../core/args.ts";
import { parseRows, withCurrentProtocol } from "../core/board.ts";
import { boardDir, boardKind, boardWhere, commitOnBoard, createBoard, isLegacy, syncBoard } from "../core/boardstore.ts";
import { type Config, defaultHome, idPattern, loadConfig, mainRef } from "../core/config.ts";
import { commitOnMainHeld, locksOf } from "../core/mainline.ts";
import { git, gitOk } from "../core/run.ts";
import { fail, native } from "../core/util.ts";
import { activeTickets } from "./ticket.ts";

export const HELP = `vixtab board — the private ticket board

The board is a local git repository in <home>/board, outside the project and never pushed. Its history is the audit log.

  board path                                   print the board folder
  board write <name> --file F                  write one extra file (HANDOVER.md, notes…) on the board and commit it
                                               (--file - reads stdin); README.md and ticket files belong to vixtab ticket
  board migrate [--dry-run] [--keep-on-main] [--force]
                                               move a board made by older versions (<board>/ and vixtab.config.json on
                                               <remote>/<branch>) into the private board, then remove both from <branch>
                                               in one commit. Refused while a ticket is ⏳ DOING or ❓ ASK (--force
                                               migrates anyway). --keep-on-main leaves the old copy on <branch>.
                                               --dry-run lists what would happen and changes nothing. The files stay in
                                               the remote's git history: rewriting it is your own decision.
`;

const CONFIG = "vixtab.config.json";
const MOVE_MESSAGE = "Move the VixTab board out of the repository";

export async function board(argv: string[]): Promise<void> {
  const [action, ...rest] = argv;
  const a = parseArgs(rest, ["file"]);
  const c = loadConfig();
  switch (action) {
    case "path":
      if (!isLegacy(c) && boardKind(c) === "none") console.error("Note: the board does not exist yet (vixtab init creates it).");
      console.log(native(boardDir(c)));
      return;

    case "write": {
      const name = (a._[0] ?? "").replace(/\\/g, "/");
      const file = str(a, "file");
      if (!name || !file) fail("usage: vixtab board write <name> --file <file>   (--file - reads stdin)", 2);
      const parts = name.split("/");
      if (isAbsolute(name) || /^[a-z]:/i.test(name) || parts.some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git"))
        fail(`board write: '${name}' must be a relative path inside the board`, 2);
      if (/^readme\.md$/i.test(name) || new RegExp(`^${idPattern(c)}[-.]`).test(name))
        fail(`board write: ${name} belongs to the vixtab ticket commands (README.md holds the table, ${c.prefix}… files are tickets)`, 2);
      const text = readFileSync(file === "-" ? 0 : file, "utf8");
      syncBoard(c);
      const sha = await commitOnBoard(c, `tickets: write ${name}`, () => ({ [name]: text }));
      console.log(sha ? `Wrote ${name} on the board (${boardWhere(c)}).` : `${name} is unchanged on the board.`);
      return;
    }

    case "migrate":
      return migrate(c, a);

    default:
      console.log(HELP);
      if (action && action !== "help") process.exitCode = 2;
  }
}

// ── Migration ───────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Files under `dir` at commit `rev` (repo-relative), unquoted. */
const lsTree = (c: Config, rev: string, dir: string) =>
  gitOk(c.repo, "ls-tree", "-r", "-z", "--name-only", rev, "--", dir).split("\0").filter(Boolean);
/** The tree id of `dir` at `rev`, "" when it is missing there. */
const treeOf = (c: Config, rev: string, dir: string) => git(c.repo, "rev-parse", "-q", "--verify", `${rev}:${dir}`).out.trim();
/** A file's bytes at `rev` (ticket files are text, but a board may hold anything). */
function blob(c: Config, rev: string, path: string): Uint8Array {
  const r = Bun.spawnSync(["git", "cat-file", "blob", `${rev}:${path}`], { cwd: c.repo });
  if (r.exitCode !== 0) fail(`git cat-file failed for ${rev}:${path}:\n${r.stderr.toString().trim()}`);
  return r.stdout;
}
/** The commit an earlier migration imported the private board from (its first commit says so), or null. */
function importedFrom(c: Config): string | null {
  for (const s of git(boardDir(c), "log", "--format=%s").out.split("\n")) {
    const m = /^import from \S+ at ([0-9a-f]{7,40})$/.exec(s.trim());
    if (m) return m[1];
  }
  return null;
}
const sample = (paths: string[], max = 20) => [...paths.slice(0, max), ...(paths.length > max ? [`… and ${paths.length - max} more`] : [])];

async function migrate(c: Config, a: Args): Promise<void> {
  const dry = has(a, "dry-run"), keep = has(a, "keep-on-main"), force = has(a, "force");
  const ref = mainRef(c), B = boardDir(c), cfgTarget = join(c.home, CONFIG);
  // Every write to a legacy board takes "merge-main": while it is held, nothing lands on the board between import and removal.
  const release = dry ? () => {} : await locksOf(c).take("merge-main", Infinity, "board migrate");
  try {
    gitOk(c.repo, "fetch", "-q", c.remote, c.branch);
    const sha = gitOk(c.repo, "rev-parse", ref).trim();
    const kind = boardKind(c);
    if (kind === "none") return void console.log(`Nothing to migrate: there is no board on ${ref} (vixtab init creates a private one).`);
    const onMain = lsTree(c, sha, c.board);
    const cfgOnMain = git(c.repo, "cat-file", "-e", `${sha}:${CONFIG}`).code === 0;
    const importing = kind === "legacy";
    // A private board already: an earlier run imported it and left the old copy on main (--keep-on-main, or a failed push).
    // That copy is removed only while it is still exactly what was imported.
    const from = importing ? sha : importedFrom(c);
    const remove = !keep && onMain.length > 0 && !!from && treeOf(c, from, c.board) === treeOf(c, sha, c.board);
    if (!importing && !remove) {
      console.log(`Nothing to migrate: the board is private (${native(B)}).`);
      if (onMain.length)
        console.log(`  ${ref} still has ${c.board}/ (${onMain.length} file(s)): ${keep ? "kept (--keep-on-main)" : from ? `it changed after the import at ${from}, so it is left alone` : "not an import of this board, so it is left alone"}.`);
      return;
    }

    let inFlight: string[] = [];
    if (importing) {
      const rows = parseRows(c, git(c.repo, "show", `${sha}:${c.board}/README.md`).out);
      const busy = new Set([...rows.filter((r) => /^[⏳❓]/u.test(r.status)).map((r) => r.id), ...activeTickets(c)]);
      inFlight = [...busy].sort().map((id) => {
        const s = rows.find((r) => r.id === id)?.status ?? "";
        return `${id} (${/^[⏳❓]/u.test(s) ? s : "claimed"})`;
      });
      const many = inFlight.length > 1;
      if (inFlight.length && !force)
        fail(
          `Not migrated: ${inFlight.join(", ")} ${many ? "are" : "is"} in flight, and ${many ? "their sessions use" : "its session uses"} the board on ${ref}. ` +
            `Finish ${many ? "them" : "it"} (vixtab ticket done <id>) or give ${many ? "them" : "it"} back (vixtab ticket release <id>), then migrate again; --force migrates anyway.`,
          5,
        );
      if (remove && cfgOnMain && c.home !== defaultHome(c.repo))
        fail(
          `Not migrated: ${native(c.configFile ?? CONFIG)} sets "home" (${native(c.home)}). Once ${CONFIG} is off ${ref}, the config is read from ` +
            `${native(defaultHome(c.repo))}, where it cannot move the home. Set VIXTAB_HOME=${native(c.home)} for every shell that runs vixtab ` +
            `and migrate again, or migrate with --keep-on-main.`,
          2,
        );
    }

    const v = (would: string, did: string) => (dry ? would : did);
    if (dry) console.log("Dry run: nothing is changed.");
    if (importing) {
      console.log(`${v("Would import", "Importing")} ${onMain.length} file(s) from ${ref} at ${sha.slice(0, 12)} into the private board ${native(B)}:`);
      for (const p of sample(onMain)) console.log(`  ${p}`);
      // The config VixTab reads now: the checkout's file, else the one on main.
      const cfgRepo = join(c.repo, CONFIG);
      const cfg = existsSync(cfgRepo) ? { from: native(cfgRepo), data: readFileSync(cfgRepo) } : cfgOnMain ? { from: `${ref}:${CONFIG}`, data: blob(c, sha, CONFIG) } : null;
      if (cfg) console.log(`${v("Would copy", "Copying")} ${cfg.from} to ${native(cfgTarget)}${existsSync(cfgTarget) ? " (replacing the one there, which was not in use)" : ""}.`);
      if (!dry) {
        const files = Object.fromEntries(onMain.map((p) => [p.slice(c.board.length + 1), blob(c, sha, p)]));
        createBoard(c, files, `import from ${ref} at ${sha.slice(0, 12)}`);
        // The protocol text above the table still describes the board on main; the import commit keeps the original.
        await commitOnBoard(c, "tickets: protocol text for the private board", (read) => {
          const readme = read("README.md");
          const next = readme === null ? null : withCurrentProtocol(c, readme);
          return next !== null && next !== readme ? { "README.md": next } : null;
        });
        if (cfg) writeFileSync(cfgTarget, cfg.data);
      }
    }

    const what = `${c.board}/ (${onMain.length} file(s))${cfgOnMain ? ` and ${CONFIG}` : ""}`;
    if (!remove) console.log(`${v("Would keep", "Kept")} ${what} on ${ref} (--keep-on-main).`);
    else if (dry) console.log(`Would commit "${MOVE_MESSAGE}" on ${ref}, removing ${what}.`);
    else {
      const commit = commitOnMainHeld(c, MOVE_MESSAGE, (read, base) => {
        if (treeOf(c, base, c.board) !== treeOf(c, from!, c.board))
          fail(`Not removed from ${ref}: the board there changed during the migration (a push without VixTab's lock). The private board holds the import from ${from}; compare, then remove ${c.board}/ by hand.`, 4);
        const gone: Record<string, null> = Object.fromEntries(lsTree(c, base, c.board).map((p) => [p, null]));
        if (read(CONFIG) !== null) gone[CONFIG] = null;
        return gone;
      });
      console.log(commit ? `Removed ${what} from ${ref}: ${commit.slice(0, 12)} ${MOVE_MESSAGE}.` : `${ref} had nothing left to remove.`);
      console.log(`  Your checkout keeps its copy until you pull ${c.branch}; the board in it is no longer used.`);
    }
    if (!dry) console.log(`Done: every vixtab command now uses the private board ${native(B)} (on this machine only, never pushed; back it up by copying the folder).`);
    console.log(`Note: the files ${remove ? "remain" : "are"} in the git history of ${c.remote}. Rewriting that history is your own decision; VixTab never does it.`);
    if (inFlight.length)
      console.log(`Warning: ${inFlight.join(", ")} ${v("would be", "were")} in flight (--force). Tell each session that its ticket file is now on the private board (vixtab ticket show <id>), and that it must not commit ${c.board}/ in its worktree.`);
  } finally {
    release();
  }
}
