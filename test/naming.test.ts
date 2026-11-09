// Session labels carry the project's prefix (VE-T-001), and the RAM gate is a share of RAM in use: both from the config.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { type Config, folderPrefix, labelName, loadConfig, sessionLabel } from "../src/core/config.ts";
import { VixError } from "../src/core/util.ts";

const root = mkdtempSync(join(tmpdir(), "vixtab-naming-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
for (const k of ["VIXTAB_REPO", "VIXTAB_HOME", "VIXTAB_MAX_RAM", "VIXTAB_MIN_FREE_RAM_MB", "VIXTAB_SESSION_PREFIX"]) delete process.env[k];

/** A git repository in <root>/<name> with an optional vixtab.config.json. */
function repo(name: string, config?: object): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const r = Bun.spawnSync(["git", "init", "-q"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  if (config) writeFileSync(join(dir, "vixtab.config.json"), JSON.stringify(config));
  return dir;
}
const conf = (sessionPrefix: string) => ({ sessionPrefix, prefix: "T-", digits: 3 }) as Config;

describe("session prefix", () => {
  test("initials of the folder name's words, or the first 3 letters of one word; accents dropped", () => {
    expect(folderPrefix("Vixtab-extension")).toBe("VE");
    expect(folderPrefix("my-web-app")).toBe("MWA");
    expect(folderPrefix("data-lake-tools")).toBe("DLT");
    expect(folderPrefix("recipes")).toBe("REC");
    expect(folderPrefix("API")).toBe("API");
    expect(folderPrefix("Café-Crème")).toBe("CC");
    expect(folderPrefix("\u0111ata_lake")).toBe("DL");
    expect(folderPrefix("a-b-c-d-e-f")).toBe("ABCD");
    expect(folderPrefix("--")).toBe("VT");
  });
  test("labels: <prefix>-<name>; a label passed back keeps one prefix; the name comes back out", () => {
    const c = conf("VE");
    expect(sessionLabel(c, "T-001")).toBe("VE-T-001");
    expect(sessionLabel(c, "VE-T-001")).toBe("VE-T-001");
    expect(sessionLabel(c, "Orchestrator 2")).toBe("VE-Orchestrator 2");
    expect(labelName(c, "VE-T-001")).toBe("T-001");
    expect(labelName(c, "T-001")).toBe("T-001"); // a tab opened by 0.9.0 or older
    expect(labelName(c, "REC-T-001")).toBe("REC-T-001"); // another project's
  });
  test("a prefix equal to the ticket letter still prefixes ticket ids", () => {
    const c = conf("T");
    expect(sessionLabel(c, "T-001")).toBe("T-T-001");
    expect(labelName(c, "T-T-001")).toBe("T-001");
  });
  test("from the folder by default, sessionPrefix in vixtab.config.json, VIXTAB_SESSION_PREFIX; letters and digits only", () => {
    expect(loadConfig(repo("Video-Editor")).sessionPrefix).toBe("VE");
    expect(loadConfig(repo("own-prefix", { sessionPrefix: "VTX" })).sessionPrefix).toBe("VTX");
    process.env.VIXTAB_SESSION_PREFIX = "ENV1";
    try {
      expect(loadConfig(repo("from-env")).sessionPrefix).toBe("ENV1");
    } finally {
      delete process.env.VIXTAB_SESSION_PREFIX;
    }
    let code = 0;
    try {
      loadConfig(repo("bad-prefix", { sessionPrefix: "V-E" }));
    } catch (e) {
      code = e instanceof VixError ? e.code : -1;
    }
    expect(code).toBe(2);
  });
});

describe("RAM gate", () => {
  const totalMB = Math.round(totalmem() / 1048576);
  test("new sessions while RAM in use ≤ 92 % by default: free RAM ≥ 8 %", () => {
    const s = loadConfig(repo("ram-default")).sessions;
    expect(s.maxRam).toBe(0.92);
    expect(s.minFreeRamMB).toBe(Math.round(totalMB * 0.08));
  });
  test("maxRam as a share or a percent; an explicit minFreeRamMB replaces it", () => {
    expect(loadConfig(repo("ram-share", { sessions: { maxRam: 0.9 } })).sessions.minFreeRamMB).toBe(Math.round(totalMB * 0.1));
    expect(loadConfig(repo("ram-percent", { sessions: { maxRam: 90 } })).sessions.maxRam).toBe(0.9);
    const s = loadConfig(repo("ram-fixed", { sessions: { minFreeRamMB: 8192 } })).sessions;
    expect(s).toMatchObject({ minFreeRamMB: 8192, maxRam: null });
  });
});
