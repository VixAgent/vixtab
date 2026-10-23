// vixtab setup — install the CLI to ~/.vixtab/bin, put it on PATH, install the Claude Code skills, optionally the extension.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ORCHESTRATE from "../../skills/vixtab-orchestrate/SKILL.md" with { type: "text" };
import TICKET from "../../skills/vixtab-ticket/SKILL.md" with { type: "text" };
import { has, parseArgs, str } from "../core/args.ts";
import { skillsDir } from "../core/claude.ts";
import { runInherit } from "../core/run.ts";
import { isCompiled, selfArgv } from "../core/self.ts";
import { HOME, IS_WIN, fail, native, pathKey } from "../core/util.ts";
import { platform } from "../platform/index.ts";

export const SKILLS: Record<string, string> = { "vixtab-orchestrate": ORCHESTRATE, "vixtab-ticket": TICKET };
export const BIN_DIR = join(HOME, ".vixtab", "bin");
export const MARKER = "vixtab-managed";

export const HELP = `vixtab setup [--bin] [--skills] [--path] [--extension <file.vsix>] [--force]

Without options: --bin --path --skills.
  --bin        copy this program to ${native(BIN_DIR)} (the path the skills call)
  --path       add that folder to the user PATH (Linux: ~/.local/bin/vixtab link)
  --skills     install the Claude Code skills vixtab-orchestrate and vixtab-ticket into ~/.claude/skills (all projects)
  --extension  install the VS Code extension from a .vsix with \`code --install-extension\`
  --force      overwrite skills you edited (files without the "${MARKER}" marker)`;

export function installSkills(force = false): string[] {
  const notes: string[] = [];
  for (const [name, text] of Object.entries(SKILLS)) {
    const dir = join(skillsDir(), name), file = join(dir, "SKILL.md");
    if (existsSync(file) && !force) {
      const cur = readFileSync(file, "utf8");
      if (cur === text) {
        notes.push(`skill ${name}: up to date`);
        continue;
      }
      if (!cur.includes(MARKER)) {
        notes.push(`skill ${name}: kept your edited copy (use --force to replace)`);
        continue;
      }
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, text);
    notes.push(`skill ${name}: installed ${native(file)}`);
  }
  return notes;
}

export function installBin(): string {
  mkdirSync(BIN_DIR, { recursive: true });
  const target = join(BIN_DIR, `vixtab${platform.exeSuffix}`);
  for (const f of readdirSync(BIN_DIR)) if (f.startsWith("vixtab.old-")) rmSync(join(BIN_DIR, f), { force: true });
  if (!isCompiled()) {
    // Development checkout: a shim that runs the sources with Bun (works in bash and Git Bash).
    const [bun, cli] = selfArgv();
    const shim = join(BIN_DIR, "vixtab");
    writeFileSync(shim, `#!/usr/bin/env bash\nexec "${bun.replace(/\\/g, "/")}" "${cli}" "$@"\n`);
    chmodSync(shim, 0o755);
    return `installed a development shim ${native(shim)} → ${cli}`;
  }
  if (pathKey(process.execPath) === pathKey(target)) return `${native(target)} is this program`;
  // A running .exe cannot be overwritten on Windows, but it can be renamed.
  if (existsSync(target)) renameSync(target, join(BIN_DIR, `vixtab.old-${Date.now()}${platform.exeSuffix}`));
  copyFileSync(process.execPath, target);
  if (!IS_WIN) chmodSync(target, 0o755);
  return `installed ${native(target)}`;
}

export async function setup(argv: string[]): Promise<void> {
  const a = parseArgs(argv, ["extension"]);
  if (has(a, "help")) return void console.log(HELP);
  const any = ["bin", "skills", "path", "extension"].some((k) => has(a, k));
  const want = (k: string) => (any ? has(a, k) : k !== "extension");
  if (want("bin")) console.log(installBin());
  if (want("path")) console.log(platform.addToUserPath(BIN_DIR));
  if (want("skills")) for (const n of installSkills(has(a, "force"))) console.log(n);
  const vsix = str(a, "extension");
  if (vsix) {
    if (!existsSync(vsix)) fail(`no such file: ${vsix}`, 2);
    const code = Bun.which("code") ?? fail("the `code` command is not on PATH (VS Code: Command Palette ▸ Shell Command: Install 'code' command)", 2);
    process.exitCode = await runInherit([code, "--install-extension", vsix, "--force"]);
  }
  console.log("Next: open a repository in VS Code and click 'VixTab: Orchestrate' in the status bar (or run vixtab doctor).");
}
