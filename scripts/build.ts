// Build release artifacts into dist/:
//   dist/<target>/vixtab[.exe]          standalone CLI (Bun runtime included — no Bun/Node/Python needed on the user's machine)
//   dist/vixtab-<target>.vsix           VS Code extension with the CLI inside (VS Code installs the right one per platform)
//   dist/vixtab-<os>-<arch>.tar.gz|zip  CLI only, for terminal users
//   dist/SHA256SUMS
// Usage: bun scripts/build.ts [--targets linux-x64,win32-x64,linux-arm64] [--no-vsix]
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const ext = JSON.parse(readFileSync(join(ROOT, "extension", "package.json"), "utf8"));
if (ext.version !== VERSION) throw new Error(`extension/package.json version ${ext.version} != ${VERSION}`);
if (!readFileSync(join(ROOT, "src", "version.ts"), "utf8").includes(`"${VERSION}"`)) throw new Error("src/version.ts is out of date");

// Baseline x64 builds run on CPUs without AVX2 too. `npm` = the package that ships that Bun runtime (used for cross-compiling).
const ALL: Record<string, { bun: string; exe: string; archive: string; npm: string; runtime: string }> = {
  "linux-x64": { bun: "bun-linux-x64-baseline", exe: "vixtab", archive: "vixtab-linux-x64.tar.gz", npm: "@oven/bun-linux-x64-baseline", runtime: "bun" },
  "linux-arm64": { bun: "bun-linux-arm64", exe: "vixtab", archive: "vixtab-linux-arm64.tar.gz", npm: "@oven/bun-linux-aarch64", runtime: "bun" },
  "win32-x64": { bun: "bun-windows-x64-baseline", exe: "vixtab.exe", archive: "vixtab-windows-x64.zip", npm: "@oven/bun-windows-x64-baseline", runtime: "bun.exe" },
};

/**
 * The Bun runtime to embed, downloaded once from npm and checked against the registry's sha512. `bun build --compile` can download
 * it by itself, but on Windows it fails to extract Linux runtimes ("Failed to extract executable"), so do it here and pass
 * --compile-executable-path. Cached in node_modules/.cache/vixtab-runtimes/.
 */
async function runtimeFor(spec: (typeof ALL)[string]): Promise<string> {
  const v = Bun.version, dir = join(ROOT, "node_modules", ".cache", "vixtab-runtimes", `${spec.npm.replace("/", "+")}-${v}`);
  const bin = join(dir, "package", "bin", spec.runtime);
  if (existsSync(bin)) return bin;
  const meta: any = await (await fetch(`https://registry.npmjs.org/${spec.npm.replace("/", "%2f")}/${v}`)).json();
  if (!meta?.dist?.tarball || !meta.dist.integrity?.startsWith("sha512-")) throw new Error(`no ${spec.npm}@${v} on npm`);
  const tgz = new Uint8Array(await (await fetch(meta.dist.tarball)).arrayBuffer());
  const got = "sha512-" + new Bun.CryptoHasher("sha512").update(tgz).digest("base64");
  if (got !== meta.dist.integrity) throw new Error(`${spec.npm}@${v}: checksum mismatch`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "runtime.tgz"), tgz);
  sh([TAR, "-xzf", join(dir, "runtime.tgz"), "-C", dir]);
  if (!existsSync(bin)) throw new Error(`${spec.npm}@${v}: ${spec.runtime} not found in the package`);
  return bin;
}
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : undefined);
const targets = (arg("targets") ?? "linux-x64,win32-x64,linux-arm64").split(",");

function sh(cmd: string[], cwd = ROOT) {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`failed: ${cmd.join(" ")}`);
}

// Builds on Linux and on Windows. Windows has no `zip`, and `tar` on PATH may be GNU tar from Git (no zip support): use the
// system bsdtar, which writes both .zip (-a picks the format from the suffix) and .tar.gz.
const WIN = process.platform === "win32";
const TAR = WIN ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
/** files[0] is the program. */
function archive(out: string, dir: string, files: string[]) {
  if (out.endsWith(".zip")) sh(WIN || !Bun.which("zip") ? [TAR, "-a", "-c", "-f", out, "-C", dir, ...files] : ["zip", "-q", "-j", out, ...files.map((f) => join(dir, f))]);
  else writeFileSync(out, Bun.gzipSync(ustar(dir, files)));
}

/**
 * A plain ustar archive written here instead of by `tar`: built on Windows, `tar` stores mode 0666 and the Linux program loses its
 * executable bit. files[0] (the program) gets 0755, the others 0644; owner root, mtime = now.
 */
function ustar(dir: string, files: string[]): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [], enc = new TextEncoder(), now = Math.floor(Date.now() / 1000);
  const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";
  for (const name of files) {
    const data = readFileSync(join(dir, name));
    const h = new Uint8Array(512);
    const put = (s: string, at: number) => h.set(enc.encode(s), at);
    put(name, 0);
    put(oct(name === files[0] ? 0o755 : 0o644, 8), 100);
    put(oct(0, 8), 108);
    put(oct(0, 8), 116);
    put(oct(data.length, 12), 124);
    put(oct(now, 12), 136);
    put("        ", 148); // checksum field counts as spaces while summing
    put("0", 156);
    put("ustar\0" + "00", 257);
    put("root", 265);
    put("root", 297);
    put(oct(h.reduce((a, b) => a + b, 0), 7) + " ", 148);
    parts.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, at), (at += p.length);
  return out;
}
// vsce is a Node program; node_modules/.bin/vsce is a symlink on Linux but a .exe shim on Windows — call its script directly.
const VSCE = [Bun.which("node") ?? process.execPath, join(ROOT, "node_modules", "@vscode", "vsce", "vsce")];

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
const sums: string[] = [];
const sum = (file: string) => sums.push(`${new Bun.CryptoHasher("sha256").update(readFileSync(join(DIST, file))).digest("hex")}  ${file}`);

for (const t of targets) {
  const spec = ALL[t] ?? (() => { throw new Error(`unknown target ${t}`); })();
  const outDir = join(DIST, t), exe = join(outDir, spec.exe);
  mkdirSync(outDir, { recursive: true });
  console.log(`\n== CLI ${t}`);
  sh([process.execPath, "build", "src/cli.ts", "--compile", "--minify", `--target=${spec.bun}`, `--compile-executable-path=${await runtimeFor(spec)}`, "--outfile", exe]);
  if (!spec.exe.endsWith(".exe")) chmodSync(exe, 0o755);
  for (const f of ["LICENSE", "README.md"]) cpSync(join(ROOT, f), join(outDir, f));
  archive(join(DIST, spec.archive), outDir, [spec.exe, "LICENSE", "README.md"]);
  sum(spec.archive);

  if (process.argv.includes("--no-vsix")) continue;
  console.log(`== VSIX ${t}`);
  const stage = join(DIST, `ext-${t}`);
  cpSync(join(ROOT, "extension"), stage, { recursive: true });
  mkdirSync(join(stage, "bin"), { recursive: true });
  cpSync(exe, join(stage, "bin", spec.exe));
  cpSync(join(ROOT, "LICENSE"), join(stage, "LICENSE"));
  const vsix = `vixtab-${t}.vsix`;
  sh([...VSCE, "package", "--target", t, "--no-dependencies", "--out", join(DIST, vsix)], stage);
  rmSync(stage, { recursive: true, force: true });
  sum(vsix);
}
writeFileSync(join(DIST, "SHA256SUMS"), sums.join("\n") + "\n");
console.log(`\n${sums.join("\n")}`);
