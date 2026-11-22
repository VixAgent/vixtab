// Named locks that work the same on NTFS and ext4: a lock is a directory created with mkdir (atomic), holding owner.json.
// A lock whose owner died (same host, pid gone, or the pid now belongs to a process that started later) is abandoned and the
// next caller takes it over. Taking over goes through a second lock (<name>.lock.fix) and re-reads the owner inside it, so two
// callers that both see an abandoned lock cannot delete each other's fresh lock.
//
// Waiting can be first come, first served (take with `queue`): each waiter writes a ticket into <name>.queue/, named by the
// time it started waiting, and only the first live ticket may take the lock. Tickets are refreshed while their waiter polls,
// so a waiter that was killed falls out of line. The holder can publish what it is doing (status) for the waiters to show.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { platform } from "../platform/index.ts";
import { alive } from "./proc.ts";
import { sleep, writeAtomic } from "./util.ts";

/** started: the owner process's platform.startKey, to tell its pid from a reused one; 0 or absent = unknown. */
export type Owner = { pid: number; host: string; at: string; note: string; started?: number };
export type Waiter = Owner & { ticket: string };
export type WaitState = { position: number; waiting: number; owner: Owner | null; status: string; waitedMs: number };

const readOwner = (d: string): Owner | null => {
  try {
    return JSON.parse(readFileSync(join(d, "owner.json"), "utf8"));
  } catch {
    return null;
  }
};
let selfStarted: number | undefined;
const myStart = () => (selfStarted ??= platform.startKey(process.pid));
const me = (note: string): Owner => ({ pid: process.pid, host: hostname(), at: new Date().toISOString(), note, started: myStart() });
/** The process that wrote `o` is gone: dead, or its pid was given to a process that started later. Other hosts: unknown, so no. */
export function gone(o: Owner): boolean {
  if (o.host !== hostname()) return false;
  if (!alive(o.pid)) return true;
  const s = o.started ? platform.startKey(o.pid) : 0;
  return s > 0 && Math.abs(s - o.started!) > 2000;
}
function abandoned(d: string, o: Owner | null): boolean {
  if (o) return gone(o);
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

/** A queue ticket not refreshed for this long belongs to a waiter that stopped polling (killed, or on another host). */
const TICKET_STALE_MS = 60_000;

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
      writeFileSync(join(d, "owner.json"), JSON.stringify(me(note)));
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        process.off("exit", release);
        if (readOwner(d)?.pid === process.pid) rmSync(d, { recursive: true, force: true });
      };
      process.once("exit", release);
      return release;
    }
    return null;
  }

  /**
   * What the holder is doing now, for the waiters and `vixtab session queue` (a separate file: owner.json is never rewritten,
   * so a reader never sees it half written). Only the holder calls this.
   */
  setStatus(name: string, text: string): void {
    try {
      writeFileSync(join(this.path(name), "status.txt"), text);
    } catch {}
  }
  status(name: string): string {
    try {
      return readFileSync(join(this.path(name), "status.txt"), "utf8");
    } catch {
      return "";
    }
  }

  queueDir = (name: string) => join(this.dir, `${name}.queue`);

  /** The live waiters of a lock, first in line first. Tickets of dead or silent waiters are removed. */
  waiters(name: string): Waiter[] {
    const d = this.queueDir(name);
    if (!existsSync(d)) return [];
    const out: Waiter[] = [];
    for (const f of readdirSync(d).filter((x) => x.endsWith(".json")).sort()) {
      const p = join(d, f);
      try {
        const w = JSON.parse(readFileSync(p, "utf8")) as Owner;
        if (!gone(w) && Date.now() - statSync(p).mtimeMs < TICKET_STALE_MS) {
          out.push({ ...w, ticket: f });
          continue;
        }
      } catch {}
      try {
        if (Date.now() - statSync(p).mtimeMs > TICKET_STALE_MS) rmSync(p, { force: true }); // unreadable for a minute: junk
      } catch {}
    }
    return out;
  }

  /** Wait until the lock is ours (waitMs = Infinity: forever; 0: one attempt). */
  async take(name: string, waitMs = Infinity, note = "", o: { queue?: boolean; onWait?: (s: WaitState) => void } = {}): Promise<() => void> {
    const start = Date.now();
    let told = false;
    let ticket: { file: string; write: () => void; beat: () => void; remove: () => void } | null = null;
    if (o.queue) {
      const d = this.queueDir(name);
      mkdirSync(d, { recursive: true });
      const file = join(d, `${String(start).padStart(15, "0")}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`);
      const write = () => writeAtomic(file, JSON.stringify(me(note)));
      let last = Date.now();
      ticket = {
        file,
        write,
        beat: () => {
          if (Date.now() - last < 5_000) return;
          last = Date.now();
          try {
            utimesSync(file, new Date(), new Date());
          } catch {
            try {
              write(); // removed as stale (this process was frozen): back in line at the same place
            } catch {} // next beat
          }
        },
        remove: () => {
          try {
            rmSync(file, { force: true });
          } catch {} // left behind: it goes stale in a minute
        },
      };
      write();
      process.once("exit", ticket.remove);
    }
    try {
      while (true) {
        const line = ticket ? this.waiters(name) : [];
        const mine = ticket ? line.findIndex((w) => join(this.queueDir(name), w.ticket) === ticket!.file) : 0;
        if (mine <= 0) {
          const release = this.tryTake(name, note);
          if (release) return release;
        }
        const owner = this.owner(name);
        const waited = Date.now() - start;
        if (waited >= waitMs) throw new Error(`lock ${name} busy for ${Math.round(waited / 1000)} s (owner: pid ${owner?.pid ?? "?"} ${owner?.note ?? ""}${this.status(name) ? `: ${this.status(name)}` : ""})`);
        if (o.onWait) o.onWait({ position: Math.max(1, mine + 1), waiting: Math.max(1, line.length), owner, status: this.status(name), waitedMs: waited }); // may throw: the waiter gives up
        else if (!told && waited > 3000) {
          console.error(`  … waiting for lock ${name} (owner: pid ${owner?.pid ?? "?"} ${owner?.note ?? ""}, since ${owner?.at ?? "?"})`);
          told = true;
        }
        ticket?.beat();
        await sleep(ticket ? 100 : 250);
      }
    } finally {
      if (ticket) {
        ticket.remove();
        process.off("exit", ticket.remove);
      }
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
