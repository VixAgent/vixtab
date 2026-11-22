// session open: what waits for what. The session-open lock covers the resource gate only (with the RAM reservation); creating
// the session, opening the tab and waiting for its CLI run side by side. One label is opened by one command at a time. The
// gate can be waited for. Batches print one line per tab and a summary.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type OpenDeps, type OpenOptions, type OpenRecord, RESERVE_MS, joinOptional, labelKey, openMany, openOne, openRecords, opensDir, recentTimings,
} from "../src/commands/session.ts";
import type { Config } from "../src/core/config.ts";
import { locksOf } from "../src/core/mainline.ts";
import type { TabEvent } from "../src/core/tabs.ts";
import { VixError } from "../src/core/util.ts";
import { platform } from "../src/platform/index.ts";

const config = (): Config => {
  const home = mkdtempSync(join(tmpdir(), "vixtab-open-"));
  return {
    repo: home, home, locks: join(home, "locks"), prefix: "T-", digits: 3, sessionPrefix: "TS",
    sessions: { max: 0, minFreeRamMB: 0, maxRam: null, maxSwapMB: 0, maxCommit: 1, maxCpu: 1, reserveMB: 1024 },
    tabs: { mode: "auto", inWindowMax: null, columnsMax: 3, perWindowMax: null },
  } as unknown as Config;
};
const opts = (c: Config, o: Partial<OpenOptions> = {}): OpenOptions => ({
  cwd: c.repo, model: undefined, focus: false, here: false, trust: false, gate: true, waitMs: 10_000, gateWaitMs: 0, gatePollMs: 50, timings: false,
  say: () => {}, ...o,
});

/** Fake windows and CLI. `missing` = what the gate lacks at each call; every step is logged in `events`. */
function fakes(c: Config, o: { createMs?: number; gateMs?: number; missing?: (call: number) => string[]; holders?: number[] } = {}) {
  const events: string[] = [], logged: TabEvent[] = [], reservedSeen: number[] = [];
  const sessions = new Map<string, string>();
  let gates = 0;
  const d: OpenDeps = {
    holders: async () => o.holders ?? [],
    choose: async () => ({ win: 100, stack: false, max: 6 }),
    create: async (label) => {
      events.push(`create+ ${label}`);
      await Bun.sleep(o.createMs ?? 300);
      events.push(`create- ${label}`);
      const id = crypto.randomUUID();
      sessions.set(id, label);
      return id;
    },
    send: async () => ({ column: 2, labeled: true }),
    registry: () => [...sessions].map(([sessionId, label]) => ({ pid: process.pid, sessionId, cwd: c.repo, entrypoint: "claude-vscode", name: label })),
    gate: async () => {
      events.push("gate+");
      reservedSeen.push(openRecords(c).filter((r) => r.reserved).length);
      await Bun.sleep(o.gateMs ?? 100);
      events.push("gate-");
      return { line: "test-gate", missing: o.missing?.(gates++) ?? [] };
    },
    log: (e) => logged.push(e),
  };
  return { d, events, logged, reservedSeen };
}
/** Most steps of a kind running at once. */
const overlap = (events: string[], kind: string) => {
  let n = 0, most = 0;
  for (const e of events) {
    if (e.startsWith(`${kind}+`)) most = Math.max(most, ++n);
    if (e.startsWith(`${kind}-`)) n--;
  }
  return most;
};
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 0;
  } catch (e) {
    if (e instanceof VixError) return e.code;
    throw e;
  }
};

describe("what waits for what", () => {
  test("only the gate is serialized: sessions are created side by side, and each gate sees the RAM reserved before it", async () => {
    const c = config(), f = fakes(c);
    const out = await Promise.all(["alpha", "beta", "gamma"].map((n) => openOne(c, n, opts(c), f.d)));
    expect(overlap(f.events, "gate")).toBe(1);
    expect(overlap(f.events, "create")).toBeGreaterThanOrEqual(2);
    expect(f.reservedSeen).toEqual([0, 1, 2]);
    for (const [i, n] of ["alpha", "beta", "gamma"].entries()) expect(out[i][0]).toMatch(new RegExp(`^session=[0-9a-f-]{36} name=\\S+ pid=${process.pid} label=TS-${n} .* model=default$`));
    expect(f.logged.map((e) => e.ev === "open" && Object.keys(e.ms ?? {}))).toEqual(Array(3).fill(["check", "queue", "gate", "window", "create", "open", "cli", "total"]));
    // Done: still reserved for RESERVE_MS (the tab's CLI takes its RAM over a while), no longer in flight.
    expect(openRecords(c).map((r) => [r.phase, r.reserved])).toEqual(Array(3).fill(["done", true]));
    expect(openRecords(c, Date.now() + RESERVE_MS + 1)).toEqual([]);
  });

  test("one label is opened by one command at a time; an open label is refused (exit 5)", async () => {
    const c = config(), f = fakes(c);
    const r = await Promise.allSettled([openOne(c, "alpha", opts(c), f.d), openOne(c, "alpha", opts(c), f.d)]);
    expect(r.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
    const err = (r.find((x) => x.status === "rejected") as PromiseRejectedResult).reason;
    expect([err.code, /being opened right now/.test(err.message)]).toEqual([5, true]);
    expect(await code(openOne(c, "beta", opts(c), fakes(c, { holders: [100] }).d))).toBe(5);
    expect(openRecords(c).map((r) => r.label)).toEqual(["TS-alpha"]); // the refused ones left nothing behind
  });

  test("openers in line wait for the lock; past --wait: exit 6", async () => {
    const c = config(), f = fakes(c);
    const hold = locksOf(c).tryTake("session-open", "someone")!;
    const t = Date.now();
    const p = openOne(c, "alpha", opts(c, { waitMs: 300 }), f.d);
    expect(await code(p)).toBe(6);
    expect(Date.now() - t).toBeGreaterThanOrEqual(290);
    const q = openOne(c, "beta", opts(c), f.d);
    await Bun.sleep(200);
    hold();
    expect((await q)[0]).toContain("label=TS-beta");
  });
});

describe("resource gate", () => {
  test("closed: exit 6 at once, unless --wait-gate; then it opens as soon as the gate does", async () => {
    const c = config();
    expect(await code(openOne(c, "alpha", opts(c), fakes(c, { missing: () => ["CPU 95% > 85%"] }).d))).toBe(6);
    const said: string[] = [];
    const f = fakes(c, { gateMs: 10, missing: (n) => (n < 3 ? ["CPU 95% > 85%"] : []) });
    const out = await openOne(c, "beta", opts(c, { gateWaitMs: 30_000, say: (l) => said.push(l) }), f.d);
    expect(out[0]).toContain("label=TS-beta");
    expect(said).toEqual([expect.stringMatching(/TS-beta: resource gate closed \(CPU 95% > 85%\) — waiting up to \d+ s more/)]);
  });

  test("--wait-gate gives up after its time; the usage limit never waits", async () => {
    const c = config();
    const t = Date.now();
    expect(await code(openOne(c, "alpha", opts(c, { gateWaitMs: 300 }), fakes(c, { gateMs: 10, missing: () => ["RAM in use 95% > 92%"] }).d))).toBe(6);
    expect(Date.now() - t).toBeGreaterThanOrEqual(290);
    const u = Date.now();
    const e = await openOne(c, "beta", opts(c, { gateWaitMs: 30_000 }), fakes(c, { gateMs: 10, missing: () => ["usage: 5-hour session 97% ≥ 96%"] }).d).catch((x) => x);
    expect([e.code, /usage: 5-hour session/.test(e.message)]).toEqual([6, true]);
    expect(Date.now() - u).toBeLessThan(2000);
  });

  test("behind an opener that waits for the gate: --wait-gate waits too, without it exit 6 at once", async () => {
    const c = config();
    let open = false;
    const f = fakes(c, { gateMs: 10, missing: () => (open ? [] : ["CPU 95% > 85%"]) });
    const first = openOne(c, "alpha", opts(c, { gateWaitMs: 30_000 }), f.d);
    await Bun.sleep(300);
    const t = Date.now();
    const e = await openOne(c, "beta", opts(c), f.d).catch((x) => x);
    expect([e.code, /resource gate closed — CPU 95% > 85% \(the opener ahead waits for it/.test(e.message)]).toEqual([6, true]);
    expect(Date.now() - t).toBeLessThan(3000);
    const second = openOne(c, "gamma", opts(c, { waitMs: 100, gateWaitMs: 30_000 }), f.d); // its line wait covers the gate wait
    await Bun.sleep(500);
    open = true;
    expect((await first)[0]).toContain("label=TS-alpha");
    expect((await second)[0]).toContain("label=TS-gamma");
  });

  test("--timings prints how long each step took", async () => {
    const c = config();
    const out = await openOne(c, "alpha", opts(c, { timings: true }), fakes(c).d);
    expect(out.at(-1)).toMatch(/^timings TS-alpha: check=\S+ queue=\S+ gate=\S+ window=\S+ create=\S+ open=\S+ cli=\S+ total=\S+$/);
  });
});

describe("batches", () => {
  const capture = async (f: () => Promise<number>) => {
    const out: string[] = [], err: string[] = [];
    const [log, error] = [console.log, console.error];
    console.log = (s: string) => out.push(s);
    console.error = (s: string) => err.push(s);
    try {
      return { code: await f(), out, err };
    } finally {
      [console.log, console.error] = [log, error];
    }
  };
  const fakeOpen = (fails: Record<string, number>) => async (_c: Config, n: string) => {
    if (fails[n]) throw new VixError(`NOT OPENED: ${n} failed`, fails[n]);
    return [`session=x label=TS-${n}`];
  };

  test("one line per tab and a summary; a name that fails alone is skipped, a closed gate stops the rest", async () => {
    const c = config();
    const r = await capture(() => openMany(c, ["T-1", "T-2", "T-3", "T-4"], opts(c), 1, fakeOpen({ "T-2": 5, "T-3": 6 })));
    expect(r.out).toEqual(["session=x label=TS-T-1", "batch: opened=T-1 not_opened=T-2,T-3,T-4 (not tried after T-3: T-4)"]);
    expect(r.err).toEqual(["T-2 (exit 5): NOT OPENED: T-2 failed", "T-3 (exit 6): NOT OPENED: T-3 failed"]);
    expect(r.code).toBe(6); // the failure that stopped the batch
    const ok = await capture(() => openMany(c, ["T-1", "T-2"], opts(c), 3, fakeOpen({})));
    expect([ok.code, ok.out.at(-1)]).toEqual([0, "batch: opened=T-1,T-2 not_opened="]);
    const five = await capture(() => openMany(c, ["T-1", "T-2"], opts(c), 2, fakeOpen({ "T-1": 5 })));
    expect([five.code, five.out.at(-1)]).toEqual([5, "batch: opened=T-2 not_opened=T-1"]);
  });

  test("real opens of a batch run side by side", async () => {
    const c = config(), f = fakes(c);
    const r = await capture(() => openMany(c, ["alpha", "beta", "gamma"], opts(c), 3, (cc, n, o) => openOne(cc, n, o, f.d)));
    expect(r.code).toBe(0);
    expect(r.out.filter((l) => l.startsWith("session="))).toHaveLength(3);
    expect(overlap(f.events, "create")).toBeGreaterThanOrEqual(2);
  });
});

describe("records and arguments", () => {
  test("in-flight records count while their opener lives; done ones for RESERVE_MS; dead ones are dropped", async () => {
    const c = config(), now = Date.now();
    mkdirSync(opensDir(c), { recursive: true });
    const dead = Bun.spawn([process.execPath, "-e", ""]);
    await dead.exited;
    const rec = (label: string, r: Partial<OpenRecord>) =>
      writeFileSync(join(opensDir(c), `${labelKey(label)}.${process.pid}.${now}.json`), JSON.stringify({ label, pid: process.pid, host: hostname(), started: platform.startKey(process.pid), phase: "create", since: now, at: now, reserved: true, ...r }));
    rec("TS-live", {});
    rec("TS-done", { phase: "done", done: now - 1000 });
    rec("TS-old", { phase: "done", done: now - RESERVE_MS - 1000 });
    rec("TS-dead", { pid: dead.pid });
    expect(openRecords(c, now).map((r) => r.label).sort()).toEqual(["TS-done", "TS-live"]);
  });

  test("label keys are file names; --wait-gate takes an optional number of seconds", () => {
    expect(labelKey("VE-T-001")).toBe("VE-T-001");
    expect(labelKey("My tab #2")).toBe("My_20tab_20_232");
    expect(joinOptional(["T-1", "--wait-gate", "900", "T-2"])).toEqual(["T-1", "--wait-gate=900", "T-2"]);
    expect(joinOptional(["--wait-gate", "T-2"])).toEqual(["--wait-gate", "T-2"]);
  });

  test("recent timings: this project's opens only", () => {
    const c = config();
    const ev = (cwd: string, total?: number): TabEvent => ({ ev: "open", at: 1, label: "x", sessionId: "s", pid: 1, cwd, window: 1, model: null, ...(total === undefined ? {} : { ms: { total } }) });
    expect(recentTimings(c, 10, [ev(c.repo, 5), ev("/elsewhere", 7), ev(c.repo), ev(join(c.repo, "sub"), 9)]).map((m) => m.total)).toEqual([5, 9]);
  });
});
