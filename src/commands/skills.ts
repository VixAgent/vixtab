// vixtab skills install | remove | status — the Claude Code skills, per project.
import { has, parseArgs } from "../core/args.ts";
import { findRepo } from "../core/config.ts";
import { globalSkillsDir, installProjectSkills, projectSkillsDir, removeSkills, skillsStatus } from "../core/skills.ts";
import { native } from "../core/util.ts";

export const HELP = `vixtab skills — the Claude Code skills vixtab-orchestrate and vixtab-ticket

  skills install [--commit] [--force]   into <repo>/.claude/skills of THIS repository only (Claude Code sessions of other
                                        projects never see them); kept out of git via .git/info/exclude, unless --commit
  skills remove [--global]              remove them from this repository (--global: from ~/.claude/skills, where they
                                        would be listed to every session of every project)
  skills status                         where they are installed

Ticket sessions start in the repository root, so they see the project skills; linked worktrees without their own .claude/skills
use the main checkout's (Claude Code 2.1.277+). The VixTab button in VS Code and \`vixtab init\` install them automatically.`;

export async function skills(argv: string[]): Promise<void> {
  const [action, ...rest] = argv;
  const a = parseArgs(rest);
  switch (action) {
    case "install":
      for (const n of installProjectSkills(findRepo(), { force: has(a, "force"), commit: has(a, "commit") })) console.log(n);
      return;
    case "remove":
      for (const n of removeSkills(has(a, "global") ? globalSkillsDir() : projectSkillsDir(findRepo()))) console.log(n);
      return;
    case "status": {
      let repo: string | null = null;
      try {
        repo = findRepo();
      } catch {}
      if (repo) for (const s of skillsStatus(projectSkillsDir(repo))) console.log(`project  ${s.name.padEnd(20)} ${s.state.padEnd(8)} ${native(s.file)}`);
      for (const s of skillsStatus(globalSkillsDir())) if (s.state !== "missing") console.log(`GLOBAL   ${s.name.padEnd(20)} ${s.state.padEnd(8)} ${native(s.file)}  ← every project sees this; vixtab skills remove --global`);
      return;
    }
    default:
      console.log(HELP);
      if (action && action !== "help") process.exitCode = 2;
  }
}
