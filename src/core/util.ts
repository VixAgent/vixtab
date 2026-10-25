// Small helpers shared by every command: paths, errors, sleeping, formatting.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";

export const IS_WIN = process.platform === "win32";

/** Forward slashes, no trailing slash (except a root like "/" or "C:/"). */
export const norm = (p: string) => p.replace(/\\/g, "/").replace(/(?<=[^/:])\/+$/, "");
/** Comparison key for paths: Windows paths are case-insensitive and `d:` equals `D:`. */
export const pathKey = (p: string) => (IS_WIN ? norm(p).toLowerCase() : norm(p));
/** `p` is `root` or inside it; Windows 8.3 short names on either side are expanded first (see longPath). */
export const isInside = (p: string, root: string) => {
  const a = pathKey(longPath(p)), b = pathKey(longPath(root));
  return a === b || a.startsWith(b.endsWith("/") ? b : b + "/");
};
/** The same folder, also when one side is spelled with 8.3 short names (a shell or a window opened through one). */
export const samePath = (a: string, b: string) => pathKey(longPath(a)) === pathKey(longPath(b));
/**
 * Windows 8.3 short names (C:\Users\RUNNER~1\…) name the same folder as the long form; processes report whichever form
 * they were started with. Expand them before comparing. Elsewhere (and for paths without "~") the path is returned as is.
 */
export function longPath(p: string): string {
  if (!IS_WIN || !p.includes("~")) return p;
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}
/** OS-native spelling (backslashes on Windows) for printing or for passing to native programs. */
export const native = (p: string) => (IS_WIN ? norm(p).replace(/\//g, "\\") : norm(p));

export const HOME = norm(process.env.USERPROFILE && IS_WIN ? process.env.USERPROFILE : homedir());

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** An error that the CLI prints without a stack trace and turns into an exit code. */
export class VixError extends Error {
  constructor(message: string, public code = 1) {
    super(message);
  }
}
export function fail(message: string, code = 1): never {
  throw new VixError(message, code);
}

export const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
export const today = () => new Date().toISOString().slice(0, 10);
export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const slugify = (s: string) =>
  s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "ticket";

/** Parse "6G", "512M", "2048" (MB) into megabytes. */
export function parseSizeMB(s: string | number | undefined, fallback: number): number {
  if (s === undefined || s === "") return fallback;
  if (typeof s === "number") return s;
  const m = /^(\d+(?:\.\d+)?)\s*([GMK]?)B?$/i.exec(s.trim());
  if (!m) return fallback;
  const n = Number(m[1]), u = m[2].toUpperCase();
  return Math.round(u === "G" ? n * 1024 : u === "K" ? n / 1024 : n);
}
export const fmtMB = (mb: number) => (mb >= 10240 ? `${(mb / 1024).toFixed(0)}G` : mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${mb}M`);

/** Windows reserved device names (CON, NUL, COM1…) cannot be file names on NTFS, whatever the extension or case. */
export const isReservedName = (name: string) => /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i.test(name);
