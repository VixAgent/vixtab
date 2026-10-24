// Linux (tested on Ubuntu 24.04/26.04, local VS Code and VS Code Remote SSH).
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { run, runInherit } from "../core/run.ts";
import { HOME } from "../core/util.ts";
import type { Platform, Proc } from "./types.ts";

const meminfo = () => readFileSync("/proc/meminfo", "utf8");
const field = (t: string, k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(t)?.[1] ?? 0);

let systemdScope: boolean | undefined;
function hasSystemdScope(): boolean {
  if (systemdScope === undefined) systemdScope = run(["systemd-run", "--user", "--scope", "-q", "true"]).code === 0;
  return systemdScope;
}

export const linux: Platform = {
  id: "linux",
  claudeBinary: "claude",
  exeSuffix: "",

  freeRamMB: () => Math.floor(field(meminfo(), "MemAvailable") / 1024),
  swapUsedMB: () => {
    const t = meminfo();
    return Math.floor((field(t, "SwapTotal") - field(t, "SwapFree")) / 1024);
  },
  commitMB: () => null, // Linux overcommits; the OOM killer, not the commit limit, is what bites

  processes(): Proc[] {
    const out: Proc[] = [];
    const hz = 100;
    const boot = Date.now() - Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]) * 1000;
    const uid = process.getuid!();
    for (const d of readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try {
        if (statSync(`/proc/${d}`).uid !== uid) continue; // only our own processes
        const st = readFileSync(`/proc/${d}/stat`, "utf8");
        const rest = st.slice(st.lastIndexOf(")") + 2).split(" ");
        let cwd: string | null = null;
        try {
          cwd = readlinkSync(`/proc/${d}/cwd`).replace(/ \(deleted\)$/, "");
        } catch {}
        out.push({
          pid: Number(d),
          ppid: Number(rest[1]),
          name: st.slice(st.indexOf("(") + 1, st.lastIndexOf(")")),
          cmdline: readFileSync(`/proc/${d}/cmdline`, "utf8").replace(/\0/g, " ").trim(),
          cwd,
          started: boot + (Number(rest[19]) / hz) * 1000,
        });
      } catch {}
    }
    return out;
  },

  topProcesses: (n) =>
    run(["ps", "-u", String(process.getuid!()), "-o", "pid=,rss=,args=", "--sort=-rss"]).out
      .split("\n").filter(Boolean).slice(0, n)
      .map((l) => {
        const [pid, rss, ...a] = l.trim().split(/\s+/);
        return `${pid} ${Math.round(Number(rss) / 1024)}MB ${a.join(" ").slice(0, 150)}`;
      }).join("\n"),

  memoryCapKind: () => (hasSystemdScope() ? "systemd user scope (MemoryMax)" : "none: no systemd user session (WSL/container) — runs are not capped"),

  async runCapped(cmd, capMB) {
    if (hasSystemdScope()) {
      return runInherit(["systemd-run", "--user", "--scope", "-q", "-p", `MemoryMax=${capMB}M`, "-p", "MemorySwapMax=4G", "--nice=10", "--", ...cmd]);
    }
    return runInherit(["nice", "-n", "10", ...cmd]);
  },

  rendererLoad() {
    const renderers = linux.processes().filter((p) => /--type=renderer/.test(p.cmdline) && /code|electron|cursor/i.test(p.name + p.cmdline));
    const ticks = (pid: number) => {
      const m = new Map<string, number>();
      try {
        for (const t of readdirSync(`/proc/${pid}/task`)) {
          const st = readFileSync(`/proc/${pid}/task/${t}/stat`, "utf8");
          const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
          m.set(t, Number(f[11]) + Number(f[12])); // utime + stime (fields 14, 15)
        }
      } catch {}
      return m;
    };
    const before = renderers.map((r) => ticks(r.pid));
    Bun.sleepSync(2000);
    return renderers.map((r, i) => {
      let max = 0;
      for (const [t, v] of ticks(r.pid)) max = Math.max(max, v - (before[i].get(t) ?? v));
      return { pid: r.pid, pct: Math.round(max / 2) }; // 100 ticks/s ⇒ ticks over 2 s / 2 = % of one core
    });
  },

  vscodeExtensionRoots: () =>
    [".vscode/extensions", ".vscode-server/extensions", ".vscode-insiders/extensions", ".vscode-server-insiders/extensions"].map((d) => join(HOME, d)),

  addToUserPath(dir) {
    const bin = join(HOME, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    const link = join(bin, "vixtab");
    try {
      if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) unlinkSync(link);
    } catch {}
    symlinkSync(join(dir, "vixtab"), link);
    const onPath = (process.env.PATH ?? "").split(":").includes(bin);
    return `linked ${link}${onPath ? "" : ` (add ${bin} to PATH, or log in again: ~/.profile adds it when it exists)`}`;
  },
};
