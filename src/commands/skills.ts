// vixtab skills scope | install | remove | status — the Claude Code skills and where they apply.
import { has, parseArgs } from "../core/args.ts";
import { findRepo } from "../core/config.ts";
import {
  applyScope, currentScope, globalSkillsDir, installProjectSkills, installSkills, parseScope, projectSkillsDir, removeSkills, savedScope, skillsStatus,
} from "../core/skills.ts";
import { native } from "../core/util.ts";

export const HELP = `vixtab skills — the Claude Code skills vixtab-orchestrate and vixtab-ticket, and where they apply

  skills scope [global|project]         show or choose the scope (saved; upgrades keep it):
                                          global  (default) every project: skills in ~/.claude/skills, every Claude Code
                                                  session on this machine can use VixTab
                                          project only the repositories you orchestrate: skills in <repo>/.claude/skills,
                                                  added by the VixTab button / vixtab init; other projects never see them
  skills install [--global] [--commit] [--force]
                                        this repository's .claude/skills (kept out of git unless --commit), or with
                                        --global ~/.claude/skills
  skills remove [--global]              remove VixTab's copies (edited copies are kept)
  skills status                         scope and where the skills are installed

Ticket sessions start in the repository root, so they see project skills; linked worktrees without their own .claude/skills
use the main checkout's (Claude Code 2.1.277+).`;

export async function skills(argv: string[]): Promise<void> {
  const [action, ...rest] = argv;
  const a = parseArgs(rest);
  switch (action) {
    case "scope": {
      if (!a._[0]) {
        const s = currentScope();
        console.log(`scope=${s}${savedScope() ? "" : " (default)"} — ${s === "global" ? "every project on this machine" : "only the repositories you orchestrate"}`);
        return;
      }
      for (const n of applyScope(parseScope(a._[0]), has(a, "force"))) console.log(n);
      return;
    }
    case "install":
      if (has(a, "global")) for (const n of installSkills(globalSkillsDir(), has(a, "force"))) console.log(n);
      else for (const n of installProjectSkills(findRepo(), { force: has(a, "force"), commit: has(a, "commit") })) console.log(n);
      return;
    case "remove":
      for (const n of removeSkills(has(a, "global") ? globalSkillsDir() : projectSkillsDir(findRepo()))) console.log(n);
      return;
    case "status": {
      const s = currentScope();
      console.log(`scope    ${s}${savedScope() ? "" : " (default)"}`);
      let repo: string | null = null;
      try {
        repo = findRepo();
      } catch {}
      for (const x of skillsStatus(globalSkillsDir())) console.log(`global   ${x.name.padEnd(20)} ${x.state.padEnd(8)} ${native(x.file)}`);
      if (repo) for (const x of skillsStatus(projectSkillsDir(repo))) console.log(`project  ${x.name.padEnd(20)} ${x.state.padEnd(8)} ${native(x.file)}`);
      return;
    }
    default:
      console.log(HELP);
      if (action && action !== "help") process.exitCode = 2;
  }
}
