// Where the Claude Code skills of VixTab live is the user's choice — the SCOPE, saved in ~/.vixtab/config.json:
//   global  (default): ~/.claude/skills — every Claude Code session of every project on the machine can use VixTab;
//   project          : <repo>/.claude/skills of each repository the user orchestrates, kept out of git through
//                      .git/info/exclude unless the team commits them; sessions of other projects never see them.
// VixTab 0.3.1 was project-only; 0.4.0 made the scope a choice. Removal only touches files that carry the marker.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ORCHESTRATE from "../../skills/vixtab-orchestrate/SKILL.md" with { type: "text" };
import TICKET from "../../skills/vixtab-ticket/SKILL.md" with { type: "text" };
import { skillsDir } from "./claude.ts";
import { git } from "./run.ts";
import { HOME, fail, native } from "./util.ts";
import { VERSION } from "../version.ts";

export const SKILLS: Record<string, string> = { "vixtab-orchestrate": ORCHESTRATE, "vixtab-ticket": TICKET };
export const MARKER = "vixtab-managed";

export const projectSkillsDir = (repo: string) => join(repo, ".claude", "skills");
export const globalSkillsDir = () => skillsDir();

// ── Scope ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type Scope = "global" | "project";
export const DEFAULT_SCOPE: Scope = "global";
const prefsFile = () => process.env.VIXTAB_PREFS ?? join(HOME, ".vixtab", "config.json");
export function parseScope(s: string | undefined): Scope {
  const v = (s ?? "").toLowerCase();
  if (["global", "all", "allprojects", "all-projects"].includes(v)) return "global";
  if (["project", "projects", "perproject", "per-project"].includes(v)) return "project";
  fail(`scope must be "global" (every project) or "project" (only the repositories you orchestrate), got '${s ?? ""}'`, 2);
}
export function savedScope(): Scope | null {
  try {
    const s = JSON.parse(readFileSync(prefsFile(), "utf8")).skillsScope;
    return s === "global" || s === "project" ? s : null;
  } catch {
    return null;
  }
}
/** VIXTAB_SKILLS_SCOPE, else the saved choice, else every project. */
export const currentScope = (): Scope => (process.env.VIXTAB_SKILLS_SCOPE ? parseScope(process.env.VIXTAB_SKILLS_SCOPE) : (savedScope() ?? DEFAULT_SCOPE));
function saveScope(s: Scope): void {
  let prefs: any = {};
  try {
    prefs = JSON.parse(readFileSync(prefsFile(), "utf8"));
  } catch {}
  mkdirSync(dirname(prefsFile()), { recursive: true });
  writeFileSync(prefsFile(), JSON.stringify({ ...prefs, skillsScope: s }, null, 2) + "\n");
}
/** Save the scope and make the user-level skills match it (installed for "global", removed for "project"). */
export function applyScope(s: Scope, force = false): string[] {
  saveScope(s);
  const notes = s === "global" ? installSkills(globalSkillsDir(), force) : removeSkills(globalSkillsDir());
  notes.push(
    s === "global"
      ? "scope: every project — every Claude Code session on this machine can use VixTab (vixtab skills scope project to limit it)"
      : "scope: only the repositories you orchestrate — the VixTab button and vixtab init add the skills there (vixtab skills scope global for every project)",
  );
  return notes;
}

/** `version`: the VixTab version stamped in the copy's marker line (null: unstamped, i.e. written before 0.4.1, or edited). */
export type SkillState = { name: string; file: string; state: "ok" | "missing" | "outdated" | "edited"; version: string | null };

/** The skill as written to disk: the marker line carries the version, so a copy tells which VixTab installed it. */
export const stamped = (name: string) => SKILLS[name].replace(`<!-- ${MARKER}:`, `<!-- ${MARKER} v${VERSION}:`);
export const versionOf = (text: string) => new RegExp(`${MARKER} v(\\d+\\.\\d+\\.\\d+)`).exec(text)?.[1] ?? null;

export function skillsStatus(dir: string): SkillState[] {
  return Object.keys(SKILLS).map((name) => {
    const file = join(dir, name, "SKILL.md");
    if (!existsSync(file)) return { name, file, state: "missing", version: null };
    const cur = readFileSync(file, "utf8");
    return { name, file, state: cur === stamped(name) ? "ok" : cur.includes(MARKER) ? "outdated" : "edited", version: versionOf(cur) };
  });
}

/** Write the skills into `dir`; a copy without the marker (edited by the user) is kept unless `force`. */
export function installSkills(dir: string, force = false): string[] {
  return skillsStatus(dir).map((s) => {
    if (s.state === "ok") return `skill ${s.name}: up to date (${native(s.file)})`;
    if (s.state === "edited" && !force) return `skill ${s.name}: kept your edited copy (--force replaces it)`;
    mkdirSync(join(dir, s.name), { recursive: true });
    writeFileSync(s.file, stamped(s.name));
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

/** Make sure the sessions of `repo` can use the skills, following the scope (global copies, or this repository's). */
export function ensureSkillsFor(repo: string): string[] {
  return currentScope() === "global" ? installSkills(globalSkillsDir()) : installProjectSkills(repo);
}

/** Install the skills for one repository, kept out of git unless `commit`. */
export function installProjectSkills(repo: string, o: { force?: boolean; commit?: boolean } = {}): string[] {
  const notes = installSkills(projectSkillsDir(repo), o.force);
  if (!o.commit) excludeSkillsFromGit(repo);
  else notes.push(`commit them for your team: git add .claude/skills/${Object.keys(SKILLS).join(" .claude/skills/")}`);
  return notes;
}
