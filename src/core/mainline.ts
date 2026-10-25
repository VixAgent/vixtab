// Writing to the main branch. Every write goes through the "merge-main" lock, so sessions never rebase and push at once.
//  - pushFromWorktree: rebase a ticket branch on main, optionally run tests, push; then, still under the lock, `afterPush`
//    (ticket done writes ✅ DONE on the private board: the status always follows the code on main). A legacy board's status
//    cells are written into the worktree by `afterRebase` instead, AFTER the rebase, so two tickets finished at the same
//    moment never conflict on adjacent board rows.
//  - commitOnMain: legacy-board edits (new ticket, question, answer, release) and `board migrate`'s removal of a legacy board,
//    committed straight onto main with git plumbing and a temporary index: no checkout at all, fast even in huge repositories.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, mainRef } from "./config.ts";
import { Locks } from "./locks.ts";
import { git, gitOk, run, runInherit, withPipefail } from "./run.ts";
import { VixError, fail, native } from "./util.ts";

export const locksOf = (c: Config) => new Locks(c.locks);
export const fetchMain = (c: Config) => git(c.repo, "fetch", "-q", c.remote, c.branch);

export async function pushFromWorktree(
  c: Config,
  W: string,
  test: string[] = [],
  hooks: { afterRebase?: () => void; afterPush?: () => unknown } = {},
): Promise<void> {
  const release = await locksOf(c).take("merge-main", Infinity, `merge ${native(W)}`);
  try {
    gitOk(W, "fetch", "-q", c.remote, c.branch);
    if (git(W, "rebase", "-q", mainRef(c)).code !== 0)
      fail(`Rebase conflict. Resolve it in ${native(W)} (git add <files>; GIT_EDITOR=true git rebase --continue), then run merge again.`, 4);
    hooks.afterRebase?.();
    if (test.length) {
      const cmd = withPipefail(test);
      console.log(`== Tests after rebase: ${cmd.join(" ")}`);
      const code = await runInherit(cmd, W);
      if (code !== 0) fail(`Tests failed (exit ${code}) — NOT pushed to ${c.branch}.`, code);
    }
    gitOk(W, "push", "-q", c.remote, `HEAD:${c.branch}`);
    console.log(`Pushed to ${c.branch}: ${gitOk(W, "log", "-1", "--format=%h %s").trim().slice(0, 90)}`);
    await hooks.afterPush?.();
  } finally {
    release();
  }
}

/** Reads files on main at `base` and returns the new contents of the files it changes (path → text, null deletes), or null. */
export type MainEdit = (read: (path: string) => string | null, base: string) => Record<string, string | null> | null;

/**
 * Commit file edits directly on top of main (remote) and push, under the "merge-main" lock. `edit` receives a reader for
 * files on main (and main's commit) and returns the new contents of the files it changes (path → text, or null to delete it),
 * or null to do nothing. It runs again when the push is rejected (someone pushed without the lock).
 */
export async function commitOnMain(c: Config, message: string, edit: MainEdit): Promise<string | null> {
  const release = await locksOf(c).take("merge-main", Infinity, message.slice(0, 80));
  try {
    return commitOnMainHeld(c, message, edit);
  } finally {
    release();
  }
}

/** commitOnMain for a caller that already holds the "merge-main" lock. */
export function commitOnMainHeld(c: Config, message: string, edit: MainEdit): string | null {
  const tmp = mkdtempSync(join(tmpdir(), "vixtab-index-"));
  try {
    for (let attempt = 1; ; attempt++) {
      gitOk(c.repo, "fetch", "-q", c.remote, c.branch);
      const base = gitOk(c.repo, "rev-parse", mainRef(c)).trim();
      const read = (p: string) => {
        const r = git(c.repo, "show", `${base}:${p}`);
        return r.code === 0 ? r.out : null;
      };
      const files = edit(read, base);
      if (!files || !Object.keys(files).length) return null;
      const env = { ...process.env, GIT_INDEX_FILE: join(tmp, `index-${attempt}`) };
      const g = (...a: string[]) => {
        const r = run(["git", ...a], c.repo, env);
        if (r.code !== 0) throw new VixError(`git ${a.join(" ")} failed:\n${(r.err || r.out).trim()}`);
        return r.out.trim();
      };
      g("read-tree", base);
      for (const [path, text] of Object.entries(files)) {
        if (text === null) {
          g("update-index", "--force-remove", "--", path);
          continue;
        }
        const blob = Bun.spawnSync(["git", "hash-object", "-w", "--stdin", "--path", path], { cwd: c.repo, stdin: Buffer.from(text) });
        if (blob.exitCode !== 0) fail(`git hash-object failed for ${path}`);
        g("update-index", "--add", "--cacheinfo", `100644,${blob.stdout.toString().trim()},${path}`);
      }
      const tree = g("write-tree");
      if (tree === g("rev-parse", `${base}^{tree}`)) return null;
      const commit = g("commit-tree", tree, "-p", base, "-m", message);
      const push = git(c.repo, "push", "-q", c.remote, `${commit}:refs/heads/${c.branch}`);
      if (push.code === 0) {
        git(c.repo, "fetch", "-q", c.remote, c.branch);
        return commit;
      }
      if (attempt >= 3) fail(`push to ${c.branch} rejected 3 times:\n${push.err.trim()}`);
      // Someone pushed without the lock (a human, CI): rebuild on the new main.
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
