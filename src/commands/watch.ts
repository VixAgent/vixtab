// vixtab watch ram — log free RAM/swap every 30 s and EXIT (so a background task notifies the orchestrator) when the machine
// runs low: free RAM below --min-free three times in a row, or swap above --max-swap. Prints the biggest processes.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, str } from "../core/args.ts";
import { loadConfig } from "../core/config.ts";
import { sleep } from "../core/util.ts";
import { platform } from "../platform/index.ts";

export const HELP = `vixtab watch ram [--min-free 1500] [--max-swap 32768] [--every 30]   (MB, seconds; run in the background)`;

export async function watch(argv: string[]): Promise<void> {
  const [what, ...rest] = argv;
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
