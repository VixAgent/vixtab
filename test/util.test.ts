import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/core/args.ts";
import { Locks } from "../src/core/locks.ts";
import { isInside, isReservedName, parseSizeMB, slugify } from "../src/core/util.ts";

describe("util", () => {
  test("parseSizeMB", () => {
    expect(parseSizeMB("6G", 0)).toBe(6144);
    expect(parseSizeMB("512M", 0)).toBe(512);
    expect(parseSizeMB("2048", 0)).toBe(2048);
    expect(parseSizeMB("nope", 7)).toBe(7);
  });
  test("isInside", () => {
    expect(isInside("/a/b/c", "/a/b")).toBe(true);
    expect(isInside("/a/bc", "/a/b")).toBe(false);
    expect(isInside("/a/b", "/a/b")).toBe(true);
  });
  test("Windows reserved names", () => {
    for (const n of ["con", "CON.c", "nul", "com1.txt", "LPT9"]) expect(isReservedName(n)).toBe(true);
    for (const n of ["console", "doc-con.c", "comma"]) expect(isReservedName(n)).toBe(false);
  });
  test("slugify strips accents", () => {
    expect(slugify("Add a crêpes recipe!")).toBe("add-a-crepes-recipe");
  });
  test("parseArgs", () => {
    const a = parseArgs(["open", "T-1", "--cwd", "/x", "--focus", "--prompt=hi", "--", "a", "--b"], ["cwd"]);
    expect(a._).toEqual(["open", "T-1"]);
    expect(a.flags).toEqual({ cwd: "/x", focus: true, prompt: "hi" });
    expect(a.rest).toEqual(["a", "--b"]);
  });
});

describe("locks", () => {
  test("a lock is exclusive and released", () => {
    const L = new Locks(mkdtempSync(join(tmpdir(), "vixtab-locks-")));
    const r1 = L.tryTake("x");
    expect(r1).not.toBeNull();
    expect(L.tryTake("x")).toBeNull();
    expect(L.held("x").length).toBe(1);
    r1!();
    expect(L.tryTake("x")).not.toBeNull();
  });
  test("an abandoned lock (owner pid gone) is taken over", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vixtab-locks-"));
    const child = Bun.spawn([process.execPath, "-e", `const {Locks}=await import(${JSON.stringify(join(import.meta.dir, "../src/core/locks.ts"))});new Locks(${JSON.stringify(dir)}).tryTake("y");process.kill(process.pid,"SIGKILL")`]);
    await child.exited;
    const L = new Locks(dir);
    expect(L.owner("y")).not.toBeNull();
    expect(L.tryTake("y")).not.toBeNull();
  });
});

describe("pipefail", () => {
  test("test commands from the config run with pipefail", async () => {
    const { shellCommand } = await import("../src/core/run.ts");
    const p = Bun.spawnSync(shellCommand("false | true"));
    expect(p.exitCode).not.toBe(0);
  });
  test("bash -c / sh -c after -- get pipefail", async () => {
    const { withPipefail } = await import("../src/core/run.ts");
    expect(withPipefail(["bash", "-c", "x"])).toEqual(["bash", "-o", "pipefail", "-c", "x"]);
    expect(withPipefail(["bun", "test"])).toEqual(["bun", "test"]);
    if (process.platform !== "win32") expect(Bun.spawnSync(withPipefail(["sh", "-c", "false | true"])).exitCode).not.toBe(0);
  });
});
