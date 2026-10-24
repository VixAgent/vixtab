import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A private Claude config dir: the tests must never touch the real ~/.claude/skills.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "vixtab-claude-"));
const { globalSkillsDir, installProjectSkills, installSkills, projectSkillsDir, removeSkills, skillsStatus } = await import("../src/core/skills.ts");

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "vixtab-skills-"));
  expect(Bun.spawnSync(["git", "init", "-q", d]).exitCode).toBe(0);
  return d;
}

describe("skills are per project", () => {
  test("install puts both skills in <repo>/.claude/skills and keeps them out of git", () => {
    const r = repo();
    installProjectSkills(r);
    expect(skillsStatus(projectSkillsDir(r)).map((s) => s.state)).toEqual(["ok", "ok"]);
    const exclude = readFileSync(join(r, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/.claude/skills/vixtab-orchestrate/");
    expect(exclude).toContain("/.claude/skills/vixtab-ticket/");
    const status = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=all"], { cwd: r }).stdout.toString();
    expect(status).not.toContain("vixtab-");
    installProjectSkills(r); // idempotent: no duplicate exclude lines
    expect(readFileSync(join(r, ".git", "info", "exclude"), "utf8").split("/.claude/skills/vixtab-ticket/").length).toBe(2);
  });

  test("nothing is written to the user-level skills folder", () => {
    installProjectSkills(repo());
    expect(skillsStatus(globalSkillsDir()).every((s) => s.state === "missing")).toBe(true);
  });

  test("remove deletes only VixTab's own copies; an edited copy is kept", () => {
    const g = globalSkillsDir();
    installSkills(g);
    const edited = join(g, "vixtab-ticket", "SKILL.md");
    writeFileSync(edited, "my own version\n");
    const notes = removeSkills(g);
    expect(existsSync(join(g, "vixtab-orchestrate"))).toBe(false);
    expect(existsSync(edited)).toBe(true);
    expect(notes.join("\n")).toContain("kept");
  });

  test("other skills next to them are untouched", () => {
    const r = repo();
    mkdirSync(join(projectSkillsDir(r), "team-skill"), { recursive: true });
    writeFileSync(join(projectSkillsDir(r), "team-skill", "SKILL.md"), "x");
    installProjectSkills(r);
    removeSkills(projectSkillsDir(r));
    expect(existsSync(join(projectSkillsDir(r), "team-skill", "SKILL.md"))).toBe(true);
    expect(skillsStatus(projectSkillsDir(r)).every((s) => s.state === "missing")).toBe(true);
  });
});
