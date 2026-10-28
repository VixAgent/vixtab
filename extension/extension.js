// VixTab VS Code extension.
// 1. Bridge: executes tab commands that the `vixtab` CLI writes to ~/.cache/vixtab/commands/<pid>-<id>.cmd.json (pid = this
//    window's extension host), answering in <pid>-<id>.result.json. The window registers in ~/.cache/vixtab/windows/<pid>.json.
// 2. UI: status bar button and commands to start an orchestrator tab, set up the CLI and the Claude Code skills (every project, or per repository), run the doctor,
//    and create a playground. The CLI ships inside this extension (bin/), built for the platform of the .vsix.
const vscode = require("vscode");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const CACHE = path.join(os.homedir(), ".cache", "vixtab");
const COMMANDS = path.join(CACHE, "commands");
const WINDOWS = path.join(CACHE, "windows");
const WINDOW_FILE = path.join(WINDOWS, `${process.pid}.json`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXE = process.platform === "win32" ? ".exe" : "";
const INSTALLED = path.join(os.homedir(), ".vixtab", "bin", `vixtab${EXE}`);
const SETTINGS = "@ext:vixagent.vixtab";
const LEGACY_ID = "phanthaitrung.vixtab"; // this extension's ID up to 0.6.0

let out;
const LOGS = path.join(CACHE, "logs");
const LOG_FILE = path.join(LOGS, `ext-${process.pid}.log`);
function log(s) {
  const line = `[${new Date().toISOString()}] ${s}`;
  if (out) out.appendLine(line);
  try {
    fs.mkdirSync(LOGS, { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1 << 20) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Tabs ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const isClaudeTab = (t) => t.input instanceof vscode.TabInputWebview && /claudeVSCodePanel/.test(t.input.viewType);

function layout() {
  return vscode.window.tabGroups.all.map((g) => ({
    column: g.viewColumn,
    active: g.isActive,
    tabs: g.tabs.map((t) => ({ label: t.label, claude: isClaudeTab(t), active: t.isActive })),
  }));
}

const claudeTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs.filter(isClaudeTab).map((t) => ({ t, column: g.viewColumn })));

// Most Claude tabs VixTab opens in this window (the CLI reads it with every layout, so a change applies to the next tab).
function maxTabs() {
  const n = Math.floor(Number(vscode.workspace.getConfiguration("vixtab").get("maxTabsPerWindow", 6)));
  return n >= 1 ? n : 6;
}

// stack: put the tab into the last group instead of a new column (ticket windows keep one group of stacked tabs).
// max: the CLI's cap for this window. The Claude tabs are counted again here, inside the queue of tab actions, because tabs may
// have opened since the CLI counted them: at the cap, nothing opens and the CLI chooses another window.
let opening = 0; // > 0 while a tab is being opened: a ticket window must not close itself meanwhile
async function openSession(args) {
  opening++;
  try {
    return await openSessionNow(args);
  } finally {
    opening--;
  }
}
async function openSessionNow({ session, prompt, focus = false, here = false, stack = false, label, max = 0 }) {
  if (!UUID.test(session || "")) throw new Error("session must be a UUID");
  const held = claudeTabs().length;
  if (max > 0 && held >= max) {
    log(`open ${session}: not opened, this window holds ${held} Claude tabs (max ${max})`);
    return { full: true, held, max, layout: layout() };
  }
  for (let attempt = 1; ; attempt++) {
    const groups = vscode.window.tabGroups.all;
    const last = Math.max(...groups.map((g) => g.viewColumn));
    const column = here ? vscode.window.tabGroups.activeTabGroup.viewColumn || 1 : stack ? last : last + 1;
    // Count tabs by (column, label): Tab objects are not guaranteed to keep their identity between reads.
    const EMPTY = "Claude Code";
    const count = (lab) => claudeTabs().filter((x) => x.column === column && x.t.label === lab).length;
    const countAll = (lab) => claudeTabs().filter((x) => x.t.label === lab).length;
    const emptyBefore = count(EMPTY), wantedBefore = countAll(label || "");

    // claude-vscode.editor.open(sessionId, initialPrompt, viewColumn | showOptions, group, fullEditor, options) — Claude Code's
    // own command (not a public API; checked with Claude Code 2.1.280 and 2.1.308). initialPrompt only pre-fills the input.
    try {
      await vscode.commands.executeCommand("claude-vscode.editor.open", session, prompt || undefined, { viewColumn: column, preserveFocus: !focus }, undefined, undefined, { programmatic: "pin-to-panel" });
    } catch (err) {
      if (/disposed/i.test(String(err && err.message))) throw new Error("reload needed: Claude Code's tab state in this window is broken (\"Webview is disposed\"); reload the window (Developer: Reload Window) — this restarts the Claude sessions of this window");
      throw err;
    }
    if (!label) {
      await sleep(300);
      if (!here && !stack) await vscode.commands.executeCommand("workbench.action.evenEditorWidths");
      return { column, layout: layout() };
    }
    // The tab takes its label from the session title once Claude Code has loaded the session. A tab still called
    // "Claude Code" means it could not load it (busy extension host, session list not refreshed yet) and opened an EMPTY
    // conversation instead: close that one and try again.
    let ok = false;
    for (let i = 0; i < 40 && !ok; i++) {
      await sleep(250);
      ok = countAll(label) > wantedBefore;
    }
    // Only ever close a tab that is exactly an empty "Claude Code" conversation that appeared in the new column just now.
    const fresh = !ok && count(EMPTY) > emptyBefore ? claudeTabs().filter((x) => x.column === column && x.t.label === EMPTY).pop() : null;
    if (ok) {
      if (!here && !stack) await vscode.commands.executeCommand("workbench.action.evenEditorWidths");
      return { column, labeled: true, attempts: attempt, layout: layout() };
    }
    log(`open ${session}: tab did not show "${label}" (attempt ${attempt}${fresh ? ", an empty conversation opened instead: closing it" : ""})`);
    if (fresh) await closeWithTimeout(fresh.t);
    if (attempt >= 3) return { column, labeled: false, attempts: attempt, layout: layout() };
    await sleep(1500 * attempt);
  }
}

// Closing a Claude tab makes Claude Code shut its CLI down, which can take a minute (MCP servers closing). Wait for it: two
// Claude tabs disposed at the same moment can leave Claude Code 2.1.x with a disposed panel in its session map, after which
// every claude-vscode.editor.open fails with "Webview is disposed" until the window is reloaded.
async function closeWithTimeout(tab, ms = 120000) {
  const column = tab.group.viewColumn, label = tab.label;
  const before = claudeTabs().filter((x) => x.column === column && x.t.label === label).length;
  await Promise.race([vscode.window.tabGroups.close(tab), sleep(ms)]);
  for (let i = 0; i < 40 && claudeTabs().filter((x) => x.column === column && x.t.label === label).length >= before; i++) await sleep(250);
  await sleep(1000);
}

async function closeTab({ label }) {
  const matches = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => isClaudeTab(t) && t.label === label);
  if (matches.length !== 1) return { closed: false, matches: matches.length, layout: layout() };
  await closeWithTimeout(matches[0]);
  await vscode.commands.executeCommand("workbench.action.evenEditorWidths");
  return { closed: true, matches: 1, layout: layout() };
}

const ACTIONS = {
  layout: async () => ({ layout: layout(), maxTabs: maxTabs() }),
  open: openSession,
  close: closeTab,
  even: async () => {
    await vscode.commands.executeCommand("workbench.action.evenEditorWidths");
    return { layout: layout() };
  },
  join: async () => {
    await vscode.commands.executeCommand("workbench.action.joinAllGroups");
    return { layout: layout() };
  },
  ping: async () => ({ pid: process.pid }),
};

// ── Bridge ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const busy = new Set();
let queue = Promise.resolve(); // one tab-changing action at a time
const serial = (fn) => {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
};
async function handle(name) {
  const m = /^(\d+)-([A-Za-z0-9_-]+)\.cmd\.json$/.exec(name);
  if (!m || Number(m[1]) !== process.pid || busy.has(name)) return;
  busy.add(name);
  const cmdFile = path.join(COMMANDS, name);
  const resultFile = path.join(COMMANDS, `${m[1]}-${m[2]}.result.json`);
  let text;
  try {
    // fs.watch may report a file twice; the second time it is already gone.
    text = fs.readFileSync(cmdFile, "utf8");
    fs.unlinkSync(cmdFile);
  } catch {
    busy.delete(name);
    return;
  }
  let result;
  const t0 = Date.now();
  try {
    const cmd = JSON.parse(text);
    log(`${cmd.action} ${cmd.session || cmd.label || ""}: start (queued ${Math.max(0, Date.now() - Number(m[2].slice(0, 13)))} ms)`);
    const action = ACTIONS[cmd.action];
    if (!action) throw new Error(`unknown action "${cmd.action}"`);
    result = { ok: true, ...(await (cmd.action === "layout" || cmd.action === "ping" ? action(cmd) : serial(() => action(cmd)))) };
    log(`${cmd.action} ${cmd.session || cmd.label || ""}: ok in ${Date.now() - t0} ms`);
  } catch (e) {
    result = { ok: false, error: String((e && e.message) || e) };
    log(`command failed: ${result.error}`);
  } finally {
    busy.delete(name);
  }
  fs.writeFileSync(`${resultFile}.tmp`, JSON.stringify(result));
  fs.renameSync(`${resultFile}.tmp`, resultFile);
}

// A ticket window that VixTab opened closes itself once it has no Claude tab left — however the tabs were closed (by VixTab,
// by the user, by Claude Code). Only after it has held at least one Claude tab (a new window is empty for a few seconds), never
// while VixTab is opening a tab in it (a retry briefly closes an empty conversation), and only if still empty 5 s later.
let hadClaudeTab = false, closeTimer = null;
function watchTicketWindow(context) {
  if (!isTicketWindow()) return;
  const check = () => {
    const n = claudeTabs().length;
    if (n > 0) hadClaudeTab = true;
    if (closeTimer) clearTimeout(closeTimer), (closeTimer = null);
    if (n > 0 || !hadClaudeTab || opening > 0 || !vscode.workspace.getConfiguration("vixtab").get("closeEmptyTicketWindows", true)) return;
    closeTimer = setTimeout(() => {
      if (claudeTabs().length || opening > 0) return;
      log("no Claude tab left: closing this ticket window");
      try {
        fs.unlinkSync(workspaceFile());
      } catch {}
      void vscode.commands.executeCommand("workbench.action.closeWindow");
    }, 5000);
  };
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(check), vscode.window.tabGroups.onDidChangeTabGroups(check), { dispose: () => closeTimer && clearTimeout(closeTimer) });
  check();
}
const scan = () => {
  try {
    for (const f of fs.readdirSync(COMMANDS)) void handle(f);
  } catch {}
};

// A ticket window is a VS Code window that VixTab opened from <repo>/.vixtab/windows/<project>-tickets-N.code-workspace.
const workspaceFile = () => (vscode.workspace.workspaceFile && vscode.workspace.workspaceFile.scheme === "file" ? vscode.workspace.workspaceFile.fsPath : null);
const isTicketWindow = () => /[\\/]\.vixtab[\\/]windows[\\/][^\\/]+\.code-workspace$/i.test(workspaceFile() || "");

function registerWindow(context) {
  fs.mkdirSync(WINDOWS, { recursive: true });
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  const info = { pid: process.pid, folders, version: context.extension.packageJSON.version, at: new Date().toISOString(), kind: isTicketWindow() ? "tickets" : "main", workspaceFile: workspaceFile() };
  fs.writeFileSync(`${WINDOW_FILE}.tmp`, JSON.stringify(info));
  fs.renameSync(`${WINDOW_FILE}.tmp`, WINDOW_FILE);
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
let ctx;
function cliPath() {
  const bundled = path.join(ctx.extensionPath, "bin", `vixtab${EXE}`);
  if (fs.existsSync(bundled)) {
    if (!EXE) {
      try {
        fs.chmodSync(bundled, 0o755);
      } catch {}
    }
    return bundled;
  }
  return fs.existsSync(INSTALLED) ? INSTALLED : "vixtab";
}

// quiet: background reads for the side panel — nothing in the output channel unless they fail.
function runCli(args, cwd, quiet = false) {
  return new Promise((resolve) => {
    const env = { ...process.env, VIXTAB_EXT_HOST_PID: String(process.pid) };
    if (!quiet) log(`$ vixtab ${args.join(" ")}`);
    execFile(cliPath(), args, { cwd: cwd || os.homedir(), env, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      const text = `${stdout || ""}${stderr || ""}`.trim();
      if (text && !quiet) out.appendLine(text);
      resolve({ code, text, stdout: stdout || "" });
    });
  });
}

async function pickFolder() {
  const fs_ = vscode.workspace.workspaceFolders || [];
  if (!fs_.length) {
    vscode.window.showWarningMessage("VixTab: open a folder (a git repository) first.");
    return null;
  }
  if (fs_.length === 1) return fs_[0].uri.fsPath;
  const pick = await vscode.window.showQuickPick(fs_.map((f) => ({ label: f.name, description: f.uri.fsPath, f })), { placeHolder: "Orchestrate which folder?" });
  return pick ? pick.f.uri.fsPath : null;
}

// Skills scope (the user's choice): "allProjects" (default) = skills in ~/.claude/skills, every Claude Code session of every
// project can use VixTab; "perProject" = only the repositories the user orchestrates get them (<repo>/.claude/skills, kept out
// of git). The CLI saves the choice in ~/.vixtab/config.json; the setting wins when the user has set it explicitly.
const needsSetup = () => !(fs.existsSync(INSTALLED) || fs.existsSync(path.join(os.homedir(), ".vixtab", "bin", "vixtab")));
const PREFS = path.join(os.homedir(), ".vixtab", "config.json");
function scope() {
  const s = vscode.workspace.getConfiguration("vixtab").inspect("skillsScope");
  const explicit = (s && (s.workspaceFolderValue || s.workspaceValue || s.globalValue)) || null;
  if (explicit) return explicit === "perProject" ? "project" : "global";
  try {
    const saved = JSON.parse(fs.readFileSync(PREFS, "utf8")).skillsScope;
    if (saved === "project" || saved === "global") return saved;
  } catch {}
  return "global";
}

// Usage limit (percent): at or above it on the Claude account's 5-hour session or week, the orchestrator pauses its ticket
// sessions and new tabs do not open. The CLI keeps it in ~/.vixtab/config.json for every project; a setting the user has set
// explicitly is copied there (`vixtab usage limit <n>`).
function usageLimitSetting() {
  const s = vscode.workspace.getConfiguration("vixtab").inspect("usageLimit");
  const v = s && (s.workspaceFolderValue ?? s.workspaceValue ?? s.globalValue);
  return Number.isInteger(v) && v >= 1 && v <= 100 ? v : null;
}
async function syncUsageLimit(announce) {
  const n = usageLimitSetting();
  if (n === null) return;
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(PREFS, "utf8")).usageLimit;
  } catch {}
  if (saved === n) return;
  const r = await runCli(["usage", "limit", String(n)], undefined, !announce);
  if (r.code !== 0) out.show(true);
  else if (announce) vscode.window.setStatusBarMessage(`VixTab: usage limit = ${n} % for every project`, 8000);
}

async function setup(silent, chosen) {
  const sc = chosen || scope();
  const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "VixTab: setting up…" }, () => runCli(["setup", "--scope", sc]));
  if (r.code !== 0) {
    out.show(true);
    vscode.window.showErrorMessage("VixTab setup failed — see the VixTab output.");
    return false;
  }
  if (!silent)
    vscode.window.showInformationMessage(
      sc === "global"
        ? "VixTab is ready for every project: click 'VixTab' in the status bar of any repository, or ask Claude Code to use VixTab."
        : "VixTab is ready: click 'VixTab' in the status bar of a repository — that repository gets the skills, other projects are untouched.",
    );
  return true;
}

async function orchestrate() {
  const folder = await pickFolder();
  if (!folder) return;
  if (needsSetup() && !(await setup(true))) return;
  const sk = await runCli(scope() === "global" ? ["skills", "install", "--global"] : ["skills", "install"], folder);
  if (sk.code !== 0) {
    out.show(true);
    vscode.window.showErrorMessage(`VixTab: could not install the Claude Code skills for ${folder} (is it a git repository?) — see the VixTab output.`);
    return;
  }
  const taken = new Set(vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter(isClaudeTab).map((t) => t.label));
  let label = "Orchestrator";
  for (let i = 2; taken.has(label); i++) label = `Orchestrator ${i}`;
  const prompt = vscode.workspace.getConfiguration("vixtab").get("orchestratorPrompt") || "/vixtab-orchestrate ";
  const open = (trust) =>
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `VixTab: opening "${label}"…` }, () =>
      runCli(["session", "open", label, "--cwd", folder, "--here", "--focus", "--no-gate", "--prompt", prompt, ...(trust ? ["--trust"] : [])], folder),
    );
  let r = await open(false);
  if (r.code === 3 && /^trust:/m.test(r.text)) {
    const yes = "Trust folder and continue";
    const ans = await vscode.window.showWarningMessage(
      `Claude Code has not been told to trust this folder yet:\n${folder}\n\nVixTab opens Claude sessions here, so Claude Code asks once whether you trust the files in this folder (its settings may run commands). Trust it?`,
      { modal: true },
      yes,
    );
    if (ans !== yes) return;
    r = await open(true);
  }
  if (r.code !== 0) {
    out.show(true);
    vscode.window.showErrorMessage(`VixTab: could not open the orchestrator tab (exit ${r.code}) — see the VixTab output.`);
    return;
  }
  vscode.window.setStatusBarMessage(`VixTab: "${label}" is ready — type your goal after ${prompt.trim()} and press Enter.`, 15000);
}

async function doctor() {
  const folder = (vscode.workspace.workspaceFolders || [])[0];
  out.show(true);
  await runCli(["doctor"], folder ? folder.uri.fsPath : undefined);
}

async function showStatus() {
  const folder = (vscode.workspace.workspaceFolders || [])[0];
  out.show(true);
  await runCli(["status"], folder ? folder.uri.fsPath : undefined);
}

// Quick, local answer for the status-bar tooltip: is VixTab usable in this folder, and which versions.
function skillVersion(file) {
  try {
    const m = /vixtab-managed v(\d+\.\d+\.\d+)/.exec(fs.readFileSync(file, "utf8"));
    return m ? m[1] : "older than 0.4.1";
  } catch {
    return null;
  }
}
function tooltip(version) {
  const folder = (vscode.workspace.workspaceFolders || [])[0];
  const claude = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const proj = folder ? skillVersion(path.join(folder.uri.fsPath, ".claude", "skills", "vixtab-orchestrate", "SKILL.md")) : null;
  const glob = skillVersion(path.join(claude, "skills", "vixtab-orchestrate", "SKILL.md"));
  const where = proj ? `this project's skills v${proj}` : glob ? `skills for every project v${glob}` : null;
  const md = new vscode.MarkdownString(
    [
      `**VixTab ${version}** (extension in this window)`,
      "",
      where ? `✔ This project can use VixTab — ${where}.` : "✘ This project's Claude Code sessions do not see VixTab yet — click to set it up here.",
      `Skills scope: ${scope() === "global" ? "every project" : "only chosen projects"} · CLI: ${needsSetup() ? "not installed" : "~/.vixtab/bin"}`,
      "",
      "Click: start an orchestrator tab · *VixTab: Show status* for every version",
    ].join("\n\n"),
  );
  return md;
}

async function createPlayground() {
  const dir = await vscode.window.showInputBox({ prompt: "Create the VixTab playground in", value: path.join(os.homedir(), "vixtab-playground") });
  if (!dir) return;
  const r = await runCli(["playground", "create", dir]);
  if (r.code !== 0) {
    out.show(true);
    vscode.window.showErrorMessage("VixTab: could not create the playground — see the VixTab output.");
    return;
  }
  const openIt = "Open in new window";
  if ((await vscode.window.showInformationMessage(`Playground created in ${dir}.`, openIt)) === openIt)
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(path.join(dir, "project")), { forceNewWindow: true });
}

// ── Side panel (Activity Bar) ──────────────────────────────────────────────────────────────────────────────────────────────
// VixTab icon in the left Activity Bar, like Claude Code's: start an orchestrator, see whether this project can use VixTab and
// with which versions, browse the board's tickets (click one to read it), open the playground, doctor and settings.
// id: keeps a node's expanded/collapsed state across refreshes; collapsed: starts collapsed; context: for view/item/context menus.
const node = (label, o = {}) => {
  const state = !o.children ? vscode.TreeItemCollapsibleState.None : o.collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded;
  const t = new vscode.TreeItem(label, state);
  if (o.id) t.id = o.id;
  if (o.icon) t.iconPath = new vscode.ThemeIcon(o.icon, o.color ? new vscode.ThemeColor(o.color) : undefined);
  if (o.description) t.description = o.description;
  if (o.tooltip) t.tooltip = o.tooltip;
  if (o.context) t.contextValue = o.context;
  if (o.command) t.command = { command: o.command, title: label, arguments: o.args || [] };
  t.children = o.children;
  return t;
};
const TICKET_ICON = [
  [/^✅/, "pass", "testing.iconPassed"],
  [/^⏳/, "sync", "charts.blue"],
  [/^❓/, "question", "charts.yellow"],
  [/^☐/, "circle-large-outline", undefined],
];

// Tabs: every Claude tab of this machine by VS Code window (`vixtab tabs --json`), and the tabs VixTab opened that have closed.
const TAB_ICON = { busy: ["sync~spin", "charts.blue"], idle: ["circle-large-outline", undefined], asking: ["question", "charts.yellow"] };
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const shortStatus = (s) => s.replace(/\s*\(.*\)\s*$/, ""); // "⏳ DOING (T-006)" → "⏳ DOING"
function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60);
  return s < 60 ? `${s}s` : m < 60 ? `${m}m` : h < 24 ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}
const when = (t) => new Date(t).toLocaleString();

function tabsSection(o, loads) {
  if (!o || o.error) return node("Tabs", { id: "tabs", icon: "warning", color: "charts.yellow", description: "could not read", tooltip: o ? o.error : "" });
  const s = o.summary, g = s.gate, now = Date.now();
  const load = (w) => (loads && loads.windows[w.pid]) || w.load;
  const busiest = (loads && loads.busiest) || s.busiestRenderer;
  const tip = [
    s.text,
    g ? `Resource gate: ${g.open === null ? "no project here (RAM and CPU only)" : g.open ? "a new tab can open" : `closed — ${g.missing.join("; ")}`}` : "",
    g ? g.line : "",
    busiest ? `Busiest renderer: ${busiest.pct} % (pid ${busiest.pid}${busiest.window ? `, the workbench of window ${busiest.window}` : ", a webview renderer, where Claude tabs draw; VS Code does not say of which window"}). ≥ ~90 % = tabs lag.` : "Renderer load: measured at most once a minute while this panel is visible, and on Refresh.",
    `Windows without the VixTab extension are not listed${s.unlisted ? ` (${plural(s.unlisted, "Claude tab")} there)` : ""}.`,
  ].filter(Boolean).join("\n");
  const tabNode = (t) => {
    const [icon, color] = TAB_ICON[t.state] || ["circle-large-outline"];
    const tk = t.ticket ? shortStatus(t.ticket.status) + (/^✅/.test(t.ticket.status) ? " — waiting to be closed" : "") : "";
    const desc = [`${t.state}${t.since ? " " + duration(now - t.since) : ""}`, tk, t.model].filter(Boolean).join(" · ");
    const tooltip = [
      t.ticket ? `${t.ticket.id}  ${t.ticket.title}\n${t.ticket.status}` : t.label,
      `State: ${t.state}${t.since ? ` since ${when(t.since)}` : ""}`,
      t.model ? `Model: ${t.model}` : "",
      `Project: ${t.repo || t.cwd}`,
      `Session: ${t.sessionId} · pid ${t.pid}`,
      t.openedAt ? `Opened by VixTab: ${when(t.openedAt)}` : t.startedAt ? `Started: ${when(t.startedAt)}` : "",
      t.ticket ? "Click to read the ticket." : "",
    ].filter(Boolean).join("\n");
    return node(t.label, { id: `tab:${t.sessionId}`, icon, color, description: desc, tooltip, command: t.ticket ? "vixtab.showTicket" : undefined, args: t.ticket ? [t.ticket.id, t.repo] : [] });
  };
  const winNode = (w) => {
    const l = load(w), hot = l && l.pct >= 90;
    const desc = [w.kind === "tickets" ? "ticket window" : "main window", plural(w.tabs.length, "Claude tab"), l ? `renderer ${l.pct} %` : ""].filter(Boolean).join(" · ");
    const tooltip = [w.folders.join("\n") || "(no folder)", `Extension host pid ${w.pid} · VixTab v${w.version}`, l ? `Workbench renderer (pid ${l.renderer}): busiest thread ${l.pct} %${hot ? " — this window's tabs lag" : ""}` : ""].filter(Boolean).join("\n");
    return node(w.project, { id: `win:${w.pid}`, icon: hot ? "warning" : "window", color: hot ? "charts.yellow" : undefined, description: desc, tooltip, children: w.tabs.length ? w.tabs.map(tabNode) : undefined });
  };
  const closed = o.closed.map((c) =>
    node(c.label, {
      id: `closed:${c.sessionId}:${c.closedAt}`,
      icon: c.status && /^✅/.test(c.status) ? "pass" : "circle-slash",
      color: c.status && /^✅/.test(c.status) ? "testing.iconPassed" : undefined,
      description: [c.project, `ran ${duration(c.ranMs)}`, `closed ${duration(now - c.closedAt)} ago`, c.status ? shortStatus(c.status) : ""].filter(Boolean).join(" · "),
      tooltip: [c.label, c.status || "", `Project: ${c.cwd}`, c.model ? `Model: ${c.model}` : "", `Opened: ${when(c.openedAt)}`, `Closed: ${when(c.closedAt)}${c.how === "gone" ? " (seen gone: closed outside VixTab)" : ""}`, `Session: ${c.sessionId}`].filter(Boolean).join("\n"),
    }),
  );
  return node("Tabs", {
    id: "tabs",
    icon: g && g.open === false ? "warning" : "layers",
    color: g && g.open === false ? "charts.yellow" : undefined,
    description: s.text,
    tooltip: tip,
    children: [
      ...o.windows.map(winNode),
      node("Finished and closed", { id: "closed", icon: "history", description: o.closed.length ? `${o.closed.length}` : "none yet", collapsed: true, context: "vixtab.closedTabs", tooltip: "Tabs VixTab opened that have closed, newest first (last 50)", children: closed.length ? closed : undefined }),
    ],
  });
}

// Claude usage: the account's 5-hour session and week (`vixtab usage --json`), the limit, and the reset times.
const isMain = (l) => l.kind === "session" || l.kind === "week";
// Reset times come a few ms before or after the minute: show the nearest minute.
const atMinute = (t) => new Date(Math.round(t / 60000) * 60000).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
function usageSection(u) {
  const base = { id: "usage", command: "vixtab.showUsage" };
  if (!u) return node("Claude usage", { ...base, icon: "dashboard", description: "reading…" });
  if (u.error)
    return node("Claude usage", { ...base, icon: "dashboard", description: "unknown", tooltip: `${u.error}\n\nThe usage guard needs Claude Code logged in with a claude.ai plan. Click to read again.` });
  const main = u.limits.filter(isMain);
  const over = u.over && u.over.length > 0, near = main.some((l) => l.percent >= u.limit - 10);
  const tooltip = [
    `${u.account} · ${u.plan}`,
    ...u.limits.map((l) => `${l.label}: ${Math.floor(l.percent)} %${l.resetsAt ? ` — resets ${atMinute(l.resetsAt)}` : ""}`),
    ...(u.extra ? [`Extra usage: ${u.extra.enabled ? "on" : "off"}`] : []),
    "",
    `Usage limit: ${u.limit} % (Settings ▸ VixTab: Usage Limit). At or above it on the 5-hour session or the week, the orchestrator pauses its ticket sessions and reopens them when the limit resets; new tabs do not open meanwhile.`,
    u.stale ? `Read ${when(u.at)}; a newer reading failed (${u.stale}). Click to read again.` : `Read ${when(u.at)}. Click to read again.`,
  ].join("\n");
  return node("Claude usage", {
    ...base,
    icon: over ? "warning" : "dashboard",
    color: over ? "charts.red" : near ? "charts.yellow" : undefined,
    description:
      main.map((l) => `${l.kind === "session" ? "5h" : "week"} ${Math.floor(l.percent)} %`).join(" · ") +
      (over ? ` — at the ${u.limit} % limit` : "") +
      (u.stale ? ` (as of ${new Date(u.at).toLocaleTimeString(undefined, { timeStyle: "short" })})` : ""),
    tooltip,
  });
}

class Panel {
  constructor() {
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
    this.usage = null; // { at, o } — o: the last `vixtab usage --json` ({ error } when unknown)
    this.board = null; // { at, folder, ok, tickets, error }
    this.tabs = null; // last `vixtab tabs --json`, or { error }
    this.loads = null; // { at, windows: { [extension host pid]: load }, busiest } from the last `vixtab tabs --json --load`
    this.running = {};
  }
  refresh(full) {
    if (full) this.board = null;
    this.changed.fire();
  }
  // A cheap read (load = false) or one that samples renderer load for a few seconds; one of each at a time.
  async fetchTabs(load) {
    const k = load ? "load" : "tabs";
    if (this.running[k]) return false;
    this.running[k] = true;
    try {
      const folder = ((vscode.workspace.workspaceFolders || [])[0] || {}).uri;
      const r = await runCli(["tabs", "--json", ...(load ? ["--load"] : [])], folder ? folder.fsPath : undefined, true);
      let o = null;
      try {
        o = JSON.parse(r.stdout);
      } catch {}
      if (o && o.summary) {
        if (load) this.loads = { at: Date.now(), windows: Object.fromEntries(o.windows.filter((w) => w.load).map((w) => [w.pid, w.load])), busiest: o.summary.busiestRenderer };
        if (!this.tabs || this.tabs.error || o.at >= this.tabs.at) this.tabs = o;
      } else if (!this.tabs || this.tabs.error) this.tabs = { error: r.text.split("\n")[0] || "vixtab tabs gave no answer" };
      return true;
    } finally {
      this.running[k] = false;
    }
  }
  pollTabs(load) {
    void this.fetchTabs(load).then((done) => done && this.changed.fire());
  }
  getTreeItem(e) {
    return e;
  }
  // Every window shows the same account: the CLI shares one reading (4 min) between windows and projects.
  async loadUsage(fresh) {
    if (!fresh && this.usage && Date.now() - this.usage.at < 240000) return this.usage.o;
    const r = await runCli(["usage", "--json", "--max-age", fresh ? "0" : "240"], undefined, true);
    let o = null;
    try {
      o = JSON.parse(r.stdout);
    } catch {}
    this.usage = { at: Date.now(), o: o || { error: r.text.split("\n")[0] || "vixtab usage gave no answer" } };
    return this.usage.o;
  }
  async loadBoard(folder) {
    if (this.board && this.board.folder === folder && Date.now() - this.board.at < 60000) return this.board;
    const r = await runCli(["ticket", "list", "--json"], folder, true);
    let tickets = null;
    try {
      tickets = JSON.parse(r.stdout);
    } catch {}
    this.board = { at: Date.now(), folder, ok: r.code === 0 && Array.isArray(tickets), tickets: tickets || [], error: r.text.split("\n")[0] };
    return this.board;
  }
  async getChildren(e) {
    if (e) return e.children || [];
    const folder = ((vscode.workspace.workspaceFolders || [])[0] || {}).uri;
    const dir = folder ? folder.fsPath : null;
    const version = ctx.extension.packageJSON.version;
    const claude = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    const proj = dir ? skillVersion(path.join(dir, ".claude", "skills", "vixtab-orchestrate", "SKILL.md")) : null;
    const glob = skillVersion(path.join(claude, "skills", "vixtab-orchestrate", "SKILL.md"));
    const ready = !needsSetup() && (proj || glob);
    const rows = [node("Start orchestrator", { icon: "rocket", command: "vixtab.orchestrate", tooltip: "Open an Orchestrator tab for this folder" })];
    if (!dir) rows.push(node("Open a folder (a git repository) to use VixTab", { icon: "folder-opened", command: "vscode.openFolder" }));
    else if (ready)
      rows.push(node("This project can use VixTab", { icon: "pass-filled", color: "testing.iconPassed", description: proj ? `own skills v${proj}` : `skills for every project v${glob}`, command: "vixtab.status", tooltip: "Show every version (vixtab status)" }));
    else
      rows.push(node("Not set up for this project", { icon: "warning", color: "charts.yellow", description: "click to set it up", command: "vixtab.enableHere", tooltip: needsSetup() ? "Installs the vixtab command and the Claude Code skills" : "Adds the Claude Code skills for this project" }));
    if (dir && !needsSetup()) {
      const b = await this.loadBoard(dir);
      if (b.ok && b.tickets.length) {
        const open = b.tickets.filter((t) => !/^✅/.test(t.status)).length;
        rows.push(
          node("Board", {
            icon: "checklist",
            description: `${b.tickets.length} ticket(s) · ${open} not done`,
            children: b.tickets.map((t) => {
              const [, icon, color] = TICKET_ICON.find(([re]) => re.test(t.status)) || [null, "circle-large-outline"];
              return node(`${t.id}  ${t.title}`, { icon, color, description: t.status.replace(/^\S+\s*/, ""), command: "vixtab.showTicket", args: [t.id], tooltip: `${t.status}${t.after && t.after.length ? ` · after ${t.after.join(", ")}` : ""}` });
            }),
          }),
        );
      } else rows.push(node("Board", { icon: "checklist", description: b.ok ? "empty" : "none yet — the orchestrator creates it", tooltip: b.ok ? "" : b.error }));
    }
    rows.push(usageSection(await this.loadUsage(false)));
    if (!this.tabs) await this.fetchTabs(false);
    rows.push(tabsSection(this.tabs, this.loads));
    rows.push(
      node("Versions", { icon: "versions", description: `extension v${version}`, command: "vixtab.status", tooltip: "CLI, extension in each window, skills, board (vixtab status)" }),
      node("Create playground", { icon: "beaker", command: "vixtab.createPlayground", tooltip: "A sandbox with five sample tickets" }),
      node("Run doctor", { icon: "pulse", command: "vixtab.doctor" }),
      node("Settings", { icon: "gear", description: `${scope() === "global" ? "skills: every project" : "skills: chosen projects"} · usage limit ${(this.usage && this.usage.o && this.usage.o.limit) || usageLimitSetting() || 96} %`, command: "workbench.action.openSettings", args: [SETTINGS] }),
    );
    return rows;
  }
}

async function enableHere(panel) {
  const folder = await pickFolder();
  if (!folder) return;
  if (needsSetup() && !(await setup(true))) return;
  const r = await runCli(scope() === "global" ? ["skills", "install", "--global"] : ["skills", "install"], folder);
  if (r.code !== 0) {
    out.show(true);
    vscode.window.showErrorMessage(`VixTab: could not set up ${folder} — see the VixTab output.`);
  } else vscode.window.setStatusBarMessage("VixTab: this project can use VixTab now.", 8000);
  panel.refresh(true);
}

// repo: the ticket's project when it is not this window's (a tab of another project in the Tabs section).
async function showTicket(id, repo) {
  const folder = ((vscode.workspace.workspaceFolders || [])[0] || {}).uri;
  const r = await runCli(["ticket", "show", id], repo || (folder ? folder.fsPath : undefined), true);
  const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: r.code === 0 ? r.stdout : `Could not read ${id}:\n\n${r.text}` });
  await vscode.window.showTextDocument(doc, { preview: true });
}

// ── Activation ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The old phanthaitrung.vixtab in the same window would register the same commands and answer the same bridge files: remove
// it, and leave the window to it until it is reloaded.
async function retireLegacy() {
  try {
    await vscode.commands.executeCommand("workbench.extensions.uninstallExtension", LEGACY_ID);
  } catch (e) {
    log(`could not uninstall ${LEGACY_ID}: ${e && e.message ? e.message : e}`); // another window did it already, or VS Code refused
  }
  const reload = "Reload Window";
  const a = await vscode.window.showInformationMessage(`VixTab is now vixagent.vixtab: the old extension (${LEGACY_ID}) has been removed. Reload this window to switch to the new one.`, reload);
  if (a === reload) await vscode.commands.executeCommand("workbench.action.reloadWindow");
}

function activate(context) {
  out = vscode.window.createOutputChannel("VixTab");
  context.subscriptions.push(out);
  if (vscode.extensions.getExtension(LEGACY_ID)) {
    log(`${LEGACY_ID} is still loaded in window ${process.pid}: removing it, inactive until the window is reloaded`);
    void retireLegacy();
    return;
  }
  ctx = context;
  fs.mkdirSync(COMMANDS, { recursive: true });
  registerWindow(context);
  watchTicketWindow(context);
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => registerWindow(context)));
  const w = fs.watch(COMMANDS, (_e, f) => f && void handle(String(f)));
  const poll = setInterval(scan, 2000); // fs.watch can miss events on network and remote file systems
  context.subscriptions.push({ dispose: () => (w.close(), clearInterval(poll)) });
  scan();

  const panel = new Panel();
  const view = vscode.window.createTreeView("vixtab.panel", { treeDataProvider: panel });
  const tick = setInterval(() => view.visible && panel.refresh(true), 60000); // the board changes while sessions work
  // Tabs: a cheap read every 5 s while the panel is visible; renderer load (it samples for seconds) at most once a minute.
  const tabsTick = setInterval(() => {
    if (!view.visible) return;
    panel.pollTabs(false);
    if (!panel.loads || Date.now() - panel.loads.at >= 60000) panel.pollTabs(true);
  }, 5000);
  context.subscriptions.push(
    view,
    { dispose: () => (clearInterval(tick), clearInterval(tabsTick)) },
    view.onDidChangeVisibility((e) => e.visible && (panel.refresh(false), panel.pollTabs(false))),
    vscode.window.onDidChangeWindowState((s) => s.focused && view.visible && panel.refresh(false)),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("vixtab") && panel.refresh(false)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => panel.refresh(true)),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("vixtab.orchestrate", orchestrate),
    vscode.commands.registerCommand("vixtab.setup", () => setup(false)),
    vscode.commands.registerCommand("vixtab.doctor", doctor),
    vscode.commands.registerCommand("vixtab.status", showStatus),
    vscode.commands.registerCommand("vixtab.refresh", () => (panel.refresh(true), panel.pollTabs(false), panel.pollTabs(true))),
    vscode.commands.registerCommand("vixtab.clearClosedTabs", async () => {
      await runCli(["tabs", "clear"], undefined, true);
      panel.pollTabs(false);
    }),
    vscode.commands.registerCommand("vixtab.enableHere", () => enableHere(panel)),
    vscode.commands.registerCommand("vixtab.showTicket", showTicket),
    vscode.commands.registerCommand("vixtab.showUsage", async () => {
      out.show(true);
      await runCli(["usage", "--max-age", "0"]);
      panel.usage = null; // the next panel read takes the reading the CLI just made
      panel.refresh(false);
    }),
    vscode.commands.registerCommand("vixtab.openSettings", () => vscode.commands.executeCommand("workbench.action.openSettings", SETTINGS)),
    vscode.commands.registerCommand("vixtab.createPlayground", createPlayground),
    vscode.commands.registerCommand("vixtab.evenColumns", () => vscode.commands.executeCommand("workbench.action.evenEditorWidths")),
  );

  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  item.text = "$(rocket) VixTab";
  item.command = "vixtab.orchestrate";
  const showItem = () => {
    item.tooltip = tooltip(context.extension.packageJSON.version);
    return vscode.workspace.getConfiguration("vixtab").get("statusBar") && (vscode.workspace.workspaceFolders || []).length && !isTicketWindow() ? item.show() : item.hide();
  };
  // The tooltip reads the skill files: refresh it now and then (skills can be installed or removed from a terminal).
  const refresh = setInterval(showItem, 30000);
  context.subscriptions.push({ dispose: () => clearInterval(refresh) });
  showItem();
  context.subscriptions.push(item, vscode.workspace.onDidChangeConfiguration(showItem), vscode.workspace.onDidChangeWorkspaceFolders(showItem));

  // Changing the scope setting applies it at once (skills installed for every project, or removed from ~/.claude/skills).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      // Every window gets the event; the focused one (where the setting was changed) applies it.
      if (!e.affectsConfiguration("vixtab.skillsScope") || needsSetup() || !vscode.window.state.focused) return;
      void runCli(["skills", "scope", scope()]).then((r) => (r.code === 0 ? vscode.window.setStatusBarMessage(`VixTab: skills scope = ${scope() === "global" ? "every project" : "only orchestrated repositories"}`, 8000) : out.show(true)));
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("vixtab.usageLimit") || !vscode.window.state.focused) return;
      void syncUsageLimit(true).then(() => ((panel.usage = null), panel.refresh(false))); // the panel shows the limit
    }),
  );
  void syncUsageLimit(false); // a limit set in the settings before this version, or on another machine through Settings Sync

  const key = `vixtab.setupAsked.${context.extension.packageJSON.version}`;
  if (needsSetup() && !isTicketWindow() && !context.globalState.get(key)) {
    void context.globalState.update(key, true);
    const all = "Set up for every project", some = "Only projects I choose";
    void vscode.window
      .showInformationMessage(
        "VixTab: finish setup? It installs the `vixtab` command (~/.vixtab/bin) and the Claude Code skills — for every project (any Claude Code session can then use VixTab), or only for the repositories where you click VixTab. You can change this later in Settings ▸ VixTab: Skills Scope.",
        all,
        some,
        "Not now",
      )
      .then(async (a) => {
        if (a !== all && a !== some) return;
        await vscode.workspace.getConfiguration("vixtab").update("skillsScope", a === all ? "allProjects" : "perProject", vscode.ConfigurationTarget.Global);
        await setup(false, a === all ? "global" : "project");
      });
  }
  log(`VixTab ${context.extension.packageJSON.version} active in window ${process.pid}`);
}

function deactivate() {
  if (!ctx) return; // stayed inactive (retireLegacy): the window file is the old extension's
  try {
    fs.unlinkSync(WINDOW_FILE);
  } catch {}
}

module.exports = { activate, deactivate };
