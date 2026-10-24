// The Claude Code skills of VixTab are PER PROJECT: <repo>/.claude/skills/vixtab-*, kept out of git through .git/info/exclude
// unless the team chooses to commit them. Skills in ~/.claude/skills would be listed to every Claude Code session on the machine,
// in every project — VixTab 0.1–0.3 put them there, so a session in an unrelated project could pick them up. `vixtab setup` now
// removes those copies (only files that carry the marker).
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ORCHESTRATE from "../../skills/vixtab-orchestrate/SKILL.md" with { type: "text" };
import TICKET from "../../skills/vixtab-ticket/SKILL.md" with { type: "text" };
import { skillsDir } from "./claude.ts";
import { git } from "./run.ts";
import { native } from "./util.ts";

export const SKILLS: Record<string, string> = { "vixtab-orchestrate": ORCHESTRATE, "vixtab-ticket": TICKET };
export const MARKER = "vixtab-managed";

export const projectSkillsDir = (repo: string) => join(repo, ".claude", "skills");
export const globalSkillsDir = () => skillsDir();

export type SkillState = { name: string; file: string; state: "ok" | "missing" | "outdated" | "edited" };

export function skillsStatus(dir: string): SkillState[] {
  return Object.entries(SKILLS).map(([name, text]) => {
    const file = join(dir, name, "SKILL.md");
    if (!existsSync(file)) return { name, file, state: "missing" };
    const cur = readFileSync(file, "utf8");
    return { name, file, state: cur === text ? "ok" : cur.includes(MARKER) ? "outdated" : "edited" };
  });
}

/** Write the skills into `dir`; a copy without the marker (edited by the user) is kept unless `force`. */
export function installSkills(dir: string, force = false): string[] {
  return skillsStatus(dir).map((s) => {
    if (s.state === "ok") return `skill ${s.name}: up to date (${native(s.file)})`;
    if (s.state === "edited" && !force) return `skill ${s.name}: kept your edited copy (--force replaces it)`;
    mkdirSync(join(dir, s.name), { recursive: true });
    writeFileSync(s.file, SKILLS[s.name]);
    return `skill ${s.name}: installed ${native(s.file)}`;
  });
}

/** Remove the skills VixTab wrote into `dir` (files with the marker only). */
export function removeSkills(dir: string): string[] {
  const out: string[] = [];
  for (const s of skillsStatus(dir)) {
    if (s.state === "missing") continue;
    if (s.state === "edited") {
      out.push(`skill ${s.name}: kept ${native(s.file)} (edited by you, no VixTab marker)`);
      continue;
    }
    rmSync(join(dir, s.name), { recursive: true, force: true });
    out.push(`skill ${s.name}: removed from ${native(dir)}`);
  }
  return out;
}

/** Keep the project skills out of git (info/exclude is shared by every worktree of the repository). */
export function excludeSkillsFromGit(repo: string): void {
  const common = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir").out.trim();
  if (!common) return;
  const ex = join(common, "info", "exclude");
  const cur = existsSync(ex) ? readFileSync(ex, "utf8") : "";
  const lines = cur.split(/\r?\n/);
  const want = Object.keys(SKILLS).map((n) => `/.claude/skills/${n}/`).filter((l) => !lines.includes(l));
  if (!want.length) return;
  mkdirSync(join(common, "info"), { recursive: true });
  appendFileSync(ex, (cur && !cur.endsWith("\n") ? "\n" : "") + want.join("\n") + "\n");
}

/** Install the skills for one repository (the usual way), kept out of git unless `commit`. */
export function installProjectSkills(repo: string, o: { force?: boolean; commit?: boolean } = {}): string[] {
  const notes = installSkills(projectSkillsDir(repo), o.force);
  if (!o.commit) excludeSkillsFromGit(repo);
  else notes.push(`commit them for your team: git add .claude/skills/${Object.keys(SKILLS).join(" .claude/skills/")}`);
  return notes;
}
