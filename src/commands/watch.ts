// vixtab watch ram | usage — run in the background; each EXITS (so the background task notifies the orchestrator) when it
// alerts.
//   ram  : log free RAM/swap every 30 s; alert when free RAM stays below --min-free three times in a row, or swap is above
//          --max-swap. Prints the biggest processes.
//   usage: read the Claude account's usage every 240 s (every 60 s within 10 points of the limit); alert when the 5-hour
//          session or the week reaches the usage limit (default 96 %), with the reset time.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, str } from "../core/args.ts";
import { loadConfig } from "../core/config.ts";
import { type Limit, localTime, overLimit, overLine, parseLimit, readUsage, usageLimit } from "../core/usage.ts";
import { VixError, sleep } from "../core/util.ts";
import { platform } from "../platform/index.ts";

export const HELP = `vixtab watch ram [--min-free 1500] [--max-swap 32768] [--every 30]   (MB, seconds; run in the background)
vixtab watch usage [--limit <percent>] [--every 240]                 (default limit: vixtab usage limit; run in the background)

watch usage exits with "ALERT usage: <limit> <n> % ≥ <limit> %, resets …" when the Claude account's 5-hour session or week
reaches the limit. Then pause: close the ticket tabs without releasing the tickets, and run vixtab usage wait.`;

export async function watch(argv: string[]): Promise<void> {
  const [what, ...rest] = argv;
  if (what === "usage") return watchUsage(rest);
  if (what !== "ram") return void console.log(HELP);
  const a = parseArgs(rest, ["min-free", "max-swap", "every"]);
  const c = loadConfig();
  const minFree = Number(str(a, "min-free") ?? 1500), maxSwap = Number(str(a, "max-swap") ?? 32768), every = Number(str(a, "every") ?? 30) * 1000;
  mkdirSync(join(c.home, "logs"), { recursive: true });
  const log = join(c.home, "logs", "ram.log");
  let low = 0;
  while (true) {
    const free = platform.freeRamMB(), swap = platform.swapUsedMB(), t = new Date().toTimeString().slice(0, 8);
    appendFileSync(log, `${t} free=${free}MB swap=${swap}MB\n`);
    low = free < minFree ? low + 1 : 0;
    if (low >= 3 || swap > maxSwap) {
      console.log(`ALERT ${t}: free RAM ${free}MB, swap ${swap}MB. Biggest processes:`);
      console.log(platform.topProcesses(8));
      return;
    }
    await sleep(every);
  }
}

async function watchUsage(argv: string[]): Promise<void> {
  const a = parseArgs(argv, ["limit", "every"]);
  const fixed = str(a, "limit") ? parseLimit(str(a, "limit")) : null;
  const every = Math.max(60, Number(str(a, "every") ?? 240)) * 1000;
  while (true) {
    // The saved limit is read at every pass: a change in the settings applies to a running guard.
    const limit = fixed ?? usageLimit();
    let near = false;
    try {
      const u = await readUsage({ maxAgeMs: 30_000 });
      const over: Limit[] = overLimit(u, limit);
      if (over.length) {
        console.log(over.map((l) => `ALERT usage: ${overLine(l, limit)}`).join("\n"));
        console.log(`(${u.account}, read ${localTime(u.at)}) Pause: stop opening tabs, close each ticket tab without releasing its ticket, then run vixtab usage wait in the background.`);
        return;
      }
      near = u.limits.some((l) => (l.kind === "session" || l.kind === "week") && l.percent >= limit - 10);
    } catch (e) {
      if (!(e instanceof VixError)) throw e; // unknown for now (network, expired token): read again next time
    }
    await sleep(near ? 60_000 : every);
  }
}
