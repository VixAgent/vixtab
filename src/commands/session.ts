// vixtab session open | close | count | list — Claude Code tabs, one fresh session per ticket.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { has, parseArgs, str } from "../core/args.ts";
import { findWindow, layout, send, windowInfo } from "../core/bridge.ts";
import { TrustNeeded, claudeVersion, createLabeledSession, liveSessionsUnder, registry } from "../core/claude.ts";
import { type Config, loadConfig } from "../core/config.ts";
import { locksOf } from "../core/mainline.ts";
import { alive } from "../core/proc.ts";
import { measure } from "../core/resources.ts";
import { fail, native, norm, pathKey, sleep } from "../core/util.ts";

export const HELP = `vixtab session — fresh, labeled Claude Code tabs in VS Code

  session open <label> [--cwd DIR] [--prompt TEXT] [--focus] [--here] [--trust] [--no-gate]
        New session whose tab is named <label>, in a NEW column to the right (or the active column with --here), without
        stealing focus (unless --focus). No model turn: no tokens. --prompt pre-fills the input box (it is not sent).
        Prints: session=<uuid> name=<label> pid=<pid> auto_name=<registry name>
        Exit codes: 2 bad label · 3 Claude CLI problem (3 + "trust" = folder not trusted: re-run with --trust after the
        user agrees) · 4 tab problem (4 + "reload needed" = Claude Code's tab state is broken: the user must reload the
        window) · 5 label already open · 6 resource gate closed (queue the ticket, retry later)
  session close <label> [<pid>]    close the tab with exactly this label; with pid, wait until that CLI has exited.
        Tab actions run one at a time; closing a tab can take up to a minute while Claude Code shuts the session down.
        Exit codes: 1 no tab or several tabs with this label · 2 the CLI did not exit · 4 extension did not answer
  session count                    sessions of this repo + the resource gate ("open: yes" or what is missing)
  session list                     live Claude sessions of this repo (pid, name, session id, cwd)

Resource gate (no fixed session cap by default): free RAM − RAM reserved for sessions opened in the last 90 s ≥ minFreeRamMB,
swap ≤ maxSwapMB, commit ≤ 85 % (Windows), CPU ≤ 85 %. Configure in vixtab.config.json "sessions" or VIXTAB_* variables.`;

type Recent = { at: number; label: string };
const recentFile = (c: Config) => join(c.locks, "recent-opens.json");
function recentOpens(c: Config): Recent[] {
  try {
    return (JSON.parse(readFileSync(recentFile(c), "utf8")) as Recent[]).filter((r) => Date.now() - r.at < 90_000);
  } catch {
    return [];
  }
}

async function gate(c: Config) {
  const n = liveSessionsUnder([c.repo, c.home]).length;
  const reserved = recentOpens(c).length * c.sessions.reserveMB;
  const g = await measure({ minFreeMB: c.sessions.minFreeRamMB, maxSwapMB: c.sessions.maxSwapMB, maxCommit: c.sessions.maxCommit, maxCpu: c.sessions.maxCpu }, reserved);
  if (c.sessions.max > 0 && n >= c.sessions.max) g.missing.unshift(`sessions ${n} ≥ max ${c.sessions.max}`);
  return { ...g, line: `sessions=${n}${c.sessions.max > 0 ? "/" + c.sessions.max : ""} ${g.line}` };
}

export async function session(argv: string[]): Promise<void> {
  const [action, ...rest] = argv;
  const a = parseArgs(rest, ["cwd", "prompt"]);
  switch (action) {
    case "count": {
      const c = loadConfig();
      const g = await gate(c);
      console.log(`${g.line} open: ${g.missing.length ? "no — " + g.missing.join("; ") : "yes"}`);
      return;
    }
    case "list": {
      const c = loadConfig();
      for (const s of liveSessionsUnder([c.repo, c.home])) console.log(`${String(s.pid).padEnd(8)} ${(s.name ?? "?").padEnd(26)} ${s.sessionId} ${s.entrypoint ?? ""} ${native(s.cwd)}`);
      return;
    }
    case "open": {
      const label = a._[0] ?? fail("usage: vixtab session open <label>", 2);
      if ([...label].length > 25 || !/^[\p{L}\p{N} ._#-]+$/u.test(label)) fail("label: at most 25 letters, digits, spaces or . _ # -", 2);
      const c = loadConfig();
      const cwd = norm(str(a, "cwd") ?? c.repo);
      if (!existsSync(cwd)) fail(`no such folder: ${cwd}`, 2);
      const win = findWindow(cwd);
      const info = windowInfo(win);
      if (info && !info.folders.some((f) => pathKey(f) === pathKey(cwd)))
        fail(`the VS Code window ${win} has ${info.folders.map(native).join(", ") || "no folder"} open, but Claude Code only opens sessions of the window's own folder. Open ${native(cwd)} in VS Code (code -n "${native(cwd)}") and run this there, or pass --cwd <that folder>.`, 2);
      const L = locksOf(c);
      let release: () => void;
      try {
        release = await L.take("session-open", 120_000, `open ${label}`);
      } catch {
        fail("the session-open lock was busy for 120 s", 6);
      }
      try {
        if (!has(a, "no-gate")) {
          const g = await gate(c);
          if (g.missing.length) fail(`NOT OPENED: ${g.line} — ${g.missing.join("; ")}`, 6);
        }
        const lay = await layout(win);
        if (lay.some((g) => g.tabs.some((t) => t.claude && t.label === label))) fail(`a Claude tab labeled "${label}" is already open`, 5);
        let id: string;
        try {
          id = await createLabeledSession(label, cwd, has(a, "trust"));
        } catch (e) {
          if (e instanceof TrustNeeded)
            fail(`trust: Claude Code has not been told to trust ${native(cwd)} yet. Ask the user; if they agree, run the same command with --trust (VixTab then answers "Yes, I trust this folder" once).`, 3);
          throw e;
        }
        const opened = await send("open", { session: id, label, prompt: str(a, "prompt"), focus: has(a, "focus"), here: has(a, "here") }, 240_000, win);
        if (opened.labeled === false) fail(`session=${id}: Claude Code kept opening an empty tab instead of the session (3 attempts) — the window may be overloaded; retry later`, 4);
        let entry: any = null;
        for (let i = 0; i < 40 && !entry; i++, await sleep(500)) entry = registry().find((s) => s.sessionId === id && s.entrypoint === "claude-vscode" && alive(s.pid)) ?? null;
        if (!entry) fail(`session=${id}: the tab (column ${opened.column}) did not start its Claude process`, 4);
        writeFileSync(recentFile(c), JSON.stringify([...recentOpens(c), { at: Date.now(), label }]));
        // SendMessage address: Claude Code 2.1.308 (checked on Windows) uses the /rename title (= label); 2.1.280 (Linux) the
        // auto-generated name. Print the one that should work as name=, and both for the fallback.
        const v = claudeVersion();
        const byLabel = !v || v[0] > 2 || (v[0] === 2 && (v[1] > 1 || v[2] >= 300));
        console.log(`session=${entry.sessionId} name=${byLabel ? label : (entry.name ?? label)} pid=${entry.pid} label=${label} auto_name=${entry.name ?? ""}`);
        const dup = registry().filter((s) => (s.name === label || s.name === entry.name) && s.pid !== entry.pid && alive(s.pid)).length;
        if (dup) console.log(`WARNING: another live session is also named ${label}/${entry.name}; use the [ref] shown by ListAgents`);
      } finally {
        release!();
      }
      return;
    }
    case "close": {
      const label = a._[0] ?? fail("usage: vixtab session close <label> [<pid>]", 2);
      const pid = Number(a._[1] ?? 0);
      const r = await send("close", { label }, 240_000, findWindow(norm(str(a, "cwd") ?? loadConfig().repo)));
      if (!r.closed) fail(`NOT CLOSED: ${r.matches} Claude tabs are labeled "${label}" (need exactly 1)`, 1);
      if (!pid) return void console.log(`Closed "${label}".`);
      for (let i = 0; i < 60; i++, await sleep(500)) if (!alive(pid)) return void console.log(`Closed "${label}" (pid ${pid} exited).`);
      fail(`tab closed but pid ${pid} still runs after 30 s`, 2);
    }
    default:
      console.log(HELP);
      if (action && action !== "help") process.exitCode = 2;
  }
}
