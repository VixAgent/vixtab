// vixtab lock <name> [--wait <s>] -- <command…> · vixtab lock <name> --show — a portable replacement for flock.
import { has, parseArgs, str } from "../core/args.ts";
import { loadConfig } from "../core/config.ts";
import { locksOf } from "../core/mainline.ts";
import { alive } from "../core/proc.ts";
import { commandAfterDashes, runInherit } from "../core/run.ts";
import { fail } from "../core/util.ts";

export const HELP = `vixtab lock <name> [--wait <seconds>] -- <command…>   run a command while holding a named lock (exit code = the command's)
vixtab lock <name> --show                              who holds the lock
The command is an argv (-- bun test test/) or one quoted line (-- "bun run build && bun test"), run by bash with pipefail.
Locks live in the VixTab home of the repo; a lock whose owner died is taken over automatically.`;

export async function lock(argv: string[]): Promise<void> {
  const a = parseArgs(argv, ["wait"]);
  const name = a._[0];
  if (!name || !/^[\w.-]+$/.test(name)) return void console.log(HELP);
  const L = locksOf(loadConfig());
  if (has(a, "show")) {
    const o = L.owner(name);
    console.log(o ? `${name}: pid ${o.pid} (${alive(o.pid) ? "running" : "DEAD — the next caller takes it over"}) on ${o.host} since ${o.at} ${o.note}` : `${name}: free`);
    return;
  }
  if (!a.rest.length) fail("missing command after --", 2);
  const waitS = str(a, "wait");
  let release: () => void;
  try {
    release = await L.take(name, waitS ? Number(waitS) * 1000 : Infinity, a.rest.join(" ").slice(0, 120));
  } catch (e) {
    fail(String((e as Error).message), 75);
  }
  const code = await runInherit(commandAfterDashes(a.rest));
  release();
  process.exitCode = code;
}
