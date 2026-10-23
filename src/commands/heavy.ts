// vixtab heavy — run a heavy step (full test suite, E2E, bundler, browser) so that many parallel sessions do not drown the
// machine. The number of concurrent heavy runs is ELASTIC: slots = max(2, logical CPUs / 4) by default, and a run only takes a
// slot when, measured atomically inside the "heavy-gate" lock:
//   free RAM − caps of runs that started in the last 90 s (not grown yet)  ≥  own cap + headroom (4 GB),
//   CPU busy ≤ 85 %, and (Windows) commit charge + own cap ≤ 85 % of the commit limit.
// Each run is capped: Linux = systemd user scope MemoryMax (only that run is killed, exit 137); Windows = Job Object memory
// limit (allocations fail beyond the cap). Low CPU priority on both.
import { has, parseArgs, str } from "../core/args.ts";
import { loadConfig } from "../core/config.ts";
import { locksOf } from "../core/mainline.ts";
import { measure } from "../core/resources.ts";
import { fmtMB, parseSizeMB, sleep } from "../core/util.ts";
import { platform } from "../platform/index.ts";

export const HELP = `vixtab heavy [--mem 6G] [--slots N] [--now] -- <command…>

  --mem 6G     memory cap of this run (default: heavy.mem in vixtab.config.json, 6G)
  --slots N    max concurrent heavy runs (default: max(2, CPUs/4))
  --now        no waiting, no slot: only apply the cap and low priority (nightly jobs)
Waits (re-measuring every 10 s) until the resource gate admits the run. Exit code = the command's.`;

export async function heavy(argv: string[]): Promise<void> {
  const a = parseArgs(argv, ["mem", "slots"]);
  if (!a.rest.length) return void console.log(HELP);
  const c = loadConfig();
  const capMB = parseSizeMB(str(a, "mem"), c.heavy.memMB);
  const slots = Math.max(1, Number(str(a, "slots") ?? c.heavy.slots));
  if (has(a, "now")) return void (process.exitCode = await platform.runCapped(a.rest, capMB));
  const L = locksOf(c);
  const slotName = (i: number) => `heavy-${i}`;
  let told = false;
  while (true) {
    let release: (() => void) | null = null;
    const gate = await L.take("heavy-gate", Infinity, "measure + take a slot");
    try {
      const running = L.held("heavy-").filter((h) => /^heavy-\d+$/.test(h.name));
      if (running.length < slots) {
        const reserved = running
          .filter((h) => Date.now() - Date.parse(h.owner.at) < 90_000)
          .reduce((t, h) => t + (Number(/^cap=(\d+)/.exec(h.owner.note)?.[1]) || 6144), 0);
        const g = await measure({ minFreeMB: capMB + c.heavy.headroomMB, maxCommit: c.heavy.maxCommit, maxCpu: c.heavy.maxCpu, needCommitMB: capMB }, reserved);
        if (!g.missing.length) {
          for (let i = 1; i <= slots && !release; i++) release = L.tryTake(slotName(i), `cap=${capMB} ${a.rest.join(" ").slice(0, 120)}`);
        } else if (!told) {
          console.error(`  … heavy run waiting: ${g.missing.join("; ")}`);
          told = true;
        }
      } else if (!told) {
        console.error(`  … heavy run waiting: all ${slots} slots busy`);
        told = true;
      }
    } finally {
      gate();
    }
    if (release) {
      let code: number;
      try {
        console.error(`  heavy run started (cap ${fmtMB(capMB)}, ${platform.memoryCapKind()})`);
        code = await platform.runCapped(a.rest, capMB);
      } finally {
        release();
      }
      process.exitCode = code;
      return;
    }
    await sleep(10_000);
  }
}

