// vixtab session open | close | count | list — Claude Code tabs, one fresh session per ticket.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { has, parseArgs, str } from "../core/args.ts";
import { callerWindow, claudeTabCount, findWindow, layout, openTicketWindow, send, windowInfo, windows, windowsWithLabel } from "../core/bridge.ts";
import { TrustNeeded, claudeVersion, createLabeledSession, liveSessionsUnder, registry } from "../core/claude.ts";
import { isModelName, modelArg, sessionModel } from "../core/board.ts";
import { syncBoard, ticketOnBoard } from "../core/boardstore.ts";
import { type Config, isId, loadConfig } from "../core/config.ts";
import { locksOf } from "../core/mainline.ts";
import { alive } from "../core/proc.ts";
import { measure } from "../core/resources.ts";
import { logTab, openTabByLabel, readTabLog, ticketStatus } from "../core/tabs.ts";
import { platform } from "../platform/index.ts";
import { fail, native, norm, samePath, sleep } from "../core/util.ts";

export const HELP = `vixtab session — fresh, labeled Claude Code tabs in VS Code

  session open <label> [--cwd DIR] [--prompt TEXT] [--model M] [--focus] [--here] [--trust] [--no-gate]
        New session whose tab is named <label>, without stealing focus (unless --focus). No model turn: no tokens. --prompt
        pre-fills the input box (it is not sent). --model (sonnet, opus, haiku or an id such as claude-sonnet-5-5): the tab
        runs on that model; without it, on the Model line of the ticket <label> if it has one, else on the user's default
        (never changed: the model is set for this session only, at the cost of one one-word turn on it; "default" forces the
        default). Where the tab goes follows "tabs" in vixtab.config.json: by default the
        orchestrator's own window until it holds 6 Claude tabs (new columns up to 3, then stacked in the last one), then
        ticket windows (separate VS Code windows, 5 Claude tabs each; a new one only when all are full), because all tabs of
        one window share one renderer thread. --here: the caller's column. No trust prompt when the folder is open in a
        VS Code window running VixTab (VS Code trusts it); --trust answers the CLI's prompt in other cases.
        Prints: session=<uuid> name=<address> pid=<pid> label=<label> auto_name=<registry name> window=<extension host pid>
        … model=<model or default>
        Exit codes: 2 bad label · 3 Claude CLI problem (3 + "trust" = folder not trusted: re-run with --trust after the
        user agrees) · 4 tab problem (4 + "reload needed" = Claude Code's tab state is broken: the user must reload the
        window) · 5 label already open · 6 resource gate closed (queue the ticket, retry later)
  session close <label> [<pid>]    close the tab with exactly this label; with pid, wait until that CLI has exited.
        Tab actions run one at a time; closing a tab can take up to a minute while Claude Code shuts the session down.
        Exit codes: 1 no tab or several tabs with this label · 2 the CLI did not exit · 4 extension did not answer
  session count                    sessions of this repo, the resource gate ("open: yes" or what is missing), the Claude tabs
                                   of each VS Code window and the busiest renderer thread of each local VS Code window
  session list                     live Claude sessions of this repo (pid, name, session id, cwd)
  (every Claude tab of this machine by window, and the closed ones: vixtab tabs)

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

export async function gate(c: Config) {
  const n = liveSessionsUnder([c.repo, c.home]).length;
  const reserved = recentOpens(c).length * c.sessions.reserveMB;
  const g = await measure({ minFreeMB: c.sessions.minFreeRamMB, maxSwapMB: c.sessions.maxSwapMB, maxCommit: c.sessions.maxCommit, maxCpu: c.sessions.maxCpu }, reserved);
  if (c.sessions.max > 0 && n >= c.sessions.max) g.missing.unshift(`sessions ${n} ≥ max ${c.sessions.max}`);
  return { ...g, line: `sessions=${n}${c.sessions.max > 0 ? "/" + c.sessions.max : ""} ${g.line}` };
}

/**
 * Window for a new tab. VIXTAB_EXT_HOST_PID or --here ⇒ that / the caller's window as a column. Otherwise by the tabs policy
 * (vixtab.config.json "tabs"): the orchestrator's window while it holds fewer than inWindowMax Claude tabs (mode auto; columns up to
 * columnsMax, then stacked), then the ticket window with the fewest Claude tabs below perWindowMax, else a new ticket window; if that
 * cannot open, the caller's window.
 */
async function chooseWindow(c: Config, cwd: string, here: boolean): Promise<{ win: number; stack: boolean; note?: string }> {
  if (process.env.VIXTAB_EXT_HOST_PID) return { win: Number(process.env.VIXTAB_EXT_HOST_PID), stack: false };
  const caller = callerWindow();
  const base = caller || findWindow(cwd);
  if (here || c.tabs.mode === "columns") return { win: base, stack: false };
  const callerKind = windowInfo(base)?.kind ?? "main";
  // The orchestrator's own window first (user's rule, 25/10/2026: a new window for a handful of tabs is waste and clutter):
  // up to inWindowMax Claude tabs in all, new columns up to columnsMax, then stacked into the last column.
  if (c.tabs.mode === "auto" && callerKind !== "tickets") {
    const lay = await layout(base).catch(() => null);
    if (lay) {
      const n = lay.flatMap((g) => g.tabs).filter((t) => t.claude).length;
      if (n < c.tabs.inWindowMax) return { win: base, stack: lay.length >= c.tabs.columnsMax };
    }
  }
  let best = 0, fewest = Infinity;
  for (const w of windows().filter((x) => x.kind === "tickets" && x.pid !== base && x.folders.some((f) => samePath(f, cwd)))) {
    const n = await claudeTabCount(w.pid);
    if (n >= 0 && n < c.tabs.perWindowMax && n < fewest) [best, fewest] = [w.pid, n];
  }
  if (best) return { win: best, stack: true };
  try {
    return { win: await openTicketWindow(cwd), stack: true };
  } catch (e) {
    return { win: base, stack: false, note: `WARNING: could not open a ticket window (${(e as Error).message.split("\n")[0]}) — opened as a column instead` };
  }
}

export async function session(argv: string[]): Promise<void> {
  const [action, ...rest] = argv;
  const a = parseArgs(rest, ["cwd", "prompt", "model"]);
  switch (action) {
    case "count": {
      const c = loadConfig();
      const g = await gate(c);
      console.log(`${g.line} open: ${g.missing.length ? "no — " + g.missing.join("; ") : "yes"}`);
      const me = callerWindow();
      for (const w of windows())
        console.log(`window=${w.pid} kind=${w.kind ?? "main"} claude_tabs=${await claudeTabCount(w.pid)}${w.pid === me ? " (this window)" : ""} ${w.folders.map(native).join(", ")}`);
      const load = platform.rendererLoad();
      if (load.length) console.log(`vscode_renderers busiest_thread=${load.map((r) => `${r.pid}:${r.pct}%`).join(" ")}  (≥ ~90 % = that window's tabs lag)`);
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
      // --model, else the Model line of the ticket named <label> (on the board), else the user's default.
      const flag = modelArg(a);
      let ticketText: string | null = null;
      if (flag === undefined && isId(c, label)) {
        syncBoard(c);
        ticketText = ticketOnBoard(c, label)?.text ?? null;
      }
      const model = sessionModel(flag, ticketText);
      if (model && !isModelName(model)) fail(`the Model line of ${label} is not a model name: ${model}`, 2);
      const L = locksOf(c);
      let release: () => void;
      try {
        release = await L.take("session-open", 180_000, `open ${label}`);
      } catch {
        fail("the session-open lock was busy for 180 s", 6);
      }
      try {
        if (!has(a, "no-gate")) {
          const g = await gate(c);
          if (g.missing.length) fail(`NOT OPENED: ${g.line} — ${g.missing.join("; ")}`, 6);
        }
        // Labels must be unique across every window: close finds the tab by label.
        const holders = await windowsWithLabel(label);
        if (holders.length) fail(`a Claude tab labeled "${label}" is already open (window ${holders.join(", ")})`, 5);
        const target = await chooseWindow(c, cwd, has(a, "here"));
        const info = windowInfo(target.win);
        if (info && !info.folders.some((x) => samePath(x, cwd)))
          fail(`the VS Code window ${target.win} has ${info.folders.map(native).join(", ") || "no folder"} open, but Claude Code only opens sessions of the window's own folder. Open ${native(cwd)} in VS Code (code -n "${native(cwd)}") and run this there, or pass --cwd <that folder>.`, 2);
        let id: string;
        try {
          // The target window has the folder open and runs VixTab, so VS Code trusts it: no CLI trust prompt (see claude.ts).
          id = await createLabeledSession(label, cwd, has(a, "trust"), { vscodeTrusted: !!info, model });
        } catch (e) {
          if (e instanceof TrustNeeded)
            fail(`trust: Claude Code has not been told to trust ${native(cwd)} yet. Ask the user; if they agree, run the same command with --trust (VixTab then answers "Yes, I trust this folder" once).`, 3);
          throw e;
        }
        const opened = await send("open", { session: id, label, prompt: str(a, "prompt"), focus: has(a, "focus"), here: has(a, "here"), stack: target.stack }, 240_000, target.win);
        if (opened.labeled === false) fail(`session=${id}: Claude Code kept opening an empty tab instead of the session (3 attempts) — the window may be overloaded; retry later`, 4);
        // A busy machine can take well over 20 s before the tab has started its CLI.
        let entry: any = null;
        for (let i = 0; i < 90 && !entry; i++, await sleep(500)) entry = registry().find((x) => x.sessionId === id && x.entrypoint === "claude-vscode" && alive(x.pid)) ?? null;
        if (!entry) fail(`session=${id}: the tab (window ${target.win}, column ${opened.column}) did not start its Claude process within 45 s`, 4);
        writeFileSync(recentFile(c), JSON.stringify([...recentOpens(c), { at: Date.now(), label }]));
        logTab({ ev: "open", at: Date.now(), label, sessionId: entry.sessionId, pid: entry.pid, cwd, window: target.win, model: model ?? null });
        // SendMessage address: Claude Code 2.1.308 (checked on Windows) uses the /rename title (= label); 2.1.280 (Linux) the
        // auto-generated name. Print the one that should work as name=, and both for the fallback.
        const v = claudeVersion();
        const byLabel = !v || v[0] > 2 || (v[0] === 2 && (v[1] > 1 || v[2] >= 300));
        console.log(`session=${entry.sessionId} name=${byLabel ? label : (entry.name ?? label)} pid=${entry.pid} label=${label} auto_name=${entry.name ?? ""} window=${target.win}${windowInfo(target.win)?.kind === "tickets" ? " (ticket window)" : ""}${target.stack ? " stacked" : ""} model=${model ?? "default"}`);
        if (target.note) console.log(target.note);
        const dup = registry().filter((x) => (x.name === label || x.name === entry.name) && x.pid !== entry.pid && alive(x.pid)).length;
        if (dup) console.log(`WARNING: another live session is also named ${label}/${entry.name}; use the [ref] shown by ListAgents`);
      } finally {
        release!();
      }
      return;
    }
    case "close": {
      const label = a._[0] ?? fail("usage: vixtab session close <label> [<pid>]", 2);
      const pid = Number(a._[1] ?? 0);
      // The tab may live in the orchestrator's window or in any ticket window.
      const where = process.env.VIXTAB_EXT_HOST_PID ? [Number(process.env.VIXTAB_EXT_HOST_PID)] : await windowsWithLabel(label);
      if (where.length !== 1) fail(`NOT CLOSED: ${where.length ? `several windows (${where.join(", ")}) have` : "no window has"} a Claude tab labeled "${label}"`, 1);
      const r = await send("close", { label }, 240_000, where[0]);
      if (!r.closed) fail(`NOT CLOSED: ${r.matches} Claude tabs are labeled "${label}" (need exactly 1)`, 1);
      // History for the panel (vixtab tabs): the ticket status at closing time is the final one.
      const opened = openTabByLabel(readTabLog(), label);
      if (opened) logTab({ ev: "close", at: Date.now(), label, sessionId: opened.sessionId, status: ticketStatus(opened.cwd, label) });
      if (!pid) return void console.log(`Closed "${label}".`);
      for (let i = 0; i < 60; i++, await sleep(500)) if (!alive(pid)) return void console.log(`Closed "${label}" (pid ${pid} exited).`);
      fail(`tab closed but pid ${pid} still runs after 30 s`, 2);
    }
    default:
      console.log(HELP);
      if (action && action !== "help") process.exitCode = 2;
  }
}
