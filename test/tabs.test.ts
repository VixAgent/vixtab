// The tabs overview (vixtab tabs): grouping by window, the closed-tabs history and its log, `code --status` parsing.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOverview, closedTabs, fmtDuration, goneEvents, logTab, openTabByLabel, parseCodeStatus, type Project, readTabLog, type TabEvent, trimLog,
} from "../src/core/tabs.ts";

const now = 1_800_000_000_000;
const min = 60_000;
const open = (sessionId: string, label: string, at: number, model: string | null = null): TabEvent => ({ ev: "open", at, label, sessionId, pid: 1, cwd: "/work/my-app", window: 100, model });
const close = (sessionId: string, label: string, at: number, status: string | null = null, ev: "close" | "gone" = "close"): TabEvent => ({ ev, at, label, sessionId, status });

describe("overview", () => {
  const project = (cwd: string): Project => ({
    repo: "/work/my-app",
    name: cwd.endsWith("other") ? "other" : "my-app",
    ticket: (label) => (label === "T-001" ? { id: "T-001", status: "⏳ DOING (T-001)", title: "Soup" } : label === "T-002" ? { id: "T-002", status: "❓ ASK (T-002)", title: "Bread" } : null),
  });
  const windows = [
    { pid: 200, folders: ["/work/my-app"], version: "0.7.0", kind: "tickets" as const },
    { pid: 100, folders: ["/work/my-app"], version: "0.7.0", kind: "main" as const },
    { pid: 300, folders: ["/work/other"], version: "0.7.0" },
  ];
  const sessions = [
    { pid: 11, sessionId: "s-orch", cwd: "/work/my-app", name: "Orchestrator", status: "idle", statusUpdatedAt: now - 5 * min, startedAt: now - 60 * min },
    { pid: 12, sessionId: "s-t10", cwd: "/work/my-app", name: "auto-name", status: "busy", statusUpdatedAt: now - 2 * min },
    { pid: 21, sessionId: "s-t1", cwd: "/work/my-app", name: "T-001", status: "busy", statusUpdatedAt: now - 3 * min },
    { pid: 22, sessionId: "s-t2", cwd: "/work/my-app", name: "T-002", status: "idle", statusUpdatedAt: now - 1 * min },
    { pid: 31, sessionId: "s-user", cwd: "/work/other", name: "my-chat", status: "idle" },
    { pid: 41, sessionId: "s-elsewhere", cwd: "/work/x", name: "no-vixtab", status: "busy" },
  ];
  const ancestry: Record<number, number> = { 11: 100, 12: 100, 21: 200, 22: 200, 31: 300, 41: 0 };
  const events = [open("s-t10", "T-010", now - 9 * min, "sonnet"), open("s-t1", "T-001", now - 30 * min, "opus"), open("s-gone", "T-003", now - 90 * min), close("s-gone", "T-003", now - 10 * min, "✅ DONE (T-003)")];
  const o = buildOverview({ now, sessions, windows, windowOf: (pid) => ancestry[pid] ?? 0, events, project, gate: null, loads: new Map([[200, { pct: 93, renderer: 999 }]]) });

  test("tabs are grouped under the window whose extension host they descend from", () => {
    expect(o.windows.map((w) => [w.project, w.kind, w.pid])).toEqual([["my-app", "main", 100], ["my-app", "tickets", 200], ["other", "main", 300]]);
    expect(o.windows[0].tabs.map((t) => t.label)).toEqual(["Orchestrator", "T-010"]);
    expect(o.windows[1].tabs.map((t) => t.label)).toEqual(["T-001", "T-002"]);
    expect(o.windows[2].tabs.map((t) => t.label)).toEqual(["my-chat"]);
    expect(o.summary.unlisted).toBe(1);
  });

  test("label and model come from VixTab's open event; ticket status from the board; ❓ ASK is 'asking'", () => {
    const t10 = o.windows[0].tabs[1], t1 = o.windows[1].tabs[0], t2 = o.windows[1].tabs[1];
    expect([t10.label, t10.model, t10.vixtab, t10.openedAt]).toEqual(["T-010", "sonnet", true, now - 9 * min]);
    expect([t1.state, t1.ticket?.status, t1.model, t1.since]).toEqual(["busy", "⏳ DOING (T-001)", "opus", now - 3 * min]);
    expect([t2.state, t2.vixtab, t2.model]).toEqual(["asking", false, null]);
    expect(o.windows[0].tabs[0].ticket).toBeNull();
  });

  test("summary counts and text; load per window", () => {
    expect(o.summary).toMatchObject({ tabs: 5, busy: 2, idle: 2, asking: 1, windows: 3, loadMeasured: true });
    expect(o.summary.text).toBe("5 tabs · 2 busy · 2 idle · 1 asking · 3 windows");
    expect(o.windows[1].load).toEqual({ pct: 93, renderer: 999 });
    expect(o.windows[0].load).toBeNull();
  });

  test("closed tabs are part of the overview", () => {
    expect(o.closed.map((c) => [c.label, c.ranMs, c.status, c.project])).toEqual([["T-003", 80 * min, "✅ DONE (T-003)", "my-app"]]);
  });
});

describe("closed history", () => {
  test("newest first, only tabs VixTab opened, not running again, after the last clear, at most the limit", () => {
    const ev = [
      open("a", "T-001", 0), close("a", "T-001", 10),
      open("b", "T-002", 5), close("b", "T-002", 30, "✅ DONE (T-002)"),
      close("x", "T-009", 40), // never opened by VixTab
      open("c", "T-003", 20), close("c", "T-003", 50, null, "gone"),
      open("d", "T-004", 21), close("d", "T-004", 60, null, "gone"), // came back: running again
    ];
    expect(closedTabs(ev, new Set(["d"])).map((c) => c.label)).toEqual(["T-003", "T-002", "T-001"]);
    expect(closedTabs(ev, new Set(), 2).map((c) => c.label)).toEqual(["T-004", "T-003"]);
    expect(closedTabs([...ev, { ev: "clear", at: 30 }], new Set()).map((c) => c.label)).toEqual(["T-004", "T-003"]);
  });

  test("a reopened session counts from its latest open", () => {
    const ev = [open("a", "T-001", 0), close("a", "T-001", 10), open("a", "T-001", 20)];
    expect(closedTabs(ev, new Set())).toEqual([]);
    expect(openTabByLabel(ev, "T-001")?.at).toBe(20);
    expect(openTabByLabel([open("a", "T-001", 0), close("a", "T-001", 10)], "T-001")).toBeNull();
  });

  test("gone: a tab VixTab opened that disappeared without session close, after a grace period", () => {
    const ev = [open("a", "T-001", now - 10 * min), open("b", "T-002", now - 10 * min), close("b", "T-002", now - 5 * min, "✅ DONE (T-002)"), open("c", "T-003", now - 5_000)];
    const seen = { a: { at: now - 1 * min, status: "⏳ DOING (T-001)" } };
    const g = goneEvents(ev, new Set(), seen, now);
    expect(g).toEqual([{ ev: "gone", at: now - 1 * min, label: "T-001", sessionId: "a", status: "⏳ DOING (T-001)" }]); // b closed, c too recent
    expect(goneEvents(ev, new Set(["a"]), seen, now).length).toBe(0);
    // A tab that came back after a gone event and disappeared again gets a new one; a close stays final.
    const back = [...ev, ...g, close("b", "T-002", now - 4 * min, null, "gone")];
    expect(goneEvents(back, new Set(), { a: { at: now - 30_000, status: null } }, now).map((e) => (e as any).sessionId)).toEqual(["a"]);
    expect(goneEvents(back, new Set(), seen, now).length).toBe(0);
  });

  test("trimLog keeps the last lines and older open lines of tabs that never ended", () => {
    const lines = [
      JSON.stringify(open("old-running", "T-001", 1)), JSON.stringify(open("old-closed", "T-002", 2)), JSON.stringify(close("old-closed", "T-002", 3)),
      ...Array.from({ length: 10 }, (_, i) => JSON.stringify({ ev: "clear", at: 10 + i })),
    ];
    const t = trimLog(lines, 5);
    expect(t.length).toBe(6);
    expect(JSON.parse(t[0]).sessionId).toBe("old-running");
    expect(t.slice(1)).toEqual(lines.slice(-5));
    expect(trimLog(lines, 50)).toBe(lines);
  });

  test("logTab appends and trims the file", () => {
    const file = join(mkdtempSync(join(tmpdir(), "vixtab-tabs-")), "tabs.jsonl");
    const label = "T-".padEnd(120, "x"); // realistic line length: lines are counted only past 64 KB
    writeFileSync(file, Array.from({ length: 599 }, (_, i) => JSON.stringify(close(`s${i}`, label, i)) + "\n").join(""));
    logTab(close("s599", label, 599), file);
    expect(readTabLog(file).length).toBe(600);
    logTab(close("s600", label, 600), file);
    const ev = readTabLog(file);
    expect(ev.length).toBe(500);
    expect(ev.at(-1)).toEqual(close("s600", label, 600));
  });
});

describe("renderer load", () => {
  test("code --status: extension-host [N] → the pid of window [N]", () => {
    const text = [
      "Version:          Code 1.143.0",
      "GPU Log Messages:",
      "[1:2/3:ERROR:x] window [7] noise before the table",
      "CPU %\tMem MB\t   PID\tProcess",
      "    0\t   283\t  1000\tcode",
      "    1\t   276\t  1001\twindow [1] (T-001 - my-app - Visual Studio Code)",
      "    0\t    49\t  1002\t   utility-network-service",
      "    0\t   280\t  1003\textension-host [2]",
      "    0\t   250\t  1004\t     /opt/claude --resume=abc",
      "    0\t   274\t  1005\twindow [2] ([my-app] VixTab tickets 1 — T-002)",
      "    0\t   289\t  1006\textension-host [1]",
      "    0\t   655\t  1007\t   window",
      "    0\t   207\t  1008\textension-host [9]",
    ].join("\n");
    expect([...parseCodeStatus(text)].sort((a, b) => a[0] - b[0])).toEqual([[1003, 1005], [1006, 1001]]);
    expect(parseCodeStatus("no table here").size).toBe(0);
  });

  test("durations", () => {
    expect([fmtDuration(42_000), fmtDuration(12 * min), fmtDuration(185 * min), fmtDuration(50 * 60 * min)]).toEqual(["42s", "12m", "3h 05m", "2d 2h"]);
  });
});

describe("vixtab tabs --json on fixture folders", () => {
  test("registry + window files + process ancestry → grouped structure; gone tabs move to the closed list", async () => {
    const root = mkdtempSync(join(tmpdir(), "vixtab-tabs-fx-"));
    const claude = join(root, "claude"), cache = join(root, "cache");
    mkdirSync(join(claude, "sessions"), { recursive: true });
    mkdirSync(join(cache, "windows"), { recursive: true });
    // This test process plays a VS Code window's extension host; a child of it plays the CLI of a Claude tab in that window.
    // Our parent process is alive but not below any registered window: its tab is counted, not listed.
    const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)"], { stdout: "ignore", stderr: "ignore" });
    try {
      writeFileSync(join(cache, "windows", `${process.pid}.json`), JSON.stringify({ pid: process.pid, folders: [root], version: "9.9.9", at: "", kind: "main" }));
      const t = Date.now();
      const reg = (pid: number, sessionId: string, name: string, status: string) =>
        writeFileSync(join(claude, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: root, name, entrypoint: "claude-vscode", status, statusUpdatedAt: t - 90_000, startedAt: t - 600_000 }));
      reg(child.pid, "11111111-1111-4111-8111-111111111111", "auto", "busy");
      reg(process.ppid, "22222222-2222-4222-8222-222222222222", "elsewhere", "idle");
      writeFileSync(join(claude, "sessions", "1.json"), JSON.stringify({ pid: 999_999_999, sessionId: "dead", cwd: root, entrypoint: "claude-vscode" }));
      writeFileSync(
        join(cache, "tabs.jsonl"),
        [
          { ev: "open", at: t - 600_000, label: "T-001", sessionId: "11111111-1111-4111-8111-111111111111", pid: child.pid, cwd: root, window: process.pid, model: "haiku" },
          { ev: "open", at: t - 300_000, label: "T-002", sessionId: "33333333-3333-4333-8333-333333333333", pid: 999_999_998, cwd: root, window: process.pid, model: null },
        ].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      const env = { ...process.env, CLAUDE_CONFIG_DIR: claude, VIXTAB_CACHE_DIR: cache };
      const p = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "tabs", "--json"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
      const out = await new Response(p.stdout).text();
      expect(await p.exited).toBe(0);
      const o = JSON.parse(out);
      expect(o.windows.length).toBe(1);
      expect(o.windows[0].pid).toBe(process.pid);
      expect(o.windows[0].tabs.map((x: any) => [x.label, x.state, x.model, x.vixtab])).toEqual([["T-001", "busy", "haiku", true]]);
      expect(o.summary).toMatchObject({ tabs: 1, busy: 1, idle: 0, windows: 1, unlisted: 1 });
      expect(o.summary.gate.open).toBeNull(); // not inside a project: RAM and CPU only
      expect(o.closed.map((c: any) => [c.label, c.how])).toEqual([["T-002", "gone"]]);
      // The pid → window mapping is cached for the next (cheap) run.
      const st = JSON.parse(readFileSync(join(cache, "tabs-state.json"), "utf8"));
      expect(st.win[String(child.pid)]).toEqual({ sid: "11111111-1111-4111-8111-111111111111", win: process.pid });
    } finally {
      child.kill();
    }
  }, 60_000);
});
