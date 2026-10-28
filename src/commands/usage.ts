// vixtab usage — the Claude account's plan usage (what /usage shows), the usage limit, and a waiter for the limit to reset.
import { has, parseArgs, str } from "../core/args.ts";
import {
  DEFAULT_LIMIT, type Limit, type Usage, inTime, localTime, overLimit, overLine, parseLimit, pct, readUsage, resets, saveLimit, savedLimit, shortLine, usageLimit,
} from "../core/usage.ts";
import { VixError, sleep } from "../core/util.ts";

export const HELP = `vixtab usage — the Claude account's usage, read like Claude Code's /usage (no other tool needed)

  usage [--json] [--max-age <s>]     the 5-hour session, the week (all models), the week of single models, extra usage, each
                                     with its reset time, for the Claude Code login of this machine; a reading younger than
                                     --max-age (default 60 s) is reused. Reading costs no usage. Exit 3 = usage unknown.
  usage limit [<percent>]            print or set the usage limit (default ${DEFAULT_LIMIT}; also the extension setting VixTab: Usage
                                     Limit, or VIXTAB_USAGE_LIMIT). At or above it on the 5-hour session or the week:
                                     vixtab watch usage alerts, session open exits 6, the orchestrator pauses its tickets.
  usage wait [--limit <percent>] [--every <s>]
                                     sleep until the account is below the limit again, then print the usage and exit (run
                                     it in the background after pausing: no tokens are spent while it waits). It sleeps
                                     until the limit resets, then reads every --every seconds (default 300).

The usage of the account Claude Code is logged in with right now (switching accounts switches it).`;

const table = (u: Usage, limit: number) => {
  const rows = u.limits.map((l) => [l.label, pct(l), resets(l) + (l.severity && l.severity !== "normal" ? `  [${l.severity}]` : "")]);
  if (u.extra) rows.push(["extra usage", u.extra.enabled ? "on" : "off", u.extra.enabled && u.extra.percent !== null ? `${Math.floor(u.extra.percent)} % of the monthly cap used` : ""]);
  const w = [0, 1].map((i) => Math.max(...rows.map((r) => r[i].length)));
  return [
    `account  ${u.account}  ${u.plan}`,
    ...rows.map((r) => `  ${r[0].padEnd(w[0])}  ${r[1].padStart(w[1])}  ${r[2]}`.trimEnd()),
    `limit    ${limit} % — at or above it on the 5-hour session or the week, the orchestrator pauses its ticket sessions`,
  ].join("\n");
};

export async function usage(argv: string[]): Promise<void> {
  const [action, ...rest] = argv;
  if (action === "limit") {
    const v = rest[0];
    if (v === undefined) {
      const env = process.env.VIXTAB_USAGE_LIMIT;
      return void console.log(`limit=${usageLimit()} %${env ? " (VIXTAB_USAGE_LIMIT)" : savedLimit() ? "" : " (default)"}`);
    }
    const n = parseLimit(v);
    saveLimit(n);
    return void console.log(`limit=${n} % — saved in ~/.vixtab/config.json for every project on this machine`);
  }
  if (action === "wait") return waitBelow(rest);
  const a = parseArgs(argv, ["max-age"]);
  if (a._.length) return void console.log(HELP);
  const limit = usageLimit();
  const maxAgeMs = Number(str(a, "max-age") ?? 60) * 1000;
  try {
    const u = await readUsage({ maxAgeMs });
    if (has(a, "json")) return void console.log(JSON.stringify({ ...u, limit, over: overLimit(u, limit).map((l) => l.kind) }));
    console.log(table(u, limit));
    const over = overLimit(u, limit);
    if (over.length) console.log(over.map((l) => `OVER THE LIMIT: ${overLine(l, limit)}`).join("\n"));
  } catch (e) {
    if (!(e instanceof VixError) || !has(a, "json")) throw e;
    console.log(JSON.stringify({ error: e.message, limit }));
    process.exitCode = e.code;
  }
}

/** Sleep until the 5-hour session and the week are below the limit. Without a reading after the reset time, assume it reset. */
async function waitBelow(argv: string[]): Promise<void> {
  const a = parseArgs(argv, ["limit", "every"]);
  const limit = str(a, "limit") ? parseLimit(str(a, "limit")) : usageLimit();
  const every = Math.max(30, Number(str(a, "every") ?? 300)) * 1000;
  let until = 0, waitingFor: Limit[] = [], told = false;
  while (true) {
    // Sleep in short steps: one long timer can fire late after the machine slept.
    if (Date.now() < until) {
      await sleep(Math.min(every, until - Date.now()));
      continue;
    }
    let u: Usage | null = null, why = "";
    try {
      u = await readUsage({ maxAgeMs: 0 });
    } catch (e) {
      if (!(e instanceof VixError)) throw e;
      why = e.message;
    }
    if (!u) {
      // Unknown now (an idle machine lets the access token expire), but every limit we waited for has reset by now.
      if (waitingFor.length && waitingFor.every((l) => l.resetsAt && l.resetsAt <= Date.now()))
        return void console.log(`below the limit: ${waitingFor.map((l) => `${l.label} reset at ${localTime(l.resetsAt!)}`).join(", ")} (usage unknown now: ${why})`);
      until = Date.now() + every;
      continue;
    }
    const over = overLimit(u, limit);
    if (!over.length) return void console.log(`below the limit (${limit} %): ${shortLine(u)} — ${localTime(Date.now())}`);
    waitingFor = over;
    const reset = Math.max(...over.map((l) => l.resetsAt ?? 0));
    // A minute after the reset, so the new window has started; no reset time ⇒ read again after --every.
    until = reset > Date.now() ? reset + 60_000 : Date.now() + every;
    if (!told) console.log(`waiting: ${over.map((l) => overLine(l, limit)).join("; ")} — next reading in ${inTime(until - Date.now())}`);
    told = true;
  }
}
