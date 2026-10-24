// vixtab wait — sleep until something needs the orchestrator, then print the events and exit. Run it in the background: the
// orchestrator spends no tokens while nothing happens (no polling loop in the conversation).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { has, parseArgs, str } from "../core/args.ts";
import { fetchMain, readBoard, readyRows } from "../core/board.ts";
import { isId, loadConfig, mainRef } from "../core/config.ts";
import { alive } from "../core/proc.ts";
import { git } from "../core/run.ts";
import { fail, sleep } from "../core/util.ts";
import { changedFilesOfActive, countQuestionsOnMain, isDone } from "./ticket.ts";

export const HELP = `vixtab wait [--as <name>] [--every <seconds>] [--no-rebase] <id>[:<pid>] …

Exits as soon as there is at least one NEW event for the listed tickets, printing one per line:
  done <id>                      the ticket is ✅ DONE (worktree removed) — close its tab
  ask <id> #<n>                  the session asked question n (vixtab ticket show <id> --questions)
  gone <id>                      the session (pid given as <id>:<pid>) exited before finishing
  rebase <id> <files…>           main just received changes to files this active ticket also changes
  ready <id>                     a waiting ticket can start now: the last ticket in its After list (one you wait for) is done
Each event is reported once per --as name (default "orchestrator"), so several orchestrators do not swallow each other's events.
Any session can use it: a ticket session that needs another ticket's result runs \`vixtab wait --as <its id> <other id>\`.
`;

type State = { seen: string[]; main?: string };

export async function wait(argv: string[]): Promise<void> {
  const a = parseArgs(argv, ["as", "every"]);
  const c = loadConfig();
  const targets = a._.map((t) => {
    const [id, pid] = t.split(":");
    if (!isId(c, id)) fail(`not a ticket id: ${t}`, 2);
    return { id, pid: pid ? Number(pid) : 0 };
  });
  if (!targets.length) return void console.log(HELP);
  const name = (str(a, "as") ?? "orchestrator").replace(/[^\w.-]/g, "_");
  const every = Math.max(5, Number(str(a, "every") ?? 30)) * 1000;
  mkdirSync(c.locks, { recursive: true });
  const file = join(c.locks, `wait-${name}.json`);
  const load = (): State => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return { seen: [] };
    }
  };
  while (true) {
    const st = load();
    const seen = new Set(st.seen);
    const events: string[] = [];
    // "done" = the local marker, which `ticket done` writes LAST (after pushing ✅ DONE and removing the worktree): the session
    // has nothing left to clean up, so the orchestrator may close its tab. ✅ DONE on the board can appear a moment earlier.
    for (const t of targets) {
      if (isDone(c, t.id)) {
        if (!seen.has(`done ${t.id}`)) events.push(`done ${t.id}`);
        continue;
      }
      if (t.pid && !alive(t.pid) && !seen.has(`gone ${t.id}:${t.pid}`)) events.push(`gone ${t.id}:${t.pid}`);
    }
    fetchMain(c);
    const rows = readBoard(c).rows;
    // A dependency chain moves on: report the waiting tickets that one of OUR tickets just unblocked.
    const mine = new Set(targets.map((t) => t.id));
    // Only once those tickets of ours are fully done (marker), so "ready" comes together with — never before — their "done".
    for (const r of readyRows(rows))
      if (r.after.some((x) => mine.has(x)) && r.after.every((x) => !mine.has(x) || isDone(c, x)) && !seen.has(`ready ${r.id}`)) events.push(`ready ${r.id}`);
    for (const t of targets) {
      const row = rows.find((r) => r.id === t.id);
      if (row?.status.startsWith("❓")) {
        const key = `ask ${t.id} #${countQuestionsOnMain(c, t.id)}`;
        if (!seen.has(key)) events.push(key);
      }
    }
    const head = git(c.repo, "rev-parse", mainRef(c)).out.trim();
    if (!has(a, "no-rebase") && st.main && head && st.main !== head) {
      const touched = new Set(
        git(c.repo, "log", "--format=", "--name-only", `${st.main}..${head}`).out.split("\n").map((f) => f.trim()).filter((f) => f && !f.startsWith(`${c.board}/`)),
      );
      if (touched.size) {
        for (const [id, files] of changedFilesOfActive(c)) {
          if (!mine.has(id)) continue;
          const wt = `${c.home}/wt-${id}`;
          if (git(wt, "merge-base", "--is-ancestor", head, "HEAD").code === 0) continue; // already rebased
          const both = files.filter((f) => touched.has(f));
          const key = `rebase ${id} ${head.slice(0, 12)}`;
          if (both.length && !seen.has(key)) {
            events.push(`rebase ${id} ${both.join(" ")}`);
            seen.add(key);
            st.seen.push(key);
          }
        }
      }
    }
    if (head) st.main = head;
    for (const e of events) if (!e.startsWith("rebase ")) st.seen.push(e);
    writeFileSync(file, JSON.stringify({ seen: [...new Set(st.seen)].slice(-2000), main: st.main }));
    if (events.length) {
      console.log(events.map((e) => e.replace(/^(gone \S+):\d+$/, "$1")).join("\n"));
      return;
    }
    if (!existsSync(file)) fail(`cannot write ${file}`);
    await sleep(every);
  }
}
