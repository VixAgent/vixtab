// Named locks that work the same on NTFS and ext4: a lock is a directory created with mkdir (atomic), holding owner.json.
// A lock whose owner died (same host, pid gone) is abandoned and the next caller takes it over. Taking over goes through a
// second lock (<name>.lock.fix) and re-reads the owner inside it, so two callers that both see an abandoned lock cannot
// delete each other's fresh lock.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { alive } from "./proc.ts";
import { sleep } from "./util.ts";

export type Owner = { pid: number; host: string; at: string; note: string };

const readOwner = (d: string): Owner | null => {
  try {
    return JSON.parse(readFileSync(join(d, "owner.json"), "utf8"));
  } catch {
    return null;
  }
};
function abandoned(d: string, o: Owner | null): boolean {
  if (o) return o.host === hostname() && !alive(o.pid);
  try {
    return Date.now() - statSync(d).mtimeMs > 10_000; // just created, owner.json not written yet
  } catch {
    return false;
  }
}
function removeAbandoned(d: string, seenPid: number | undefined): void {
  const fix = `${d}.fix`;
  try {
    mkdirSync(fix);
  } catch {
    try {
      if (Date.now() - statSync(fix).mtimeMs > 5_000) rmSync(fix, { recursive: true, force: true });
    } catch {}
    return;
  }
  try {
    const o = readOwner(d);
    if (existsSync(d) && abandoned(d, o) && o?.pid === seenPid) rmSync(d, { recursive: true, force: true });
  } finally {
    rmSync(fix, { recursive: true, force: true });
  }
}

export class Locks {
  constructor(public dir: string) {}

  path = (name: string) => join(this.dir, `${name}.lock`);
  owner = (name: string) => readOwner(this.path(name));

  /** One attempt. Returns a release function, or null when someone else holds the lock. */
  tryTake(name: string, note = ""): (() => void) | null {
    mkdirSync(this.dir, { recursive: true });
    const d = this.path(name);
    for (let i = 0; i < 3; i++) {
      try {
        mkdirSync(d);
      } catch (e: any) {
        if (e?.code !== "EEXIST") throw e;
        const o = readOwner(d);
        if (!abandoned(d, o)) return null;
        removeAbandoned(d, o?.pid);
        continue;
      }
      writeFileSync(join(d, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString(), note }));
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        if (readOwner(d)?.pid === process.pid) rmSync(d, { recursive: true, force: true });
      };
      process.once("exit", release);
      return release;
    }
    return null;
  }

  /** Wait until the lock is ours (waitMs = Infinity: forever). */
  async take(name: string, waitMs = Infinity, note = ""): Promise<() => void> {
    const start = Date.now();
    let told = false;
    while (true) {
      const release = this.tryTake(name, note);
      if (release) return release;
      const o = this.owner(name);
      if (Date.now() - start > waitMs) throw new Error(`lock ${name} busy for more than ${Math.round(waitMs / 1000)} s (owner: pid ${o?.pid ?? "?"} ${o?.note ?? ""})`);
      if (!told && Date.now() - start > 3000) {
        console.error(`  … waiting for lock ${name} (owner: pid ${o?.pid ?? "?"} ${o?.note ?? ""}, since ${o?.at ?? "?"})`);
        told = true;
      }
      await sleep(250);
    }
  }

  /** Locks currently held by a live owner whose name starts with `prefix`. */
  held(prefix: string): { name: string; owner: Owner }[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".lock") && f.startsWith(prefix))
      .map((f) => ({ name: f.slice(0, -5), owner: readOwner(join(this.dir, f)) }))
      .filter((x): x is { name: string; owner: Owner } => !!x.owner && !abandoned(join(this.dir, `${x.name}.lock`), x.owner));
  }
}
