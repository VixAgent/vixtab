// Resource gates. Instead of a fixed session cap, a new session (or heavy run) starts only when the machine has room:
// free RAM, swap, commit charge (Windows) and CPU — minus what recently started work will soon use but has not taken yet.
import { cpus } from "node:os";
import { platform } from "../platform/index.ts";
import { sleep } from "./util.ts";

/** Busy CPU share (0…1) over all cores, sampled for `ms`. */
export async function cpuBusy(ms = 1500): Promise<number> {
  const total = () =>
    cpus().reduce(
      (s, c) => {
        const busy = c.times.user + c.times.nice + c.times.sys + c.times.irq;
        return { busy: s.busy + busy, all: s.all + busy + c.times.idle };
      },
      { busy: 0, all: 0 },
    );
  const a = total();
  await sleep(ms);
  const b = total();
  return b.all > a.all ? (b.busy - a.busy) / (b.all - a.all) : 0;
}

export type Gate = { line: string; missing: string[]; freeMB: number; cpu: number };

/** Measure the machine against limits. `reservedMB` = RAM promised to work that started moments ago. */
export async function measure(limits: { minFreeMB: number; maxSwapMB?: number; maxCommit: number; maxCpu: number; needCommitMB?: number }, reservedMB = 0): Promise<Gate> {
  const free = platform.freeRamMB(), effective = free - reservedMB;
  const swap = limits.maxSwapMB !== undefined ? platform.swapUsedMB() : 0;
  const commit = platform.commitMB();
  const cpu = await cpuBusy();
  const missing: string[] = [];
  if (effective < limits.minFreeMB) missing.push(`free RAM ${effective}MB${reservedMB ? ` (${free} − ${reservedMB} reserved)` : ""} < ${limits.minFreeMB}MB`);
  if (limits.maxSwapMB !== undefined && swap > limits.maxSwapMB) missing.push(`swap ${swap}MB > ${limits.maxSwapMB}MB`);
  if (commit && commit.used + (limits.needCommitMB ?? 0) > commit.limit * limits.maxCommit)
    missing.push(`commit ${commit.used}/${commit.limit}MB > ${Math.round(limits.maxCommit * 100)}%`);
  if (cpu > limits.maxCpu) missing.push(`CPU ${Math.round(cpu * 100)}% > ${Math.round(limits.maxCpu * 100)}%`);
  const line = `free_ram=${free}MB${reservedMB ? ` reserved=${reservedMB}MB` : ""}${limits.maxSwapMB !== undefined ? ` swap=${swap}MB` : ""}${commit ? ` commit=${commit.used}/${commit.limit}MB` : ""} cpu=${Math.round(cpu * 100)}%`;
  return { line, missing, freeMB: free, cpu };
}
