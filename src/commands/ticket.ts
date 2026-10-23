// vixtab ticket list | new | show | claim | merge | done | release | ask | answer | overlap
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { type Args, has, parseArgs, str } from "../core/args.ts";
import {
  ANSWER_PLACEHOLDER, STATUS, addQuestion, addRow, boardFilesOnMain, countQuestions, fetchMain, parseRows, questionsOf, readBoard,
  renderTicket, setRowStatus, setTicketStatus, ticketFileIn, ticketOnMain, writeStatusIn,
} from "../core/board.ts";
import { type Config, branchOf, formatId, idNumber, idPattern, isId, loadConfig, mainRef, requireId, worktreeOf } from "../core/config.ts";
import { commitOnMain, pushFromWorktree } from "../core/mainline.ts";
import { pickPort } from "../core/ports.ts";
import { printProcesses, processesInside, stopPids } from "../core/proc.ts";
import { git, gitOk, shellCommand } from "../core/run.ts";
import { fail, isReservedName, native, nowIso, sleep, slugify, today } from "../core/util.ts";

export const HELP = `vixtab ticket — the board of tickets that parallel sessions work on

  ticket list [--json]                         board on the main branch + who holds each ticket
  ticket new "<title>" [--body-file F] [--area "files/functions"] [--after T-001,T-002]
                                               add a ticket (next free id) straight to main; prints id= and file=
  ticket show <id> [--questions]               print a ticket as it is on main
  ticket claim <id> [--as <session>] [--takeover]
                                               lock + worktree + branch vixtab/<id> + ⏳ DOING on main
  ticket merge <id> [-- <test command…>]       rebase on main, test after rebase, push (red tests are never pushed)
  ticket done <id>                             ✅ DONE on main, stop processes in the worktree, remove it
  ticket release <id> [--reason "…"]           give the ticket back (keeps a worktree that has unmerged work)
  ticket ask <id> "<question>"                 ❓ ASK on main + the question in the ticket
  ticket answer <id> "<answer>"                record the answer, back to ⏳ DOING
  ticket overlap [<id>…]                       files that two or more active tickets change (exit 1 if any)
`;

const claimDir = (c: Config, id: string) => join(c.locks, "tickets", id);
type Claim = { session: string; at: string; host: string };
export function readClaim(c: Config, id: string): Claim | null {
  try {
    return JSON.parse(readFileSync(join(claimDir(c, id), "claim.json"), "utf8"));
  } catch {
    return null;
  }
}
export const isDone = (c: Config, id: string) => existsSync(join(claimDir(c, id), "done"));
export function activeTickets(c: Config): string[] {
  const d = join(c.locks, "tickets");
  return existsSync(d) ? readdirSync(d).filter((id) => isId(c, id) && !isDone(c, id) && existsSync(worktreeOf(c, id))) : [];
}

const clean = (W: string) => gitOk(W, "status", "--porcelain", "--untracked-files=no").trim() === "";

function excludeLocally(W: string, name: string): void {
  const ex = join(gitOk(W, "rev-parse", "--path-format=absolute", "--git-common-dir").trim(), "info", "exclude");
  const cur = existsSync(ex) ? readFileSync(ex, "utf8") : "";
  if (!cur.split(/\r?\n/).includes(name)) appendFileSync(ex, (cur && !cur.endsWith("\n") ? "\n" : "") + name + "\n");
}

async function stopInside(W: string, listOnly = false): Promise<boolean> {
  const ps = processesInside(W);
  if (!ps.length) {
    console.log(`No process runs inside ${native(W)}.`);
    return true;
  }
  console.log(`${listOnly ? "" : "Stopping "}${ps.length} process(es) running inside ${native(W)}:`);
  printProcesses(ps);
  return listOnly ? true : await stopPids(ps.map((p) => p.pid));
}

export async function removeWorktree(c: Config, W: string, id: string): Promise<void> {
  (await stopInside(W)) || console.log(`Warning: processes still run inside ${native(W)} (see above) — removing the worktree anyway.`);
  for (let attempt = 1; ; attempt++) {
    const r = git(c.repo, "worktree", "remove", "--force", W);
    if (r.code === 0) break;
    // A remove that failed half way (a file still locked on Windows) leaves the folder but no worktree entry.
    if (/is not a working tree/.test(r.err)) {
      try {
        rmSync(W, { recursive: true, force: true });
      } catch {}
      git(c.repo, "worktree", "prune");
      if (!existsSync(W)) break;
    }
    if (attempt >= 5) fail(`git worktree remove ${native(W)} failed:\n${r.err}`);
    await sleep(1000); // Windows keeps files locked for a moment after a process exits
  }
  git(c.repo, "branch", "-q", "-D", branchOf(id));
  console.log(`Removed worktree and branch ${branchOf(id)}.`);
}

/** Board-only edit on main: status cell + ticket status line (+ optional extra edit of the ticket text). */
function statusEdit(c: Config, id: string, cell: string, line: string, more?: (t: string) => string) {
  return (read: (p: string) => string | null) => {
    const files: Record<string, string> = {};
    const readme = read(`${c.board}/README.md`);
    if (readme !== null) {
      const next = setRowStatus(c, readme, id, cell);
      if (next !== null) files[`${c.board}/README.md`] = next;
    }
    const f = boardFilesOnMain(c).find((n) => n.startsWith(`${id}-`) || n === `${id}.md`);
    if (f) {
      const t = read(`${c.board}/${f}`);
      if (t !== null) files[`${c.board}/${f}`] = (more ?? ((x: string) => x))(setTicketStatus(t, line));
    }
    return files;
  };
}

function holderOf(c: Config, id: string): string {
  return readClaim(c, id)?.session ?? "unknown";
}

export async function ticket(argv: string[]): Promise<void> {
  const [action, ...rest] = argv;
  const a: Args = parseArgs(rest, ["as", "body-file", "area", "after", "reason"]);
  const c = loadConfig();
  switch (action) {
    case "list":
    case "ls": {
      fetchMain(c);
      const { rows } = readBoard(c);
      const out = rows.map((r) => {
        const cl = readClaim(c, r.id);
        return { id: r.id, title: r.title, status: r.status, after: r.after, holder: cl?.session ?? null, since: cl?.at ?? null, done: isDone(c, r.id), worktree: existsSync(worktreeOf(c, r.id)) ? worktreeOf(c, r.id) : null };
      });
      if (has(a, "json")) return void console.log(JSON.stringify(out, null, 1));
      if (!out.length) return void console.log(`(no tickets on ${mainRef(c)} — add one: vixtab ticket new "<title>")`);
      console.log(`${"Ticket".padEnd(8)} ${"Status".padEnd(28)} ${"After".padEnd(12)} Title`);
      for (const r of out) console.log(`${r.id.padEnd(8)} ${r.status.slice(0, 28).padEnd(28)} ${(r.after.join(",") || "—").padEnd(12)} ${r.title}`);
      return;
    }

    case "new": {
      const title = a._[0] ?? fail('usage: vixtab ticket new "<title>" [--body-file F] [--area …] [--after T-001]', 2);
      const bodyFile = str(a, "body-file");
      const body = bodyFile ? readFileSync(bodyFile, "utf8") : undefined;
      const after = (str(a, "after") ?? "").split(/[,\s]+/).filter(Boolean);
      for (const x of after) requireId(c, x);
      let id = "", file = "";
      await commitOnMain(c, `tickets: add ${title.slice(0, 60)}`, (read) => {
        const readme = read(`${c.board}/README.md`) ?? fail(`no board on ${mainRef(c)} (run: vixtab init --push)`, 2);
        const re = new RegExp(`^${idPattern(c)}`);
        const used = [
          ...parseRows(c, readme).map((r) => r.id),
          ...boardFilesOnMain(c).map((f) => re.exec(f)?.[0]).filter((x): x is string => !!x),
          ...(existsSync(join(c.locks, "tickets")) ? readdirSync(join(c.locks, "tickets")).filter((x) => isId(c, x)) : []),
        ].map((x) => idNumber(c, x));
        id = formatId(c, Math.max(0, ...used) + 1);
        let slug = slugify(title);
        if (isReservedName(slug)) slug = `${slug}-task`;
        file = `${id}-${slug}.md`;
        return {
          [`${c.board}/${file}`]: renderTicket(id, title, { area: str(a, "area"), after, body }),
          [`${c.board}/README.md`]: addRow(readme, { id, file, title, after }),
        };
      });
      console.log(`id=${id} file=${c.board}/${file}`);
      return;
    }

    case "show": {
      const id = requireId(c, a._[0]);
      fetchMain(c);
      const t = ticketOnMain(c, id) ?? fail(`${id} not found on ${mainRef(c)}`, 2);
      console.log(has(a, "questions") ? questionsOf(t.text) : t.text);
      return;
    }

    case "claim": {
      const id = requireId(c, a._[0]);
      const who = str(a, "as") ?? id;
      const dir = claimDir(c, id);
      mkdirSync(join(c.locks, "tickets"), { recursive: true });
      let takeover = false;
      try {
        mkdirSync(dir);
      } catch {
        const cl = readClaim(c, id);
        if (isDone(c, id)) fail(`${id} is already done (by ${cl?.session ?? "?"}).`, 5);
        if (!has(a, "takeover")) fail(`${id} is held by ${cl?.session ?? "?"} since ${cl?.at ?? "?"}. Pick another ticket (vixtab ticket list), or continue it with --takeover.`, 5);
        takeover = true;
      }
      writeFileSync(join(dir, "claim.json"), JSON.stringify({ session: who, at: nowIso(), host: hostname() }));
      const W = worktreeOf(c, id);
      try {
        fetchMain(c);
        if (!ticketOnMain(c, id)) fail(`${id} does not exist on ${mainRef(c)} (create it with vixtab ticket new)`, 2);
        await commitOnMain(c, `tickets: ${id} claimed by ${who}`, statusEdit(c, id, STATUS.doing(who), `${STATUS.doing(who)} — session **${who}**, worktree \`wt-${id}\`, branch \`${branchOf(id)}\` (${today()})`));
      } catch (e) {
        if (!takeover) rmSync(dir, { recursive: true, force: true });
        throw e;
      }
      if (!existsSync(W)) {
        const hasBranch = git(c.repo, "rev-parse", "-q", "--verify", `refs/heads/${branchOf(id)}`).code === 0;
        const r = hasBranch ? git(c.repo, "worktree", "add", "-q", W, branchOf(id)) : git(c.repo, "worktree", "add", "-q", "-b", branchOf(id), W, mainRef(c));
        if (r.code) fail(`claim ${id}: creating the worktree failed:\n${r.err}\nThe ticket stays locked for ${who}; fix the problem and run claim again with --takeover, or: vixtab ticket release ${id}`);
      } else if (!takeover) fail(`worktree ${native(W)} already exists without a claim — inspect it, then claim with --takeover`, 5);
      excludeLocally(W, ".vixtab.env");
      const n = idNumber(c, id), port = await pickPort(c.ports.base, n);
      const vars: Record<string, string> = { VIXTAB_TICKET: id, VIXTAB_PORT: String(port), VIXTAB_WORKTREE: W };
      for (const [k, v] of Object.entries(c.env)) vars[k] = v.replaceAll("{port}", String(port)).replaceAll("{n}", String(n)).replaceAll("{ticket}", id).replaceAll("{worktree}", W);
      writeFileSync(join(W, ".vixtab.env"), `# Private resources of ${id} — load with: source .vixtab.env\n` + Object.entries(vars).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join("\n") + "\n");
      const tf = ticketFileIn(c, W, id);
      console.log(`${takeover ? "Took over" : "Claimed"} ${id} for ${who}.`);
      console.log(`  worktree : ${native(W)}   (branch ${branchOf(id)})`);
      console.log(`  ticket   : ${tf ? native(tf) : "?"}`);
      console.log(`  first    : cd ${JSON.stringify(W)} && source .vixtab.env${c.setup ? ` && ${c.setup}` : ""}`);
      console.log(`  port     : ${port}`);
      console.log(`  merge    : vixtab ticket merge ${id} -- <test command>${c.test ? `   (default: ${c.test})` : ""}`);
      console.log(`  finish   : fill in ## Answer, commit, vixtab ticket done ${id}`);
      return;
    }

    case "merge": {
      const id = requireId(c, a._[0]);
      const W = worktreeOf(c, id);
      if (!existsSync(W)) fail(`no worktree ${native(W)} (claim the ticket first)`, 2);
      if (!clean(W)) fail("the worktree has uncommitted changes — commit them first", 2);
      const test = a.rest.length ? a.rest : c.test ? shellCommand(c.test) : [];
      await pushFromWorktree(c, W, test);
      return;
    }

    case "done": {
      const id = requireId(c, a._[0]);
      const W = worktreeOf(c, id);
      if (!existsSync(W)) fail(`no worktree ${native(W)}`, 2);
      if (!clean(W)) fail("the worktree has uncommitted changes — commit them first", 2);
      const tf = ticketFileIn(c, W, id);
      if (tf && readFileSync(tf, "utf8").includes(ANSWER_PLACEHOLDER)) fail("## Answer in the ticket is still empty — write commits, tests and notes there, commit, then run done", 2);
      fetchMain(c);
      const unmerged = gitOk(W, "diff", "--name-only", `${mainRef(c)}...HEAD`).split("\n").filter((f) => f && !f.startsWith(`${c.board}/`));
      if (unmerged.length) fail(`${id} has changes that are not merged yet (${unmerged.slice(0, 5).join(", ")}${unmerged.length > 5 ? ", …" : ""}). Run vixtab ticket merge ${id} first — done never pushes untested code.`, 2);
      const who = holderOf(c, id);
      await pushFromWorktree(c, W, [], () => {
        const files = writeStatusIn(c, W, id, STATUS.done(who), `${STATUS.done(who)} — session **${who}** (${today()})`);
        if (files.length) {
          gitOk(W, "add", "--", ...files);
          git(W, "commit", "-q", "-m", `tickets: ${id} done`);
        }
      });
      writeFileSync(join(claimDir(c, id), "done"), nowIso() + "\n");
      await removeWorktree(c, W, id);
      return;
    }

    case "release": {
      const id = requireId(c, a._[0]);
      const W = worktreeOf(c, id);
      const who = holderOf(c, id);
      if (existsSync(W)) {
        fetchMain(c);
        const own = gitOk(W, "log", `${mainRef(c)}..HEAD`, "--oneline").split("\n").filter(Boolean);
        if (gitOk(W, "status", "--porcelain").trim() === "" && !own.length) await removeWorktree(c, W, id);
        else {
          console.log(`Worktree ${native(W)} has unmerged work — kept for whoever continues (claim --takeover).`);
          await stopInside(W, true);
        }
      }
      fetchMain(c);
      const row = readBoard(c).rows.find((r) => r.id === id);
      if (row && !row.status.startsWith("✅")) {
        const reason = str(a, "reason") ?? "released";
        await commitOnMain(c, `tickets: ${id} released by ${who}`, statusEdit(c, id, STATUS.todo, `${STATUS.todo} — ${reason} by ${who} (${today()})`));
      }
      rmSync(claimDir(c, id), { recursive: true, force: true });
      console.log(`Released ${id}.`);
      return;
    }

    case "ask":
    case "answer": {
      const id = requireId(c, a._[0]);
      const text = a._.slice(1).join(" ").trim() || fail(`usage: vixtab ticket ${action} ${id} "<text>"`, 2);
      const who = holderOf(c, id);
      let count = 0;
      const asking = action === "ask";
      await commitOnMain(
        c,
        `tickets: ${id} ${asking ? "question" : "answer"}`,
        statusEdit(c, id, asking ? STATUS.ask(who) : STATUS.doing(who), `${asking ? STATUS.ask(who) : STATUS.doing(who)} (${today()})`, (t) => {
          const r = addQuestion(t, asking ? `- **Q (${today()}, ${who}):** ${text}` : `  - **A (${today()}):** ${text}`);
          count = r.count;
          return r.text;
        }),
      );
      console.log(asking ? `${id}: question #${count} recorded, status ❓ ASK. Stop here and wait for the answer message.` : `${id}: answer recorded, status ⏳ DOING.`);
      return;
    }

    case "overlap": {
      const only = a._.filter((x) => isId(c, x));
      fetchMain(c);
      const filesOf = changedFilesOfActive(c);
      const who = new Map<string, string[]>();
      for (const [id, fs] of filesOf) for (const f of fs) who.set(f, [...(who.get(f) ?? []), id]);
      for (const [id, fs] of filesOf) console.log(`${id}: ${fs.length} file(s)`);
      const both = [...who].filter(([, ids]) => ids.length > 1 && (!only.length || ids.some((x) => only.includes(x))));
      if (!both.length) return void console.log("No file is changed by two active tickets.");
      console.log(`OVERLAP (${both.length} file(s)) — merges stay serialized; the later ticket must rebase and re-run its tests:`);
      for (const [f, ids] of both.sort((x, y) => x[0].localeCompare(y[0]))) console.log(`  ${f}: ${ids.join(", ")}${c.hotFiles.includes(f) ? "  (hot file)" : ""}`);
      process.exitCode = 1;
      return;
    }

    default:
      console.log(HELP);
      if (action && action !== "help") process.exitCode = 2;
  }
}

/** For each active ticket: files changed since it forked from main (committed + uncommitted), board excluded. */
export function changedFilesOfActive(c: Config): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const id of activeTickets(c)) {
    const W = worktreeOf(c, id);
    const base = git(W, "merge-base", mainRef(c), "HEAD").out.trim();
    if (!base) continue;
    out.set(id, git(W, "diff", "--name-only", base).out.split("\n").map((f) => f.trim()).filter((f) => f && !f.startsWith(`${c.board}/`)));
  }
  return out;
}

export const countQuestionsOnMain = (c: Config, id: string) => {
  const t = ticketOnMain(c, id);
  return t ? countQuestions(t.text) : 0;
};
