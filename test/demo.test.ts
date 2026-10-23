// End-to-end: the scripted playground demo (claims, merge queue, red tests, events, done, abandoned lock) must pass.
import { expect, test } from "bun:test";
import { join } from "node:path";

test("playground demo board passes", async () => {
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "playground", "demo", "board"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  if (code !== 0) console.log(out.slice(-4000));
  expect(out).toContain("DEMO PASSED");
  expect(code).toBe(0);
}, 600_000);
