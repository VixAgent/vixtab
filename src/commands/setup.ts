// vixtab setup — install the CLI to ~/.vixtab/bin and put it on PATH, optionally the extension. The Claude Code skills are per
// project (vixtab skills install); setup removes the user-level copies older versions left in ~/.claude/skills.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { has, parseArgs, str } from "../core/args.ts";
import { runInherit } from "../core/run.ts";
import { isCompiled, selfArgv } from "../core/self.ts";
import { globalSkillsDir, installSkills, removeSkills } from "../core/skills.ts";
import { HOME, IS_WIN, fail, native, pathKey } from "../core/util.ts";
import { platform } from "../platform/index.ts";

export const BIN_DIR = join(HOME, ".vixtab", "bin");

export const HELP = `vixtab setup [--bin] [--path] [--extension <file.vsix>] [--global-skills]

Without options: --bin --path, and removes the VixTab skills that versions before 0.3.1 put in ~/.claude/skills.
  --bin            copy this program to ${native(BIN_DIR)} (the path the skills call)
  --path           add that folder to the user PATH (Linux: ~/.local/bin/vixtab link)
  --extension      install the VS Code extension from a .vsix with \`code --install-extension\`
  --global-skills  put the skills in ~/.claude/skills instead: EVERY Claude Code session of EVERY project on this machine then
                   lists them. Normally they live in each repository that uses VixTab (vixtab skills install, done for you
                   by the VixTab button and by vixtab init).`;

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
  const any = ["bin", "path", "extension", "global-skills"].some((k) => has(a, k));
  const want = (k: string) => (any ? has(a, k) : k === "bin" || k === "path");
  if (want("bin")) console.log(installBin());
  if (want("path")) console.log(platform.addToUserPath(BIN_DIR));
  if (has(a, "global-skills")) {
    for (const n of installSkills(globalSkillsDir())) console.log(n);
    console.log("Note: every Claude Code session of every project on this machine now lists these skills.");
  } else if (!any) for (const n of removeSkills(globalSkillsDir())) console.log(`${n} (VixTab skills are per project now: vixtab skills install)`);
  const vsix = str(a, "extension");
  if (vsix) {
    if (!existsSync(vsix)) fail(`no such file: ${vsix}`, 2);
    const code = Bun.which("code") ?? fail("the `code` command is not on PATH (VS Code: Command Palette ▸ Shell Command: Install 'code' command)", 2);
    process.exitCode = await runInherit([code, "--install-extension", vsix, "--force"]);
  }
  console.log("Next: open a repository in VS Code and click 'VixTab' in the status bar — that repository gets the skills; others are untouched.");
}
