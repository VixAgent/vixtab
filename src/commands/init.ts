// vixtab init — add VixTab to a repository: the private board in <home>/board and <home>/vixtab.config.json. Nothing is committed
// in the project.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { has, parseArgs, str } from "../core/args.ts";
import { boardDir, createBoard, isLegacy, legacyNotice, syncBoard } from "../core/boardstore.ts";
import { defaultHome, findRepo, loadConfig } from "../core/config.ts";
import { ensureSkillsFor } from "../core/skills.ts";
import { native } from "../core/util.ts";

export const HELP = `vixtab init [--test "<command>"]

Creates the private ticket board in <home>/board: a local git repository with README.md (protocol + ticket table) and
TEMPLATE.md that is never pushed; its history records every claim, question, answer and status change. Also creates
<home>/vixtab.config.json, unless the repository has its own vixtab.config.json (that one is used, as before).
<home> is <parent>/<repo>.vixtab next to the repository (VIXTAB_HOME overrides). Nothing is committed in the project.
--push is accepted and ignored: the board used to be committed onto the main branch.`;

export async function init(argv: string[]): Promise<void> {
  const a = parseArgs(argv, ["board", "test"]);
  if (has(a, "help")) return void console.log(HELP);
  if (has(a, "push")) console.log("Note: --push is not needed any more: the board is private now, nothing is committed in the project.");
  const repo = findRepo();
  let c = loadConfig();
  syncBoard(c);
  if (isLegacy(c, true)) {
    // Creating a private board now would leave the tickets on main behind: the migration moves them.
    console.log(`Already initialized: ${legacyNotice(c)}.`);
    for (const n of ensureSkillsFor(repo)) console.log(n);
    return;
  }
  const created: string[] = [];
  if (!c.configFile) {
    const home = defaultHome(repo), file = join(home, "vixtab.config.json");
    const cfg = { branch: "main", test: str(a, "test") ?? "", setup: "", ports: { base: 4000 }, hotFiles: [] as string[] };
    mkdirSync(home, { recursive: true });
    if (!existsSync(file)) writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
    created.push(native(file));
    c = loadConfig();
  }
  if (createBoard(c)) created.push(`${native(boardDir(c))} (README.md, TEMPLATE.md)`);
  console.log(created.length ? `Created: ${created.join(", ")}` : "Already initialized (nothing created).");
  console.log(`  board  : ${native(boardDir(c))}   (private: a local git repository, never pushed)`);
  console.log(`  config : ${native(c.configFile!)}`);
  for (const n of ensureSkillsFor(repo)) console.log(n);
}
