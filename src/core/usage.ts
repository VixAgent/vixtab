// The Claude account's plan usage, the numbers of Claude Code's /usage: the 5-hour session, the week (all models) and the
// week of single models, each with its reset time. VixTab reads them itself, nothing else to install: the access token of the
// Claude Code login on this machine (<claude dir>/.credentials.json) and GET /api/oauth/usage, the endpoint behind /usage.
// Reading costs no usage. Read-only: VixTab never refreshes or rewrites the login. An expired access token (it lives about
// 8 hours) is renewed by Claude Code on its next request; until then the usage is unknown.
//
// The usage LIMIT (percent, default 96) is the user's: at or above it on the 5-hour session or the week, the orchestrator
// pauses its ticket sessions until the limit resets (vixtab watch usage, vixtab usage wait), and `session open` refuses.
//
// Not a public API of Claude Code: checked with Claude Code 2.1.31x on Windows. `vixtab doctor` reads it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE } from "./bridge.ts";
import { claudeDir } from "./claude.ts";
import { readPrefs, savePrefs } from "./prefs.ts";
import { HOME, VixError, fail } from "./util.ts";

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const DEFAULT_LIMIT = 96;

/** session = the 5-hour session, week = the week of all models, model = the week of one model (it stops only that model). */
export type Limit = { kind: string; label: string; percent: number; resetsAt: number | null; severity?: string };
export type Usage = { at: number; account: string; plan: string; limits: Limit[]; extra: { enabled: boolean; percent: number | null } | null };

// ── The limit ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const validLimit = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 && n <= 100 ? Math.round(n) : null;
};
export function parseLimit(s: string | undefined): number {
  return validLimit(s) ?? fail(`the usage limit is a percent from 1 to 100, got '${s ?? ""}'`, 2);
}
export const savedLimit = () => validLimit(readPrefs().usageLimit);
/** VIXTAB_USAGE_LIMIT, else the saved limit (vixtab usage limit, or the extension setting VixTab: Usage Limit), else 96. */
export const usageLimit = (): number => validLimit(process.env.VIXTAB_USAGE_LIMIT) ?? savedLimit() ?? DEFAULT_LIMIT;
export const saveLimit = (n: number) => savePrefs({ usageLimit: n });

// ── Reading ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** ISO time (any number of fraction digits) or epoch seconds/ms → ms. */
export function parseTime(v: unknown): number | null {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isNaN(t) ? null : t;
}

/** The answer of /api/oauth/usage: `limits` (current), or five_hour / seven_day… (older answers). */
export function parseUsage(o: any): Pick<Usage, "limits" | "extra"> {
  const limits: Limit[] = [];
  if (Array.isArray(o?.limits) && o.limits.length) {
    for (const l of o.limits) {
      const kind = l.kind === "session" ? "session" : l.kind === "weekly_all" ? "week" : l.kind === "weekly_scoped" ? "model" : String(l.kind);
      const label =
        kind === "session" ? "5-hour session" : kind === "week" ? "week, all models" : kind === "model" ? `week, ${l.scope?.model?.display_name ?? l.scope?.surface ?? "one model"}` : kind;
      limits.push({ kind, label, percent: Number(l.percent ?? 0), resetsAt: parseTime(l.resets_at), ...(l.severity ? { severity: String(l.severity) } : {}) });
    }
  } else {
    const legacy: [string, string, string][] = [
      ["five_hour", "session", "5-hour session"],
      ["seven_day", "week", "week, all models"],
      ["seven_day_opus", "model", "week, Opus"],
      ["seven_day_sonnet", "model", "week, Sonnet"],
    ];
    for (const [key, kind, label] of legacy) {
      const l = o?.[key];
      if (l) limits.push({ kind, label, percent: Number(l.utilization ?? 0), resetsAt: parseTime(l.resets_at) });
    }
  }
  const x = o?.extra_usage;
  return { limits, extra: x ? { enabled: !!x.is_enabled, percent: typeof x.utilization === "number" ? x.utilization : null } : null };
}

/** The limits that stop the work at `limit` percent: the 5-hour session and the week of all models. */
export const overLimit = (u: Pick<Usage, "limits">, limit: number) => u.limits.filter((l) => (l.kind === "session" || l.kind === "week") && l.percent >= limit);

type Login = { token: string; expiresAt: number | null; account: string; plan: string };
const readJson = (f: string): any => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};
/** The Claude Code login of this machine: claude.ai account, plan, access token. */
function login(): Login {
  const credFile = join(claudeDir(), ".credentials.json");
  const o = readJson(credFile)?.claudeAiOauth;
  if (!o?.accessToken)
    fail(`no claude.ai login in ${credFile}: the usage is known only for a Claude Code login with a claude.ai plan (not an API key${process.platform === "darwin" ? ", not the macOS keychain" : ""})`, 3);
  const acc = readJson(process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : join(HOME, ".claude.json"))?.oauthAccount;
  const tier = /_(\d+x)$/.exec(String(o.rateLimitTier ?? ""))?.[1];
  return { token: o.accessToken, expiresAt: typeof o.expiresAt === "number" ? o.expiresAt : null, account: acc?.emailAddress ?? "?", plan: [o.subscriptionType ?? "?", tier].filter(Boolean).join(" ") };
}

// One reading shared by every project, window and command of the machine; a failed reading is kept too, so a down network
// is not asked again at every gate check.
type Cached = Usage | { at: number; account: string; error: string };
const cacheFile = () => join(CACHE, "usage.json");
function writeCache(x: Cached) {
  mkdirSync(CACHE, { recursive: true });
  const tmp = `${cacheFile()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(x));
  renameSync(tmp, cacheFile());
}

async function fetchUsage(token: string, timeoutMs: number): Promise<any> {
  let r: Response;
  try {
    r = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    fail(`cannot reach ${USAGE_URL}: ${(e as Error).message}`, 3);
  }
  const text = await r.text();
  if (!r.ok) {
    let why = text.slice(0, 200);
    try {
      const j = JSON.parse(text);
      why = String(j?.error?.message ?? j?.error ?? why).slice(0, 200);
    } catch {}
    fail(`reading the usage failed: HTTP ${r.status} ${why}`, 3);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`reading the usage failed: not JSON (${text.slice(0, 80)})`, 3);
  }
}

/**
 * The usage of the account logged in now. A reading younger than `maxAgeMs` (default 60 s) of the same account is reused,
 * a failed one too. Throws VixError (code 3) when the usage cannot be known.
 */
export async function readUsage(o: { maxAgeMs?: number; timeoutMs?: number } = {}): Promise<Usage> {
  const me = login();
  const c: Cached | null = existsSync(cacheFile()) ? readJson(cacheFile()) : null;
  if (c && c.account === me.account && Date.now() - c.at < (o.maxAgeMs ?? 60_000)) {
    if ("error" in c) throw new VixError(c.error, 3);
    return c;
  }
  try {
    if (me.expiresAt && me.expiresAt <= Date.now())
      fail(`the access token of the Claude Code login expired at ${localTime(me.expiresAt)}; Claude Code renews it on its next request`, 3);
    const u: Usage = { at: Date.now(), account: me.account, plan: me.plan, ...parseUsage(await fetchUsage(me.token, o.timeoutMs ?? 20_000)) };
    writeCache(u);
    return u;
  } catch (e) {
    if (e instanceof VixError) writeCache({ at: Date.now(), account: me.account, error: e.message });
    throw e;
  }
}

// ── Printing ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, "0");
/** Local "YYYY-MM-DD HH:MM", to the nearest minute (reset times come a few ms before or after the minute). */
export function localTime(t: number): string {
  const d = new Date(Math.round(t / 60_000) * 60_000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function inTime(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000)), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d ? `${d}d ${h % 24}h` : h ? `${h}h ${pad(m % 60)}m` : `${m}m`;
}
export const pct = (l: Limit) => `${Math.floor(l.percent)} %`;
export const resets = (l: Limit, now = Date.now()) => (l.resetsAt ? `resets ${localTime(l.resetsAt)} (in ${inTime(l.resetsAt - now)})` : l.percent ? "" : "not started");
/** "5-hour session 97 % ≥ 96 %, resets 2026-10-29 02:40 (in 45m)" */
export const overLine = (l: Limit, limit: number) => `${l.label} ${pct(l)} ≥ ${limit} %${l.resetsAt ? `, ${resets(l)}` : ""}`;
/** "5h 25 % · week 45 %" */
export const shortLine = (u: Pick<Usage, "limits">) =>
  u.limits.filter((l) => l.kind === "session" || l.kind === "week").map((l) => `${l.kind === "session" ? "5h" : "week"} ${pct(l)}`).join(" · ");

/** For the session gate: the usage line, and what is at or above the limit. An unknown usage never closes the gate. */
export async function usageGate(maxAgeMs = 120_000): Promise<{ line: string; missing: string[] }> {
  const limit = usageLimit();
  try {
    const u = await readUsage({ maxAgeMs, timeoutMs: 8000 });
    const main = u.limits.filter((l) => l.kind === "session" || l.kind === "week");
    return { line: `usage=${main.map((l) => `${l.kind === "session" ? "5h" : "week"}:${Math.floor(l.percent)}%`).join(",")}/${limit}%`, missing: overLimit(u, limit).map((l) => `usage: ${overLine(l, limit)}`) };
  } catch {
    return { line: "usage=?", missing: [] };
  }
}
