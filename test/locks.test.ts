// Named locks: first come, first served queue, waking as soon as the lock is free, waiters that died, reused pids.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Locks, type WaitState } from "../src/core/locks.ts";
import { platform } from "../src/platform/index.ts";

const fresh = () => new Locks(mkdtempSync(join(tmpdir(), "vixtab-locks-")));
/** A pid that no longer runs. */
async function deadPid(): Promise<number> {
  const p = Bun.spawn([process.execPath, "-e", ""]);
  await p.exited;
  return p.pid;
}

describe("queue", () => {
  test("first come, first served; the first in line takes the lock as soon as it is free", async () => {
    const L = fresh();
    const hold = L.tryTake("x", "holder")!;
    const order: string[] = [];
    const wait = (n: string) => L.take("x", 10_000, n, { queue: true }).then((r) => (order.push(n), r));
    const a = wait("a");
    await Bun.sleep(30);
    const b = wait("b");
    await Bun.sleep(30);
    const c = wait("c");
    await Bun.sleep(30);
    expect(L.waiters("x").map((w) => w.note)).toEqual(["a", "b", "c"]);
    const t = Date.now();
    hold();
    const ra = await a;
    expect(Date.now() - t).toBeLessThan(1000);
    await Bun.sleep(300);
    expect(order).toEqual(["a"]);
    ra();
    (await b)();
    (await c)();
    expect(order).toEqual(["a", "b", "c"]);
    expect(L.waiters("x")).toEqual([]);
  });

  test("a waiter that gives up leaves the line; a wait of 0 is one attempt", async () => {
    const L = fresh();
    const hold = L.tryTake("x", "holder")!;
    await expect(L.take("x", 0, "z", { queue: true })).rejects.toThrow(/busy/);
    const t = Date.now();
    await expect(L.take("x", 200, "y", { queue: true })).rejects.toThrow(/owner: pid \d+ holder/);
    expect(Date.now() - t).toBeGreaterThanOrEqual(190);
    expect(L.waiters("x")).toEqual([]);
    hold();
    (await L.take("x", 0, "w", { queue: true }))();
  });

  test("tickets of waiters that died, or stopped refreshing them, do not block the line", async () => {
    const L = fresh();
    const q = join(L.dir, "x.queue");
    mkdirSync(q, { recursive: true });
    const dead = await deadPid();
    writeFileSync(join(q, `000000000000001-${dead}-aaaaaa.json`), JSON.stringify({ pid: dead, host: hostname(), at: "", note: "dead" }));
    const far = join(q, "000000000000002-1-bbbbbb.json");
    writeFileSync(far, JSON.stringify({ pid: 1, host: "another-host", at: "", note: "silent" }));
    utimesSync(far, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    const t = Date.now();
    (await L.take("x", 5_000, "me", { queue: true }))();
    expect(Date.now() - t).toBeLessThan(1000);
    expect(L.waiters("x")).toEqual([]);
  });

  test("the holder's status reaches the waiters", async () => {
    const L = fresh();
    const hold = L.tryTake("x", "open TS-alpha")!;
    L.setStatus("x", "TS-alpha waits for the resource gate: CPU 95% > 85%");
    const seen: WaitState[] = [];
    const w = L.take("x", 5_000, "open TS-beta", { queue: true, onWait: (s) => seen.push(s) });
    await Bun.sleep(300);
    hold();
    (await w)();
    expect(seen.at(-1)).toMatchObject({ position: 1, waiting: 1, status: "TS-alpha waits for the resource gate: CPU 95% > 85%" });
    expect(seen.at(-1)!.owner?.note).toBe("open TS-alpha");
    expect(L.status("x")).toBe(""); // released: the status went with the lock
  });
});

describe("owners", () => {
  test("a lock whose owner's pid now belongs to a younger process is taken over", () => {
    const L = fresh();
    const started = platform.startKey(process.pid);
    expect(started).toBeGreaterThan(0);
    const d = join(L.dir, "x.lock");
    mkdirSync(d, { recursive: true });
    const owner = (s: number) => writeFileSync(join(d, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname(), at: "", note: "old", started: s }));
    owner(started);
    expect(L.tryTake("x")).toBeNull(); // this very process: held
    owner(started - 3_600_000); // the owner started an hour before this pid did: it was another process
    const r = L.tryTake("x", "new");
    expect(r).not.toBeNull();
    expect(L.owner("x")?.note).toBe("new");
    r!();
  });

  test("a dead owner is taken over; an owner without a start time is judged by its pid alone", async () => {
    const L = fresh();
    const d = join(L.dir, "x.lock");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "owner.json"), JSON.stringify({ pid: await deadPid(), host: hostname(), at: "", note: "dead" }));
    const r = L.tryTake("x")!;
    expect(r).not.toBeNull();
    r();
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname(), at: "", note: "old CLI" }));
    expect(L.tryTake("x")).toBeNull();
  });
});
