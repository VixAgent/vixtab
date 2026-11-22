// Registered VS Code windows and their Claude tabs, counted without asking any window: from the tab file a window keeps
// (window-tabs/<pid>.json), else from the Claude CLIs that descend from its extension host. A stale tab file, or a command
// that timed out since, means the window does not answer. Registrations whose pid was reused are left out. Runs the CLI against
// fixture folders (cache and Claude config) and checks that no command file was written.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reusedPid } from "../src/core/bridge.ts";

test("a registration older than its pid's process is a reused pid", () => {
  const at = "2026-11-20T10:00:00.000Z", t = Date.parse(at);
  expect(reusedPid({ pid: 1, at }, t + 3_600_000)).toBe(true);
  expect(reusedPid({ pid: 1, at }, t - 10_000)).toBe(false); // the extension host started, then registered
  expect(reusedPid({ pid: 1, at }, t + 30_000)).toBe(false); // clock noise, a wall-clock step
  expect(reusedPid({ pid: 1, at }, 0)).toBe(false); // unknown
  expect(reusedPid({ pid: 1 }, t)).toBe(false);
});

const pids: number[] = [];
afterAll(() => pids.forEach((p) => {
  try {
    process.kill(p);
  } catch {}
}));
const sleeper = () => {
  const p = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 120000)"]);
  pids.push(p.pid);
  return p.pid;
};

test("tabs are counted from each window's file or from its processes; no window is asked", async () => {
  const cache = mkdtempSync(join(tmpdir(), "vixtab-cache-")), claude = mkdtempSync(join(tmpdir(), "vixtab-claude-"));
  for (const d of ["commands", "windows", "window-tabs"]) mkdirSync(join(cache, d), { recursive: true });
  mkdirSync(join(claude, "sessions"), { recursive: true });
  // An "extension host" with 2 Claude tab CLIs and one terminal CLI below it.
  const host = Bun.spawn([process.execPath, "-e", `
    const kid = () => Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 120000)"]).pid;
    console.log([kid(), kid(), kid()].join(" "));
    setTimeout(() => {}, 120000);`], { stdout: "pipe" });
  pids.push(host.pid);
  const reader = host.stdout.getReader();
  const kids = new TextDecoder().decode((await reader.read()).value).trim().split(" ").map(Number);
  pids.push(...kids);
  const [stale, muted] = [sleeper(), sleeper()];
  await Bun.sleep(300);
  const now = new Date().toISOString();
  const reg = (pid: number, folder: string, at = now) => writeFileSync(join(cache, "windows", `${pid}.json`), JSON.stringify({ pid, folders: [folder], version: "test", at, kind: "main" }));
  const tabsFile = (pid: number, beat: number, labels: string[]) =>
    writeFileSync(join(cache, "window-tabs", `${pid}.json`), JSON.stringify({ pid, at: now, beat, maxTabs: 8, claude: labels.length, labels, layout: [{ column: 1, active: true, tabs: labels.map((label) => ({ label, claude: true, active: false })) }] }));
  reg(process.pid, "/w/published");
  tabsFile(process.pid, Date.now(), ["TS-T-001", "TS-T-002"]);
  reg(host.pid, "/w/old-extension");
  reg(stale, "/w/stale");
  tabsFile(stale, Date.now() - 120_000, ["TS-T-009"]);
  reg(muted, "/w/muted");
  tabsFile(muted, Date.now() - 5_000, []);
  writeFileSync(join(cache, "silent-windows.json"), JSON.stringify({ [muted]: { at: now, since: Date.now() - 1000, last: Date.now() - 1000 } }));
  reg(sleeper(), "/w/reused", "2026-01-01T00:00:00.000Z");
  const session = (pid: number, sessionId: string, entrypoint: string, name: string) =>
    writeFileSync(join(claude, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: "/w/old-extension", entrypoint, name }));
  session(kids[0], "00000000-0000-4000-8000-000000000001", "claude-vscode", "auto-name-1");
  session(kids[1], "00000000-0000-4000-8000-000000000002", "claude-vscode", "TS-T-004");
  session(kids[2], "00000000-0000-4000-8000-000000000003", "cli", "a terminal session");
  writeFileSync(join(cache, "tabs.jsonl"), JSON.stringify({ ev: "open", at: 1, label: "TS-T-003", sessionId: "00000000-0000-4000-8000-000000000001", pid: kids[0], cwd: "/w/old-extension", window: host.pid, model: null }) + "\n");

  const env = { ...process.env, VIXTAB_CACHE_DIR: cache, CLAUDE_CONFIG_DIR: claude, VIXTAB_ORCHESTRATOR_WINDOW: "1" };
  const run = async (argv: string[]) => {
    const p = Bun.spawn([process.execPath, ...argv], { env, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out;
  };
  const list = await run([join(import.meta.dir, "..", "src", "cli.ts"), "tab", "windows"]);
  const line = (folder: string) => list.split("\n").find((l) => l.includes(folder)) ?? "";
  expect(line("/w/published")).toMatch(/claude_tabs=2 /);
  expect(line("/w/old-extension")).toMatch(/claude_tabs=2 \(from its processes\)/);
  expect(line("/w/stale")).toMatch(/claude_tabs=-1 \(not answering\)/);
  expect(line("/w/muted")).toMatch(/claude_tabs=-1 \(not answering\)/);
  expect(list).not.toContain("/w/reused");
  // Labels for duplicates and closing: the tab history's label, else the registry name; a stale window's last labels count too.
  const script = join(mkdtempSync(join(tmpdir(), "vixtab-script-")), "labels.ts");
  writeFileSync(script, `import { windowsWithLabel } from ${JSON.stringify(join(import.meta.dir, "..", "src", "core", "bridge.ts").replace(/\\/g, "/"))};
for (const l of ["TS-T-001", "TS-T-003", "TS-T-004", "TS-T-009", "auto-name-1"]) console.log(l, (await windowsWithLabel(l)).join(","));`);
  const labels = await run([script]);
  expect(labels.trim().split(/\r?\n/)).toEqual([`TS-T-001 ${process.pid}`, `TS-T-003 ${host.pid}`, `TS-T-004 ${host.pid}`, `TS-T-009 ${stale}`, "auto-name-1"]); // the label it was opened with wins over the registry name
  expect(readdirSync(join(cache, "commands"))).toEqual([]); // nothing was asked
}, 60_000);

test("the ancestor chain of a process, from its parent up", async () => {
  const p = sleeper();
  await Bun.sleep(300);
  const { platform } = await import("../src/platform/index.ts");
  const up = platform.ancestorPids(p);
  expect(up[0]).toBe(process.pid);
  expect(up.slice(1, 1 + platform.ancestorPids(process.pid).length)).toEqual(platform.ancestorPids(process.pid));
  expect(platform.ancestorPids(p, platform.parents())).toEqual(up);
});
