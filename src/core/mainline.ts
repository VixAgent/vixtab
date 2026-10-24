// Writing to the main branch. Every write goes through the "merge-main" lock, so sessions never rebase and push at once.
//  - pushFromWorktree: rebase a ticket branch on main, write status cells AFTER the rebase (so two tickets claimed or finished
//    at the same moment never conflict on adjacent board rows), optionally run tests, push.
//  - commitOnMain: board-only edits (new ticket, question, answer, release) committed straight onto main with git plumbing
//    and a temporary index: no checkout at all, fast even in huge repositories.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, mainRef } from "./config.ts";
import { Locks } from "./locks.ts";
import { git, gitOk, run, runInherit, withPipefail } from "./run.ts";
import { VixError, fail, native } from "./util.ts";

export const locksOf = (c: Config) => new Locks(c.locks);

export async function pushFromWorktree(c: Config, W: string, test: string[] = [], afterRebase?: () => void): Promise<void> {
  const release = await locksOf(c).take("merge-main", Infinity, `merge ${native(W)}`);
  try {
    gitOk(W, "fetch", "-q", c.remote, c.branch);
    if (git(W, "rebase", "-q", mainRef(c)).code !== 0)
      fail(`Rebase conflict. Resolve it in ${native(W)} (git add <files>; GIT_EDITOR=true git rebase --continue), then run merge again.`, 4);
    afterRebase?.();
    if (test.length) {
      const cmd = withPipefail(test);
      console.log(`== Tests after rebase: ${cmd.join(" ")}`);
      const code = await runInherit(cmd, W);
      if (code !== 0) fail(`Tests failed (exit ${code}) — NOT pushed to ${c.branch}.`, code);
    }
    gitOk(W, "push", "-q", c.remote, `HEAD:${c.branch}`);
    console.log(`Pushed to ${c.branch}: ${gitOk(W, "log", "-1", "--format=%h %s").trim().slice(0, 90)}`);
  } finally {
    release();
  }
}

/**
 * Commit file edits directly on top of main (remote) and push. `edit` receives a reader for files on main and returns the new
 * contents of the files it changes (path → text), or null to do nothing.
 */
export async function commitOnMain(
  c: Config,
  message: string,
  edit: (read: (path: string) => string | null) => Record<string, string> | null,
): Promise<string | null> {
  const release = await locksOf(c).take("merge-main", Infinity, message.slice(0, 80));
  const tmp = mkdtempSync(join(tmpdir(), "vixtab-index-"));
  try {
    for (let attempt = 1; ; attempt++) {
      gitOk(c.repo, "fetch", "-q", c.remote, c.branch);
      const base = gitOk(c.repo, "rev-parse", mainRef(c)).trim();
      const read = (p: string) => {
        const r = git(c.repo, "show", `${base}:${p}`);
        return r.code === 0 ? r.out : null;
      };
      const files = edit(read);
      if (!files || !Object.keys(files).length) return null;
      const env = { ...process.env, GIT_INDEX_FILE: join(tmp, `index-${attempt}`) };
      const g = (...a: string[]) => {
        const r = run(["git", ...a], c.repo, env);
        if (r.code !== 0) throw new VixError(`git ${a.join(" ")} failed:\n${(r.err || r.out).trim()}`);
        return r.out.trim();
      };
      g("read-tree", base);
      for (const [path, text] of Object.entries(files)) {
        const blob = Bun.spawnSync(["git", "hash-object", "-w", "--stdin", "--path", path], { cwd: c.repo, stdin: Buffer.from(text) });
        if (blob.exitCode !== 0) fail(`git hash-object failed for ${path}`);
        g("update-index", "--add", "--cacheinfo", `100644,${blob.stdout.toString().trim()},${path}`);
      }
      const tree = g("write-tree");
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
    release();
  }
}
