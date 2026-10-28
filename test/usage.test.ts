import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overLimit, parseTime, parseUsage } from "../src/core/usage.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

describe("usage", () => {
  test("parseTime: ISO with microseconds, epoch seconds and ms", () => {
    expect(parseTime("2026-10-29T00:40:00.050123+00:00")).toBe(Date.UTC(2026, 9, 29, 0, 40, 0, 50));
    expect(parseTime(1793234400)).toBe(1793234400000);
    expect(parseTime(1793234400000)).toBe(1793234400000);
    expect(parseTime(null)).toBeNull();
    expect(parseTime("soon")).toBeNull();
  });

  test("parseUsage: current answer (limits)", () => {
    const u = parseUsage({
      limits: [
        { kind: "session", percent: 97.4, resets_at: "2026-10-29T00:40:00Z", severity: "warning" },
        { kind: "weekly_all", percent: 45, resets_at: "2026-11-01T22:00:00Z", severity: "normal" },
        { kind: "weekly_scoped", percent: 99, resets_at: "2026-11-01T22:00:00Z", scope: { model: { display_name: "Fable" } } },
      ],
      extra_usage: { is_enabled: false, utilization: null },
    });
    expect(u.limits.map((l) => [l.kind, l.label])).toEqual([
      ["session", "5-hour session"],
      ["week", "week, all models"],
      ["model", "week, Fable"],
    ]);
    expect(u.limits[0].severity).toBe("warning");
    expect(u.extra).toEqual({ enabled: false, percent: null });
    // A single model's week at 99 % stops only that model: it does not trip the limit.
    expect(overLimit(u, 96).map((l) => l.kind)).toEqual(["session"]);
    expect(overLimit(u, 98)).toEqual([]);
  });

  test("parseUsage: older answer (five_hour, seven_day…)", () => {
    const u = parseUsage({ five_hour: { utilization: 12, resets_at: "2026-10-29T00:40:00Z" }, seven_day: { utilization: 96, resets_at: null }, seven_day_opus: null });
    expect(u.limits.map((l) => [l.kind, l.percent, l.resetsAt])).toEqual([
      ["session", 12, Date.UTC(2026, 9, 29, 0, 40)],
      ["week", 96, null],
    ]);
    expect(overLimit(u, 96).map((l) => l.kind)).toEqual(["week"]);
    expect(u.extra).toBeNull();
  });

  // The CLI in a sandbox: its own Claude config, prefs and cache (never the machine's login or cache).
  const sandbox = () => {
    const root = mkdtempSync(join(tmpdir(), "vixtab-usage-"));
    const claude = join(root, "claude");
    mkdirSync(claude);
    const env = { ...process.env, CLAUDE_CONFIG_DIR: claude, VIXTAB_PREFS: join(root, "prefs.json"), VIXTAB_CACHE_DIR: join(root, "cache") };
    delete (env as any).VIXTAB_USAGE_LIMIT;
    const vt = (args: string[], extra: Record<string, string> = {}) => {
      const r = Bun.spawnSync(["bun", CLI, ...args], { env: { ...env, ...extra } });
      return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
    };
    return { root, claude, env, vt };
  };

  test("the limit: default 96, saved by usage limit, VIXTAB_USAGE_LIMIT wins, 1…100 only", () => {
    const s = sandbox();
    expect(s.vt(["usage", "limit"]).out).toBe("limit=96 % (default)");
    expect(s.vt(["usage", "limit", "90"]).code).toBe(0);
    expect(JSON.parse(readFileSync(join(s.root, "prefs.json"), "utf8")).usageLimit).toBe(90);
    expect(s.vt(["usage", "limit"]).out).toBe("limit=90 %");
    expect(s.vt(["usage", "limit"], { VIXTAB_USAGE_LIMIT: "80" }).out).toBe("limit=80 % (VIXTAB_USAGE_LIMIT)");
    expect(s.vt(["usage", "limit", "0"]).code).toBe(2);
    expect(s.vt(["usage", "limit", "101"]).code).toBe(2);
  });

  test("unknown usage: no login, expired token (no network), and the failed reading is cached", () => {
    const s = sandbox();
    const none = s.vt(["usage", "--json"]);
    expect(none.code).toBe(3);
    expect(JSON.parse(none.out).error).toContain("no claude.ai login");
    writeFileSync(join(s.claude, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "x", expiresAt: Date.now() - 60_000, subscriptionType: "max", rateLimitTier: "default_claude_max_20x" } }));
    writeFileSync(join(s.claude, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "someone@example.com" } }));
    const expired = s.vt(["usage", "--json"]);
    expect(expired.code).toBe(3);
    expect(JSON.parse(expired.out)).toMatchObject({ limit: 96 });
    expect(JSON.parse(expired.out).error).toContain("expired");
    const cache = join(s.root, "cache", "usage.json");
    expect(existsSync(cache)).toBe(true);
    expect(JSON.parse(readFileSync(cache, "utf8"))).toMatchObject({ account: "someone@example.com" });
    expect(JSON.parse(readFileSync(cache, "utf8")).error.until).toBeGreaterThan(Date.now());
    expect(s.vt(["usage"]).code).toBe(3);
  });

  test("a failed reading falls back to the last good one (≤ 15 min old), marked stale", () => {
    const s = sandbox();
    writeFileSync(join(s.claude, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "x", expiresAt: Date.now() - 60_000 } }));
    writeFileSync(join(s.claude, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "someone@example.com" } }));
    mkdirSync(join(s.root, "cache"));
    const last = (minutesAgo: number) => ({
      account: "someone@example.com",
      last: { at: Date.now() - minutesAgo * 60_000, account: "someone@example.com", plan: "max", extra: null, limits: [{ kind: "session", label: "5-hour session", percent: 97, resetsAt: Date.now() + 3_600_000 }] },
    });
    writeFileSync(join(s.root, "cache", "usage.json"), JSON.stringify(last(5)));
    const r = s.vt(["usage", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ over: ["session"], limit: 96 });
    expect(JSON.parse(r.out).stale).toContain("expired");
    // Too old to stand in: unknown.
    writeFileSync(join(s.root, "cache", "usage.json"), JSON.stringify(last(20)));
    expect(s.vt(["usage", "--json"]).code).toBe(3);
    // Another account's reading is never used.
    writeFileSync(join(s.root, "cache", "usage.json"), JSON.stringify({ ...last(1), account: "other@example.com" }));
    expect(s.vt(["usage", "--json"]).code).toBe(3);
  });
});
