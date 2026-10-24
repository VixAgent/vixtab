// vixtab doctor — check everything VixTab relies on, with the fix for each problem.
import { accessSync, constants, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { has, parseArgs } from "../core/args.ts";
import { fetchMain, showMain } from "../core/board.ts";
import { WINDOWS, windows } from "../core/bridge.ts";
import { findClaudeBinary, folderTrusted, sessionsDir } from "../core/claude.ts";
import { currentScope, globalSkillsDir, projectSkillsDir, skillsStatus } from "../core/skills.ts";
import { type Config, loadConfig, mainRef } from "../core/config.ts";
import { ancestors } from "../core/proc.ts";
import { measure } from "../core/resources.ts";
import { run } from "../core/run.ts";
import { native } from "../core/util.ts";
import { platform } from "../platform/index.ts";
import { VERSION } from "../version.ts";
import { BIN_DIR } from "./setup.ts";

type Check = { status: "OK" | "WARN" | "FAIL"; name: string; detail: string; fix?: string };

export async function doctor(argv: string[]): Promise<void> {
  const a = parseArgs(argv);
  const out: Check[] = [];
  const add = (status: Check["status"], name: string, detail: string, fix?: string) => out.push({ status, name, detail, fix });

  add("OK", "vixtab", `${VERSION} on ${platform.id} (${process.arch}), Bun ${Bun.version}`);
  const g = run(["git", "--version"]);
  g.code === 0 ? add("OK", "git", g.out.trim()) : add("FAIL", "git", "not found", "install git and put it on PATH");

  let c: Config | null = null;
  try {
    c = loadConfig();
    add("OK", "repo", `${native(c.repo)}${c.configFile ? "" : " (no vixtab.config.json: defaults)"}`);
  } catch (e) {
    add("WARN", "repo", String((e as Error).message).split("\n")[0], "run vixtab inside your project");
  }
  if (c) {
    if (fetchMain(c).code !== 0) add("FAIL", "remote", `cannot fetch ${mainRef(c)}`, `check \`git fetch ${c.remote} ${c.branch}\` (credentials, network, branch name in vixtab.config.json)`);
    else if (showMain(c, `${c.board}/README.md`) === null) add("FAIL", "board", `no board on ${mainRef(c)} (${c.board}/README.md)`, "vixtab init --push");
    else add("OK", "board", `${c.board}/README.md on ${mainRef(c)}`);
    // Check without creating anything: the home is created by the first claim.
    const probe = existsSync(c.home) ? c.home : dirname(c.home);
    try {
      accessSync(probe, constants.W_OK);
      add("OK", "home", `${native(c.home)}${existsSync(c.home) ? "" : " (created on the first claim)"} — worktrees, locks`);
    } catch {
      add("FAIL", "home", `${native(probe)} is not writable`, "set \"home\" in vixtab.config.json or VIXTAB_HOME");
    }
    const t = folderTrusted(c.repo);
    if (t === false) add("WARN", "trust", `Claude Code has not trusted ${native(c.repo)} yet`, "the first `vixtab session open` stops at the trust prompt; re-run it with --trust once the user agrees");
    else if (t) add("OK", "trust", "Claude Code trusts this folder");
  }

  const bin = findClaudeBinary();
  if (!bin) add("FAIL", "claude", "Claude Code CLI not found", "install the Claude Code extension in VS Code (or set VIXTAB_CLAUDE_BIN)");
  else {
    const v = run([bin, "--version"]);
    add(v.code === 0 ? "OK" : "WARN", "claude", `${native(bin)} ${v.out.trim().split("\n")[0] ?? ""}`);
  }
  existsSync(sessionsDir()) ? add("OK", "sessions", native(sessionsDir())) : add("WARN", "sessions", `${native(sessionsDir())} missing`, "start Claude Code once");

  const ws = windows();
  if (!ws.length) add("FAIL", "extension", `no VS Code window has registered in ${native(WINDOWS)}`, "install the VixTab extension (it registers on startup), then reload the window");
  else {
    const pids = new Set(ws.map((w) => w.pid));
    const inside = process.env.VIXTAB_EXT_HOST_PID ?? ancestors(process.pid, platform.processes()).find((p) => pids.has(p));
    add(inside ? "OK" : "WARN", "extension", `${ws.length} window(s): ${ws.map((w) => `${w.pid} v${w.version}`).join(", ")}${inside ? `; this process runs in window ${inside}` : ""}`, inside ? undefined : "run inside a Claude Code session or terminal of VS Code, or set VIXTAB_EXT_HOST_PID");
  }

  // Skills follow the scope: every project (~/.claude/skills) or only the orchestrated repositories (<repo>/.claude/skills).
  const scope = currentScope();
  const notOk = (dir: string) => skillsStatus(dir).filter((s) => s.state === "missing" || s.state === "outdated");
  if (scope === "global") {
    const b = notOk(globalSkillsDir());
    b.length
      ? add("FAIL", "skills", `scope every project, but ${b.map((s) => `${s.name} ${s.state}`).join(", ")} in ${native(globalSkillsDir())}`, "vixtab setup (or vixtab skills install --global)")
      : add("OK", "skills", `scope every project: ${native(globalSkillsDir())}`);
  } else {
    if (c) {
      const b = notOk(projectSkillsDir(c.repo));
      b.length
        ? add("FAIL", "skills", `scope project, but ${b.map((s) => `${s.name} ${s.state}`).join(", ")} in ${native(projectSkillsDir(c.repo))}`, "vixtab skills install (or click VixTab in the status bar)")
        : add("OK", "skills", `scope project: ${native(projectSkillsDir(c.repo))}`);
    }
    const global = skillsStatus(globalSkillsDir()).filter((s) => s.state !== "missing");
    if (global.length)
      add("WARN", "skills", `scope project, but ${global.map((s) => s.name).join(", ")} still in ${native(globalSkillsDir())}: every project sees them`, "vixtab skills remove --global");
  }
  const shim = join(BIN_DIR, `vixtab${platform.exeSuffix}`);
  existsSync(shim) || existsSync(join(BIN_DIR, "vixtab")) ? add("OK", "cli", native(shim)) : add("FAIL", "cli", `${native(shim)} missing (the skills call it)`, "vixtab setup --bin");

  const cap = platform.memoryCapKind();
  add(cap.startsWith("none") ? "WARN" : "OK", "heavy cap", cap);
  if (c) {
    const gate = await measure({ minFreeMB: c.sessions.minFreeRamMB, maxSwapMB: c.sessions.maxSwapMB, maxCommit: c.sessions.maxCommit, maxCpu: c.sessions.maxCpu });
    add(gate.missing.length ? "WARN" : "OK", "gate", `${gate.line}${gate.missing.length ? " — closed: " + gate.missing.join("; ") : " — new sessions can open"}`);
  }

  if (has(a, "json")) return void console.log(JSON.stringify(out, null, 1));
  for (const x of out) {
    if (has(a, "brief") && x.status === "OK") continue;
    console.log(`${x.status.padEnd(4)} ${x.name.padEnd(10)} ${x.detail}${x.fix ? `\n           → ${x.fix}` : ""}`);
  }
  const bad = out.filter((x) => x.status === "FAIL").length;
  if (has(a, "brief")) console.log(bad ? `${bad} problem(s) to fix.` : "doctor: all good.");
  process.exitCode = bad ? 1 : 0;
}
