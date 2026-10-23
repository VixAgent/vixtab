// Everything that differs between Linux and Windows lives behind this interface.
export type Proc = {
  pid: number;
  ppid: number;
  name: string;
  cmdline: string;
  /** Current working directory, or null when it cannot be read (other user, 32-bit process…). */
  cwd: string | null;
  /** Start time, ms since epoch (0 = unknown). */
  started: number;
};

export interface Platform {
  readonly id: "linux" | "windows";
  freeRamMB(): number;
  swapUsedMB(): number;
  /** Commit charge vs commit limit. Windows fails allocations when the commit limit is reached even with RAM free. */
  commitMB(): { used: number; limit: number } | null;
  processes(): Proc[];
  /** The n processes using the most memory, one per line, for alerts. */
  topProcesses(n: number): string;
  /** How `runCapped` enforces the memory cap on this machine ("systemd scope", "job object", or "none: …"). */
  memoryCapKind(): string;
  /** Run a command with a memory cap and low CPU priority; resolves to its exit code. */
  runCapped(cmd: string[], capMB: number): Promise<number>;
  /** Folders where VS Code keeps extensions (the Claude Code extension ships the `claude` binary). */
  vscodeExtensionRoots(): string[];
  readonly claudeBinary: string;
  readonly exeSuffix: string;
  /** Make `dir` part of the user's PATH for new shells; returns a human-readable note. */
  addToUserPath(dir: string): string;
}
