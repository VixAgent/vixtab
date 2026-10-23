// VixTab VS Code extension.
// 1. Bridge: executes tab commands that the `vixtab` CLI writes to ~/.cache/vixtab/commands/<pid>-<id>.cmd.json (pid = this
//    window's extension host), answering in <pid>-<id>.result.json. The window registers in ~/.cache/vixtab/windows/<pid>.json.
// 2. UI: status bar button and commands to start an orchestrator tab, set up the CLI + Claude Code skills, run the doctor,
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

async function openSession({ session, prompt, focus = false, here = false, label }) {
  if (!UUID.test(session || "")) throw new Error("session must be a UUID");
  for (let attempt = 1; ; attempt++) {
    const groups = vscode.window.tabGroups.all;
    const column = here ? vscode.window.tabGroups.activeTabGroup.viewColumn || 1 : Math.max(...groups.map((g) => g.viewColumn)) + 1;
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
      if (!here) await vscode.commands.executeCommand("workbench.action.evenEditorWidths");
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
      if (!here) await vscode.commands.executeCommand("workbench.action.evenEditorWidths");
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
  layout: async () => ({ layout: layout() }),
  open: openSession,
  close: closeTab,
  even: async () => {
    await vscode.commands.executeCommand("workbench.action.evenEditorWidths");
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
const scan = () => {
  try {
    for (const f of fs.readdirSync(COMMANDS)) void handle(f);
  } catch {}
};

function registerWindow(context) {
  fs.mkdirSync(WINDOWS, { recursive: true });
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  fs.writeFileSync(`${WINDOW_FILE}.tmp`, JSON.stringify({ pid: process.pid, folders, version: context.extension.packageJSON.version, at: new Date().toISOString() }));
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

function runCli(args, cwd) {
  return new Promise((resolve) => {
    const env = { ...process.env, VIXTAB_EXT_HOST_PID: String(process.pid) };
    log(`$ vixtab ${args.join(" ")}`);
    execFile(cliPath(), args, { cwd: cwd || os.homedir(), env, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      const text = `${stdout || ""}${stderr || ""}`.trim();
      if (text) out.appendLine(text);
      resolve({ code, text });
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

function needsSetup() {
  const skill = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "skills", "vixtab-orchestrate", "SKILL.md");
  return !(fs.existsSync(INSTALLED) || fs.existsSync(path.join(os.homedir(), ".vixtab", "bin", "vixtab"))) || !fs.existsSync(skill);
}

async function setup(silent) {
  const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "VixTab: setting up…" }, () => runCli(["setup"]));
  if (r.code !== 0) {
    out.show(true);
    vscode.window.showErrorMessage("VixTab setup failed — see the VixTab output.");
    return false;
  }
  if (!silent) vscode.window.showInformationMessage("VixTab is ready: the vixtab command and the Claude Code skills are installed. Click 'VixTab' in the status bar to start orchestrating.");
  return true;
}

async function orchestrate() {
  const folder = await pickFolder();
  if (!folder) return;
  if (needsSetup() && !(await setup(true))) return;
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

// ── Activation ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
function activate(context) {
  ctx = context;
  out = vscode.window.createOutputChannel("VixTab");
  context.subscriptions.push(out);
  fs.mkdirSync(COMMANDS, { recursive: true });
  registerWindow(context);
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => registerWindow(context)));
  const w = fs.watch(COMMANDS, (_e, f) => f && void handle(String(f)));
  const poll = setInterval(scan, 2000); // fs.watch can miss events on network and remote file systems
  context.subscriptions.push({ dispose: () => (w.close(), clearInterval(poll)) });
  scan();

  context.subscriptions.push(
    vscode.commands.registerCommand("vixtab.orchestrate", orchestrate),
    vscode.commands.registerCommand("vixtab.setup", () => setup(false)),
    vscode.commands.registerCommand("vixtab.doctor", doctor),
    vscode.commands.registerCommand("vixtab.createPlayground", createPlayground),
    vscode.commands.registerCommand("vixtab.evenColumns", () => vscode.commands.executeCommand("workbench.action.evenEditorWidths")),
  );

  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  item.text = "$(rocket) VixTab";
  item.tooltip = "VixTab: start an orchestrator tab for this folder";
  item.command = "vixtab.orchestrate";
  const showItem = () => (vscode.workspace.getConfiguration("vixtab").get("statusBar") && (vscode.workspace.workspaceFolders || []).length ? item.show() : item.hide());
  showItem();
  context.subscriptions.push(item, vscode.workspace.onDidChangeConfiguration(showItem), vscode.workspace.onDidChangeWorkspaceFolders(showItem));

  const key = `vixtab.setupAsked.${context.extension.packageJSON.version}`;
  if (needsSetup() && !context.globalState.get(key)) {
    void context.globalState.update(key, true);
    void vscode.window
      .showInformationMessage("VixTab: finish setup? It installs the `vixtab` command (~/.vixtab/bin) and two Claude Code skills (~/.claude/skills).", "Set up", "Not now")
      .then((a) => a === "Set up" && setup(false));
  }
  log(`VixTab ${context.extension.packageJSON.version} active in window ${process.pid}`);
}

function deactivate() {
  try {
    fs.unlinkSync(WINDOW_FILE);
  } catch {}
}

module.exports = { activate, deactivate };
