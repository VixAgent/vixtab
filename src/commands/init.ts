// vixtab init — add VixTab to a repository: vixtab.config.json + the board folder, optionally committed straight onto main.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { has, parseArgs, str } from "../core/args.ts";
import { boardReadme, ticketBodyTemplate } from "../core/board.ts";
import { findRepo, loadConfig, mainRef } from "../core/config.ts";
import { commitOnMain } from "../core/mainline.ts";
import { git } from "../core/run.ts";
import { installProjectSkills } from "../core/skills.ts";
import { native } from "../core/util.ts";

export const HELP = `vixtab init [--board tickets] [--test "<command>"] [--push]

Creates (if missing) vixtab.config.json and <board>/README.md (protocol + ticket table) + <board>/TEMPLATE.md.
--push commits exactly those files onto the main branch of the remote (tickets are always read from there) and fast-forwards
your checkout when it can. Nothing else in your working tree is committed.`;

export async function init(argv: string[]): Promise<void> {
  const a = parseArgs(argv, ["board", "test"]);
  if (has(a, "help")) return void console.log(HELP);
  const repo = findRepo();
  const cfgPath = join(repo, "vixtab.config.json");
  const created: Record<string, string> = {};
  if (!existsSync(cfgPath)) {
    const cfg = { board: str(a, "board") ?? "tickets", branch: "main", test: str(a, "test") ?? "", setup: "", ports: { base: 4000 }, hotFiles: [] as string[] };
    created["vixtab.config.json"] = JSON.stringify(cfg, null, 2) + "\n";
    writeFileSync(cfgPath, created["vixtab.config.json"]);
  }
  const c = loadConfig();
  mkdirSync(join(repo, c.board), { recursive: true });
  for (const [name, text] of [["README.md", boardReadme(c)], ["TEMPLATE.md", ticketBodyTemplate()]] as const) {
    const p = join(repo, c.board, name);
    if (!existsSync(p)) {
      writeFileSync(p, text);
      created[`${c.board}/${name}`] = text;
    }
  }
  console.log(Object.keys(created).length ? `Created: ${Object.keys(created).join(", ")}` : "Already initialized (nothing created).");
  for (const n of installProjectSkills(repo)) console.log(n);
  if (!has(a, "push")) return void console.log(`Next: review the files, then run: vixtab init --push   (or commit them yourself)`);
  const files: Record<string, string> = {};
  for (const p of ["vixtab.config.json", `${c.board}/README.md`, `${c.board}/TEMPLATE.md`]) files[p] = readFileSync(join(repo, p), "utf8");
  const before = git(repo, "rev-parse", "HEAD").out.trim();
  const commit = await commitOnMain(c, "vixtab: add the ticket board", (read) => {
    const out: Record<string, string> = {};
    for (const [p, t] of Object.entries(files)) if (read(p) !== t) out[p] = t;
    return Object.keys(out).length ? out : null;
  });
  if (!commit) return void console.log(`The board is already on ${mainRef(c)}.`);
  console.log(`Pushed ${commit.slice(0, 8)} to ${mainRef(c)}.`);
  // Fast-forward the checkout: our just-written untracked copies would block the merge, so remove them first (same content).
  const onBranch = git(repo, "symbolic-ref", "-q", "--short", "HEAD").out.trim() === c.branch;
  const behindOnly = git(repo, "merge-base", "--is-ancestor", before, commit).code === 0;
  if (onBranch && behindOnly) {
    const untracked = Object.keys(files).filter((p) => git(repo, "ls-files", "--error-unmatch", p).code !== 0);
    for (const p of untracked) rmSync(join(repo, p));
    if (git(repo, "merge", "--ff-only", "-q", mainRef(c)).code === 0) return void console.log(`Fast-forwarded ${native(repo)} to ${mainRef(c)}.`);
    for (const p of untracked) writeFileSync(join(repo, p), files[p]);
  }
  console.log(`Your checkout was not fast-forwarded; run: git pull --ff-only   (the board is on ${mainRef(c)})`);
}
