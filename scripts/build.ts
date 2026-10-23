// Build release artifacts into dist/:
//   dist/<target>/vixtab[.exe]          standalone CLI (Bun runtime included — no Bun/Node/Python needed on the user's machine)
//   dist/vixtab-<target>.vsix           VS Code extension with the CLI inside (VS Code installs the right one per platform)
//   dist/vixtab-<os>-<arch>.tar.gz|zip  CLI only, for terminal users
//   dist/SHA256SUMS
// Usage: bun scripts/build.ts [--targets linux-x64,win32-x64,linux-arm64] [--no-vsix]
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const ext = JSON.parse(readFileSync(join(ROOT, "extension", "package.json"), "utf8"));
if (ext.version !== VERSION) throw new Error(`extension/package.json version ${ext.version} != ${VERSION}`);
if (!readFileSync(join(ROOT, "src", "version.ts"), "utf8").includes(`"${VERSION}"`)) throw new Error("src/version.ts is out of date");

const ALL: Record<string, { bun: string; exe: string; archive: string }> = {
  "linux-x64": { bun: "bun-linux-x64", exe: "vixtab", archive: "vixtab-linux-x64.tar.gz" },
  "linux-arm64": { bun: "bun-linux-arm64", exe: "vixtab", archive: "vixtab-linux-arm64.tar.gz" },
  "win32-x64": { bun: "bun-windows-x64", exe: "vixtab.exe", archive: "vixtab-windows-x64.zip" },
};
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : undefined);
const targets = (arg("targets") ?? "linux-x64,win32-x64,linux-arm64").split(",");

function sh(cmd: string[], cwd = ROOT) {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`failed: ${cmd.join(" ")}`);
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
const sums: string[] = [];
const sum = (file: string) => sums.push(`${new Bun.CryptoHasher("sha256").update(readFileSync(join(DIST, file))).digest("hex")}  ${file}`);

for (const t of targets) {
  const spec = ALL[t] ?? (() => { throw new Error(`unknown target ${t}`); })();
  const outDir = join(DIST, t), exe = join(outDir, spec.exe);
  mkdirSync(outDir, { recursive: true });
  console.log(`\n== CLI ${t}`);
  sh(["bun", "build", "src/cli.ts", "--compile", "--minify", `--target=${spec.bun}`, "--outfile", exe]);
  if (!spec.exe.endsWith(".exe")) chmodSync(exe, 0o755);
  for (const f of ["LICENSE", "README.md"]) cpSync(join(ROOT, f), join(outDir, f));
  if (spec.archive.endsWith(".zip")) sh(["zip", "-q", "-j", join(DIST, spec.archive), exe, join(outDir, "LICENSE"), join(outDir, "README.md")]);
  else sh(["tar", "-czf", join(DIST, spec.archive), "-C", outDir, spec.exe, "LICENSE", "README.md"]);
  sum(spec.archive);

  if (process.argv.includes("--no-vsix")) continue;
  console.log(`== VSIX ${t}`);
  const stage = join(DIST, `ext-${t}`);
  cpSync(join(ROOT, "extension"), stage, { recursive: true });
  mkdirSync(join(stage, "bin"), { recursive: true });
  cpSync(exe, join(stage, "bin", spec.exe));
  cpSync(join(ROOT, "LICENSE"), join(stage, "LICENSE"));
  const vsix = `vixtab-${t}.vsix`;
  sh([join(ROOT, "node_modules", ".bin", "vsce"), "package", "--target", t, "--no-dependencies", "--out", join(DIST, vsix)], stage);
  rmSync(stage, { recursive: true, force: true });
  sum(vsix);
}
writeFileSync(join(DIST, "SHA256SUMS"), sums.join("\n") + "\n");
console.log(`\n${sums.join("\n")}`);
