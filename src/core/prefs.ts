// The user's machine-wide choices, ~/.vixtab/config.json (VIXTAB_PREFS for tests): the skills scope, the usage limit. Kept
// across upgrades; the extension's settings write them through the CLI.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOME } from "./util.ts";

const prefsFile = () => process.env.VIXTAB_PREFS ?? join(HOME, ".vixtab", "config.json");

export function readPrefs(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(prefsFile(), "utf8")) ?? {};
  } catch {
    return {};
  }
}

/** Merge `patch` into the saved choices. */
export function savePrefs(patch: Record<string, unknown>): void {
  mkdirSync(dirname(prefsFile()), { recursive: true });
  writeFileSync(prefsFile(), JSON.stringify({ ...readPrefs(), ...patch }, null, 2) + "\n");
}
