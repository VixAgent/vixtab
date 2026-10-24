// Claude Code on this machine: config dir, the session registry, transcripts, the CLI binary that ships with the VS Code
// extension, and creating a labeled session without a model turn.
//
// These are NOT public APIs of Claude Code. They were checked with Claude Code 2.1.280 (Linux, VS Code Remote SSH) and 2.1.308–2.1.310
// (Windows). `vixtab doctor` re-checks each of them.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { platform } from "../platform/index.ts";
import { run } from "./run.ts";
import { alive } from "./proc.ts";
import { HOME, fail, isInside, native, norm, sleep } from "./util.ts";

export const claudeDir = () => norm(process.env.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude"));
export const sessionsDir = () => join(claudeDir(), "sessions");
export const projectsDir = () => join(claudeDir(), "projects");
export const skillsDir = () => join(claudeDir(), "skills");

export type SessionEntry = { pid: number; sessionId: string; cwd: string; entrypoint?: string; name?: string };

/** ~/.claude/sessions/<pid>.json, one file per running Claude Code process. */
export function registry(): SessionEntry[] {
  const d = sessionsDir();
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(join(d, f), "utf8"))];
      } catch {
        return [];
      }
    });
}
export const liveSessionsUnder = (roots: string[]) =>
  registry().filter((s) => alive(s.pid) && typeof s.cwd === "string" && roots.some((r) => isInside(s.cwd, r)));

/** Transcript of a session: projects/<cwd with every non-alphanumeric replaced by '-'>/<id>.jsonl (searched if moved). */
export function transcriptPath(cwd: string, sessionId: string): string {
  const direct = join(projectsDir(), native(cwd).replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
  if (existsSync(direct) || !existsSync(projectsDir())) return direct;
  for (const d of readdirSync(projectsDir())) {
    const p = join(projectsDir(), d, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return direct;
}

/** The `claude` binary bundled with the newest installed Claude Code VS Code extension (or VIXTAB_CLAUDE_BIN / PATH). */
export function findClaudeBinary(): string | null {
  if (process.env.VIXTAB_CLAUDE_BIN) return process.env.VIXTAB_CLAUDE_BIN;
  const found: { path: string; v: number[] }[] = [];
  for (const root of platform.vscodeExtensionRoots()) {
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root)) {
      const v = /^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/.exec(d)?.slice(1).map(Number);
      const bin = join(root, d, "resources", "native-binary", platform.claudeBinary);
      if (v && existsSync(bin)) found.push({ path: bin, v });
    }
  }
  found.sort((a, b) => a.v[0] - b.v[0] || a.v[1] - b.v[1] || a.v[2] - b.v[2]);
  return found.at(-1)?.path ?? Bun.which("claude");
}

let versionCache: number[] | null | undefined;
/** Version of the Claude CLI that ships with the VS Code extension, e.g. [2, 1, 308]. */
export function claudeVersion(): number[] | null {
  if (versionCache !== undefined) return versionCache;
  const bin = findClaudeBinary();
  const m = bin ? /(\d+)\.(\d+)\.(\d+)/.exec(run([bin, "--version"]).out) : null;
  return (versionCache = m ? m.slice(1).map(Number) : null);
}

/** Has the user accepted Claude Code's "trust this folder" prompt for dir? (read-only; null = unknown) */
export function folderTrusted(dir: string): boolean | null {
  const f = [join(claudeDir(), ".claude.json"), join(HOME, ".claude.json")].find(existsSync);
  if (!f) return null;
  try {
    const projects = JSON.parse(readFileSync(f, "utf8")).projects ?? {};
    for (const [k, v] of Object.entries<any>(projects)) if (norm(k).toLowerCase() === norm(dir).toLowerCase()) return !!v?.hasTrustDialogAccepted;
    return false;
  } catch {
    return null;
  }
}

/**
 * Environment for the CLI we start. The calling session exports CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_CHILD_SESSION,
 * CLAUDE_CODE_MESSAGING_*, CLAUDECODE… — inherited, they make the new CLI act as a child of the caller (it exits at once).
 * Keep only Claude settings that belong to the user: the config dir and the model-provider switches.
 */
function cleanEnv(): Record<string, string> {
  const keep = /^CLAUDE_(CONFIG_DIR|CODE_USE_(BEDROCK|VERTEX|FOUNDRY))$/i;
  const drop = /^(CLAUDE.*|AI_AGENT|MCP_.*|VSCODE_.*|TERM_PROGRAM.*|ELECTRON_.*|GIT_ASKPASS|OTEL_.*|VIXTAB_EXT_HOST_PID)$/i;
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && (keep.test(k) || !drop.test(k))) e[k] = v;
  e.TERM = "xterm-256color";
  return e;
}

// Screen text without ANSI codes and without whitespace (ConPTY replaces runs of spaces with cursor moves).
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHM]/g;
const flat = (s: string) => s.replace(ANSI, "").replace(/\s+/g, "");

export class TrustNeeded extends Error {}

/**
 * Create a Claude Code session with a custom title, without any model turn (so the tab later runs the default model and
 * spends no tokens): run the interactive CLI in a pseudo-terminal, type `/rename <label>`, then `/exit`.
 * The folder-trust prompt is answered only when `trust` is true (the user said so); otherwise TrustNeeded is thrown.
 */
export async function createLabeledSession(label: string, cwd: string, trust: boolean): Promise<string> {
  const bin = findClaudeBinary() ?? fail("Claude Code CLI not found: install the Claude Code VS Code extension (or set VIXTAB_CLAUDE_BIN)", 3);
  const id = crypto.randomUUID();
  const transcript = transcriptPath(cwd, id);
  const titled = () => existsSync(transcript) && readFileSync(transcript, "utf8").includes('"type":"custom-title"');
  let screen = "";
  const dec = new TextDecoder();
  const p: any = Bun.spawn([bin, "-n", label, "--session-id", id], {
    cwd: native(cwd),
    env: cleanEnv(),
    terminal: {
      cols: 200,
      rows: 50,
      data(_t: unknown, d: Uint8Array) {
        screen = (screen + dec.decode(d, { stream: true })).slice(-200_000);
      },
    },
  } as any);
  const type = (s: string) => p.terminal.write(s);
  const abort = (code: number, why: string): never => {
    try {
      p.kill();
    } catch {}
    fail(`${why}\n--- CLI screen (tail) ---\n${screen.replace(ANSI, "").slice(-1500)}`, code);
  };
  try {
    let ready = false, trustAnswered = false;
    for (let i = 0; i < 120 && !ready; i++, await sleep(500)) {
      const s = flat(screen);
      if (/bypasspermissions|forshortcuts/i.test(s)) ready = true;
      else if (/trustthisfolder|Yes,Itrust|Doyoutrustthefiles/i.test(s) && !trustAnswered) {
        if (!trust) throw new TrustNeeded(cwd);
        // Read the option order and the pointer from the FIRST full drawing of the prompt ("❯ No, exit / Yes, I trust this
        // folder" in 2.1.280–2.1.310, "❯ 1. Yes … / 2. No, exit" in others). Later redraws cannot be read as text: ConPTY only
        // repaints the cells that changed, with cursor moves, so the new "❯" lands at the end of the stream, not on its line.
        // Then press the arrow key the right number of times. Enter on "No, exit" quits the CLI — that is caught below.
        await sleep(300);
        const f = flat(screen);
        const opts = [...f.matchAll(/(❯)?(?:\d\.)?(Yes,Itrust|Yes,proceed|No,exit)/gi)].map((m) => ({ yes: /^Yes/i.test(m[2]), ptr: !!m[1] }));
        const yes = opts.findIndex((o) => o.yes), at = opts.findIndex((o) => o.ptr);
        if (yes < 0 || at < 0) abort(3, "could not read the options of the trust prompt");
        for (let k = 0; k < Math.abs(yes - at); k++) {
          type(yes > at ? "\x1b[B" : "\x1b[A");
          await sleep(400);
        }
        type("\r");
        trustAnswered = true;
        screen = "";
        await sleep(1000);
      } else if (/Choosethetextstyle|Syntaxtheme:|Securitynotes:.*PressEntertocontinue|PressEntertocontinue/i.test(s)) {
        type("\r"); // first-run screens: keep the defaults
        screen = "";
        await sleep(1000);
      }
      if (p.exitCode !== null) abort(3, `Claude CLI exited early (code ${p.exitCode})`);
    }
    if (!ready) abort(3, "Claude CLI not ready after 60 s");
    for (let attempt = 0; attempt < 2 && !titled(); attempt++) {
      if (attempt) {
        type("\x1b");
        await sleep(300);
        type("\x1b");
        await sleep(300);
      }
      type(`/rename ${label}`);
      await sleep(500);
      type("\r");
      for (let i = 0; i < 20 && !titled(); i++) await sleep(500);
    }
    if (!titled()) abort(3, `Claude CLI did not write the session title to ${native(transcript)}`);
    type("/exit");
    await sleep(300);
    type("\r");
    for (let i = 0; i < 20 && p.exitCode === null; i++) await sleep(500);
  } finally {
    if (p.exitCode === null) {
      try {
        p.kill();
      } catch {}
    }
  }
  return id;
}
