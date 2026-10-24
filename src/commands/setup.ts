// vixtab setup — install the CLI to ~/.vixtab/bin, put it on PATH, apply the skills scope (every project by default, or only the
// repositories you orchestrate), optionally install the extension.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { has, parseArgs, str } from "../core/args.ts";
import { runInherit } from "../core/run.ts";
import { isCompiled, selfArgv } from "../core/self.ts";
import { applyScope, currentScope, parseScope } from "../core/skills.ts";
import { HOME, IS_WIN, fail, native, pathKey } from "../core/util.ts";
import { platform } from "../platform/index.ts";

export const BIN_DIR = join(HOME, ".vixtab", "bin");

export const HELP = `vixtab setup [--scope global|project] [--bin] [--path] [--extension <file.vsix>]

Without --bin/--path/--extension: all of --bin --path, and the skills for the scope.
  --scope global   (default) VixTab for every project: skills in ~/.claude/skills, every Claude Code session can use it
  --scope project  only the repositories you orchestrate: the VixTab button and vixtab init add the skills to
                   <repo>/.claude/skills (kept out of git); other projects never see them
                   The choice is saved in ~/.vixtab/config.json and kept by later setups and upgrades
                   (also: vixtab skills scope, VIXTAB_SKILLS_SCOPE for the installers).
  --bin            copy this program to ${native(BIN_DIR)} (the path the skills call)
  --path           add that folder to the user PATH (Linux: ~/.local/bin/vixtab link)
  --extension      install the VS Code extension from a .vsix with \`code --install-extension\``;

export function installBin(): string {
  mkdirSync(BIN_DIR, { recursive: true });
  const target = join(BIN_DIR, `vixtab${platform.exeSuffix}`);
  // Earlier copies renamed by previous upgrades; one that still runs (a background `vixtab wait` of a running orchestration)
  // cannot be deleted on Windows: skip it, the next upgrade removes it.
  for (const f of readdirSync(BIN_DIR)) {
    if (!f.startsWith("vixtab.old-")) continue;
    try {
      rmSync(join(BIN_DIR, f), { force: true });
    } catch {}
  }
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
  const a = parseArgs(argv, ["extension", "scope"]);
  if (has(a, "help")) return void console.log(HELP);
  const any = ["bin", "path", "extension"].some((k) => has(a, k));
  const want = (k: string) => (any ? has(a, k) : k === "bin" || k === "path");
  if (want("bin")) console.log(installBin());
  if (want("path")) console.log(platform.addToUserPath(BIN_DIR));
  if (!any || str(a, "scope")) for (const n of applyScope(str(a, "scope") ? parseScope(str(a, "scope")) : currentScope())) console.log(n);
  const vsix = str(a, "extension");
  if (vsix) {
    if (!existsSync(vsix)) fail(`no such file: ${vsix}`, 2);
    const code = Bun.which("code") ?? fail("the `code` command is not on PATH (VS Code: Command Palette ▸ Shell Command: Install 'code' command)", 2);
    process.exitCode = await runInherit([code, "--install-extension", vsix, "--force"]);
  }
  console.log("Next: open a repository in VS Code and click 'VixTab' in the status bar.");
}
