// vixtab status — is VixTab set up for this project, and which versions: the CLI, the VS Code extension (installed, and what
// each open window runs), the Claude Code skills this project's sessions see, and the ticket board.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { has, parseArgs } from "../core/args.ts";
import { fetchMain, parseRows, showMain } from "../core/board.ts";
import { callerWindow, windows } from "../core/bridge.ts";
import { type Config, findRepo, loadConfig, mainRef } from "../core/config.ts";
import { currentScope, globalSkillsDir, projectSkillsDir, savedScope, skillsStatus, type SkillState } from "../core/skills.ts";
import { native } from "../core/util.ts";
import { platform } from "../platform/index.ts";
import { VERSION } from "../version.ts";
import { BIN_DIR } from "./setup.ts";

export const HELP = `vixtab status [--json] [--offline]

Run inside a project. Tells whether its Claude Code sessions can use VixTab, and every version involved:
the vixtab CLI (this program and ~/.vixtab/bin), the VS Code extension (installed, and what each open window runs — a window
keeps the version it started with until it is reopened), the skills (scope, copies, the version stamped in each), and the board.
--offline: do not fetch the main branch (the board is read from what is already fetched).`;

const cmp = (a: string, b: string) => {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/** Versions of phanthaitrung.vixtab found in the VS Code extension folders (local and Remote SSH), newest first. */
export function installedExtensionVersions(): string[] {
  const found = new Set<string>();
  for (const root of platform.vscodeExtensionRoots()) {
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root)) {
      const m = /^phanthaitrung\.vixtab-(\d+\.\d+\.\d+)/.exec(d);
      if (m) found.add(m[1]);
    }
  }
  return [...found].sort((a, b) => cmp(b, a));
}

/** The version of the CLI in ~/.vixtab/bin (the one the skills call), without running it when it is this program. */
function installedCliVersion(): string | null {
  const exe = join(BIN_DIR, `vixtab${platform.exeSuffix}`);
  const path = existsSync(exe) ? exe : existsSync(join(BIN_DIR, "vixtab")) ? join(BIN_DIR, "vixtab") : null;
  if (!path) return null;
  try {
    const r = Bun.spawnSync([path, "--version"], { stdout: "pipe", stderr: "ignore" });
    return /\d+\.\d+\.\d+/.exec(r.stdout.toString())?.[0] ?? "?";
  } catch {
    return "?";
  }
}

const describe = (list: SkillState[]) =>
  list.map((s) => `${s.name} ${s.state === "missing" ? "—" : s.version ? `v${s.version}` : "(older than 0.4.1)"}${s.state === "ok" || s.state === "missing" ? "" : ` ${s.state}`}`).join(", ");

export async function status(argv: string[]): Promise<void> {
  const a = parseArgs(argv);
  let repo: string | null = null, c: Config | null = null;
  try {
    repo = findRepo();
    c = loadConfig();
  } catch {}
  const scope = currentScope();
  const global = skillsStatus(globalSkillsDir());
  const project = repo ? skillsStatus(projectSkillsDir(repo)) : [];
  const has2 = (l: SkillState[]) => l.length > 0 && l.every((s) => s.state !== "missing");
  const skillsHere = repo ? (has2(project) ? "project" : has2(global) ? "global" : null) : has2(global) ? "global" : null;
  const used = skillsHere === "project" ? project : skillsHere === "global" ? global : [];
  const usedVersion = used.map((s) => s.version).find(Boolean) ?? null;

  let board: { state: "ok" | "none" | "unknown"; total?: number; open?: number; path?: string } = { state: "unknown" };
  if (c) {
    if (!has(a, "offline")) fetchMain(c);
    const readme = showMain(c, `${c.board}/README.md`);
    if (readme === null) board = { state: "none", path: `${c.board}/README.md` };
    else {
      const rows = parseRows(c, readme);
      board = { state: "ok", path: `${c.board}/README.md`, total: rows.length, open: rows.filter((r) => !r.status.startsWith("✅")).length };
    }
  }
  const cli = installedCliVersion();
  const ext = installedExtensionVersions();
  const me = callerWindow();
  const wins = windows();

  const out = {
    project: repo,
    enabled: !!skillsHere,
    cli: { thisProgram: VERSION, installed: cli, path: native(join(BIN_DIR, `vixtab${platform.exeSuffix}`)) },
    extension: { installed: ext[0] ?? null, windows: wins.map((w) => ({ pid: w.pid, version: w.version, folders: w.folders, thisWindow: w.pid === me })) },
    skills: { scope, scopeSaved: !!savedScope(), seenBy: skillsHere, version: usedVersion, global: describe(global), project: repo ? describe(project) : null },
    board,
  };
  if (has(a, "json")) return void console.log(JSON.stringify(out, null, 1));

  const latest = [VERSION, cli, ext[0], usedVersion].filter((v): v is string => !!v && v !== "?").sort((x, y) => cmp(y, x))[0] ?? VERSION;
  const old = (v: string | null | undefined) => (v && v !== "?" && cmp(v, latest) < 0 ? `  ← older than ${latest}` : "");
  console.log(repo ? `VixTab in ${native(repo)}: ${skillsHere ? "YES, its Claude Code sessions can use VixTab" : "NO, its sessions do not see the VixTab skills"}` : "Not inside a git repository.");
  console.log(`  CLI        ${cli ? `v${cli}` : "not installed"} (${out.cli.path})${old(cli)}${cli !== VERSION ? `; this program v${VERSION}` : ""}`);
  console.log(`  extension  ${ext.length ? `v${ext[0]} installed` : "not installed"}${ext.length > 1 ? ` (also ${ext.slice(1).map((v) => `v${v}`).join(", ")})` : ""}${old(ext[0])}`);
  for (const w of wins) console.log(`             window ${w.pid}: v${w.version}${w.pid === me ? " (this window)" : ""}  ${w.folders.map(native).join(", ")}${old(w.version) ? `${old(w.version)} — reopen that window to load the new one` : ""}`);
  console.log(`  skills     scope ${scope === "global" ? "every project" : "only chosen projects"}${savedScope() ? "" : " (default)"}; this project uses ${skillsHere === "project" ? "its own copies" : skillsHere === "global" ? "the copies for every project" : "none"}${usedVersion ? ` v${usedVersion}` : ""}${old(usedVersion)}`);
  console.log(`             every project (${native(globalSkillsDir())}): ${describe(global)}`);
  if (repo) console.log(`             this project (${native(projectSkillsDir(repo))}): ${describe(project)}`);
  console.log(`  board      ${board.state === "ok" ? `${board.path} on ${mainRef(c!)}: ${board.total} ticket(s), ${board.open} not done` : board.state === "none" ? `none on ${mainRef(c!)} (create one: vixtab init --push, or let the orchestrator do it)` : "—"}`);
  if (!skillsHere) console.log(`Enable it: click VixTab in the status bar of this repository, or run ${scope === "global" ? "vixtab setup" : "vixtab skills install"}.`);
}
