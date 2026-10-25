// The private board (<home>/board) and legacy boards (a folder on <remote>/<branch>), through the CLI, in throwaway repositories.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addRow, boardReadme, renderTicket } from "../src/core/board.ts";
import { loadConfig } from "../src/core/config.ts";

const root = mkdtempSync(join(tmpdir(), "vixtab-boardstore-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cli = join(import.meta.dir, "..", "src", "cli.ts");
// No user identity anywhere (board commits fall back to VixTab's own), isolated Claude config and VixTab prefs.
writeFileSync(join(root, "empty.gitconfig"), "");
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  GIT_CONFIG_GLOBAL: join(root, "empty.gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  CLAUDE_CONFIG_DIR: join(root, "claude"),
  VIXTAB_PREFS: join(root, "prefs", "config.json"),
};
delete env.VIXTAB_HOME;
delete env.VIXTAB_REPO;

const sh = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const git = (cwd: string, ...a: string[]) => {
  const r = sh(["git", ...a], cwd);
  if (r.code !== 0) throw new Error(`git ${a.join(" ")}: ${r.err}`);
  return r.out;
};
const vt = (cwd: string, ...a: string[]) => sh([process.execPath, cli, ...a], cwd);

/** <dir>/origin.git (bare) + <dir>/project with one commit on main, and `files` in that commit. */
function project(name: string, files: Record<string, string> = {}): string {
  const dir = join(root, name), P = join(dir, "project");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(dir, "clone", "-q", "origin.git", "project");
  git(P, "checkout", "-q", "-B", "main");
  git(P, "config", "user.name", "Test");
  git(P, "config", "user.email", "test@example.invalid");
  for (const [p, t] of Object.entries({ "README.md": "# Demo\n", ...files })) {
    mkdirSync(join(P, p, ".."), { recursive: true });
    writeFileSync(join(P, p), t);
  }
  git(P, "add", "-A");
  git(P, "commit", "-q", "-m", "initial");
  git(P, "push", "-q", "-u", "origin", "main");
  return P;
}

describe("private board", () => {
  const P = project("private");
  const home = `${P}.vixtab`, B = join(home, "board");

  test("init creates the board and the config in the home, commits nothing in the project", () => {
    const r = vt(P, "init", "--push");
    expect(r.code).toBe(0);
    expect(r.out).toContain("--push is not needed");
    for (const f of [".git", "README.md", "TEMPLATE.md"]) expect(existsSync(join(B, f))).toBe(true);
    expect(existsSync(join(home, "vixtab.config.json"))).toBe(true);
    expect(existsSync(join(P, "vixtab.config.json"))).toBe(false);
    expect(git(P, "status", "--porcelain")).toBe("");
    expect(git(B, "log", "--format=%an <%ae> %s")).toBe("VixTab <vixtab@localhost> vixtab: create the board\n");
    expect(vt(P, "init").out).toContain("Already initialized (nothing created)");
  }, 60_000);

  test("new, list, show, ask, answer, release: commits on the board, none on the project's remote", () => {
    const n = vt(P, "ticket", "new", "First", "--area", "a.md");
    expect(n.code).toBe(0);
    expect(n.out).toMatch(/^id=T-001 file=.*T-001-first\.md$/m);
    expect(vt(P, "ticket", "new", "Second", "--after", "T-001", "--model", "sonnet").out).toMatch(/^id=T-002 /m);
    expect(readFileSync(join(B, "T-002-second.md"), "utf8")).toContain("- **Model:** sonnet");
    const list = JSON.parse(vt(P, "ticket", "list", "--json").out);
    expect(list.map((t: any) => [t.id, t.status, t.after])).toEqual([["T-001", "☐ TODO", []], ["T-002", "☐ TODO", ["T-001"]]]);
    expect(vt(P, "ticket", "ready").out).toMatch(/^ready: T-001$/m);
    expect(vt(P, "ticket", "ask", "T-001", "Stock or water?").code).toBe(0);
    expect(JSON.parse(vt(P, "ticket", "list", "--json").out)[0].status).toBe("❓ ASK (unknown)");
    expect(vt(P, "ticket", "answer", "T-001", "Stock.").code).toBe(0);
    expect(vt(P, "ticket", "show", "T-001", "--questions").out).toMatch(/Stock or water\?[\s\S]*\*\*A \(.*\):\*\* Stock\./);
    expect(vt(P, "ticket", "release", "T-001").code).toBe(0);
    expect(git(B, "log", "--format=%s").trim().split("\n")).toEqual([
      "tickets: T-001 released by unknown", "tickets: T-001 answer", "tickets: T-001 question", "tickets: add Second", "tickets: add First",
      "vixtab: create the board",
    ]);
    expect(git(B, "status", "--porcelain")).toBe("");
    git(P, "fetch", "-q", "origin");
    expect(git(P, "log", "--format=%s", "origin/main")).toBe("initial\n");
    expect(git(P, "ls-tree", "-r", "--name-only", "origin/main")).toBe("README.md\n");
  }, 60_000);

  test("status --json reports the private board, and no legacy warning is printed", () => {
    const r = vt(P, "status", "--json", "--offline");
    const board = JSON.parse(r.out).board;
    expect(board).toMatchObject({ state: "ok", kind: "private", total: 2, open: 2 });
    expect(r.err).not.toContain("Warning");
    expect(vt(P, "ticket", "list").err).not.toContain("Warning");
  }, 60_000);
});

describe("legacy board on main", () => {
  const c = { prefix: "T-", digits: 3, branch: "main" } as any;
  const P = project("legacy", {
    "vixtab.config.json": JSON.stringify({ board: "tickets", branch: "main" }),
    "tickets/README.md": addRow(boardReadme(c), { id: "T-001", file: "T-001-old.md", title: "Old", after: [] }),
    "tickets/T-001-old.md": renderTicket("T-001", "Old", { area: "x.md" }),
  });

  test("reads and writes go to main as before, with the warning once per command", () => {
    const r = vt(P, "ticket", "list", "--json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).map((t: any) => t.id)).toEqual(["T-001"]);
    expect(r.err.match(/this board is on origin\/main, published with your code: vixtab board migrate/g)?.length).toBe(1);
    const n = vt(P, "ticket", "new", "Second");
    expect(n.out).toMatch(/^id=T-002 file=tickets\/T-002-second\.md$/m);
    expect(n.err.match(/Warning: this board is on origin\/main/g)?.length).toBe(1);
    git(P, "fetch", "-q", "origin");
    expect(git(P, "log", "-1", "--format=%s", "origin/main")).toBe("tickets: add Second\n");
    expect(vt(P, "ticket", "show", "T-002").out).toContain("# T-002: Second");
    expect(existsSync(`${P}.vixtab/board`)).toBe(false);
  }, 60_000);

  test("status and doctor say it; init does not create a private board next to it", () => {
    const s = vt(P, "status", "--json", "--offline");
    expect(JSON.parse(s.out).board).toMatchObject({ state: "ok", kind: "legacy", path: "tickets/README.md", total: 2 });
    expect(JSON.parse(s.out).board.warning).toContain("vixtab board migrate");
    expect(s.err).not.toContain("Warning");
    const d = JSON.parse(vt(P, "doctor", "--json").out).find((x: any) => x.name === "board");
    expect(d).toMatchObject({ status: "WARN", fix: "vixtab board migrate" });
    const i = vt(P, "init");
    expect(i.out).toContain("Already initialized: this board is on origin/main");
    expect(existsSync(`${P}.vixtab/board`)).toBe(false);
  }, 60_000);
});

describe("config location", () => {
  const P = project("config");
  const home = `${P}.vixtab`;
  const saved = { home: process.env.VIXTAB_HOME, repo: process.env.VIXTAB_REPO };

  test("<home>/vixtab.config.json is read when the repository has none; the repository's own wins", () => {
    delete process.env.VIXTAB_HOME;
    delete process.env.VIXTAB_REPO;
    try {
      expect(loadConfig(P).configFile).toBeNull();
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "vixtab.config.json"), JSON.stringify({ test: "from-home", home: "elsewhere" }));
      const h = loadConfig(P);
      expect(h.configFile?.endsWith("project.vixtab/vixtab.config.json")).toBe(true);
      expect(h.test).toBe("from-home");
      expect(h.home.endsWith("/project.vixtab")).toBe(true); // a config found in the home cannot move it
      writeFileSync(join(P, "vixtab.config.json"), JSON.stringify({ test: "from-repo" }));
      expect(loadConfig(P).test).toBe("from-repo");
    } finally {
      if (saved.home !== undefined) process.env.VIXTAB_HOME = saved.home;
      if (saved.repo !== undefined) process.env.VIXTAB_REPO = saved.repo;
    }
  });
});

describe("board migrate", () => {
  // An older protocol text above the table (it said the board is on main).
  let readme = addRow("# Tickets\n\nStatus cells are written on main.\n", { id: "T-001", file: "T-001-busy.md", title: "Busy", after: [] });
  readme = addRow(readme, { id: "T-002", file: "T-002-later.md", title: "Later", after: ["T-001"] }).replace(
    /(\[T-001\].*\| )☐ TODO( \|)/,
    "$1⏳ DOING (s1)$2",
  );
  const config = JSON.stringify({ board: "tickets", branch: "main", test: "bun test" }) + "\n";
  const P = project("migrate", {
    "vixtab.config.json": config,
    "tickets/README.md": readme,
    "tickets/T-001-busy.md": renderTicket("T-001", "Busy", { area: "a.md" }),
    "tickets/T-002-later.md": renderTicket("T-002", "Later", { after: ["T-001"] }),
    "tickets/HANDOVER.md": "state\n",
    "src/app.ts": "export {};\n",
  });
  const home = `${P}.vixtab`, B = join(home, "board");
  const mainFiles = () => (git(P, "fetch", "-q", "origin"), git(P, "ls-tree", "-r", "--name-only", "origin/main").trim().split("\n"));

  test("refused while a ticket is in flight; --dry-run lists the plan and changes nothing", () => {
    const r = vt(P, "board", "migrate");
    expect(r.code).toBe(5);
    expect(r.err).toContain("Not migrated: T-001 (⏳ DOING (s1)) is in flight");
    expect(r.err).toContain("--force");
    expect(vt(P, "ticket", "release", "T-001").code).toBe(0); // a legacy write: one more commit on main
    const before = git(P, "rev-parse", "origin/main");
    const d = vt(P, "board", "migrate", "--dry-run");
    expect(d.code).toBe(0);
    expect(d.out).toContain("Dry run: nothing is changed.");
    expect(d.out).toMatch(/Would import 4 file\(s\) from origin\/main at [0-9a-f]{12} into the private board/);
    expect(d.out).toContain("tickets/T-002-later.md");
    expect(d.out).toContain('Would commit "Move the VixTab board out of the repository" on origin/main, removing tickets/ (4 file(s)) and vixtab.config.json');
    expect(d.out).toContain("remain in the git history of origin");
    expect(existsSync(B) || existsSync(join(home, "vixtab.config.json"))).toBe(false);
    git(P, "fetch", "-q", "origin");
    expect(git(P, "rev-parse", "origin/main")).toBe(before);
  }, 60_000);

  test("moves the board into <home>/board and removes it from main in one commit", () => {
    const released = git(P, "rev-parse", "origin/main").trim();
    const r = vt(P, "board", "migrate");
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(r.out).toContain("Removed tickets/ (4 file(s)) and vixtab.config.json from origin/main");
    expect(r.out).toContain("Rewriting that history is your own decision");
    // The private board: every file, the import commit (verbatim), then the current protocol text above the same table.
    expect(git(B, "log", "--format=%an %s").trim().split("\n")).toEqual([
      "VixTab tickets: protocol text for the private board",
      `VixTab import from origin/main at ${released.slice(0, 12)}`,
    ]);
    expect(git(B, "ls-files").trim().split("\n").sort()).toEqual(["HANDOVER.md", "README.md", "T-001-busy.md", "T-002-later.md", "TEMPLATE.md"]);
    expect(git(B, "show", `HEAD~1:README.md`)).toBe(git(P, "show", `${released}:tickets/README.md`));
    const now = readFileSync(join(B, "README.md"), "utf8");
    expect(now).toContain("The board is private to this machine");
    expect(now).toMatch(/\[T-001\].*☐ TODO/);
    expect(readFileSync(join(home, "vixtab.config.json"), "utf8")).toBe(config);
    // Main: one commit on top, which only deletes the board and the config.
    expect(mainFiles()).toEqual(["README.md", "src/app.ts"]);
    expect(git(P, "log", "--format=%s", `${released}..origin/main`)).toBe("Move the VixTab board out of the repository\n");
    expect(git(P, "diff", "--name-status", released, "origin/main").trim().split("\n").every((l) => l.startsWith("D\t"))).toBe(true);
  }, 60_000);

  test("a second run has nothing to migrate; every command uses the private board without the warning", () => {
    const again = vt(P, "board", "migrate");
    expect(again.code).toBe(0);
    expect(again.out).toContain("Nothing to migrate: the board is private");
    git(P, "pull", "-q", "--ff-only");
    expect(existsSync(join(P, "tickets"))).toBe(false);
    const list = vt(P, "ticket", "list", "--json");
    expect(list.err).toBe("");
    expect(JSON.parse(list.out).map((t: any) => t.id)).toEqual(["T-001", "T-002"]);
    expect(vt(P, "ticket", "new", "Third").out).toMatch(/^id=T-003 file=.*T-003-third\.md$/m);
    expect(git(B, "log", "-1", "--format=%s")).toBe("tickets: add Third\n");
    expect(JSON.parse(vt(P, "status", "--json", "--offline").out).board).toMatchObject({ kind: "private", total: 3 });
    expect(mainFiles()).toEqual(["README.md", "src/app.ts"]);
  }, 60_000);

  test("board path and board write", () => {
    const slash = (p: string) => p.replace(/\\/g, "/");
    expect(slash(vt(P, "board", "path").out.trim())).toBe(slash(B));
    writeFileSync(join(root, "handover.md"), "next: T-003\n");
    const w = vt(P, "board", "write", "HANDOVER.md", "--file", join(root, "handover.md"));
    expect(w.code).toBe(0);
    expect(readFileSync(join(B, "HANDOVER.md"), "utf8")).toBe("next: T-003\n");
    expect(git(B, "log", "-1", "--format=%s")).toBe("tickets: write HANDOVER.md\n");
    expect(vt(P, "board", "write", "HANDOVER.md", "--file", join(root, "handover.md")).out).toContain("unchanged");
    const stdin = Bun.spawnSync([process.execPath, cli, "board", "write", "notes/plan.md", "--file", "-"], { cwd: P, env, stdin: Buffer.from("plan\n") });
    expect(stdin.exitCode).toBe(0);
    expect(readFileSync(join(B, "notes", "plan.md"), "utf8")).toBe("plan\n");
    for (const bad of ["README.md", "T-001-busy.md", "../x.md", ".git/config"]) expect(vt(P, "board", "write", bad, "--file", join(root, "handover.md")).code).toBe(2);
    expect(git(B, "status", "--porcelain")).toBe("");
  }, 60_000);
});

describe("board migrate --keep-on-main, then without it", () => {
  const c = { prefix: "T-", digits: 3, branch: "main" } as any;
  const P = project("migrate-keep", {
    "vixtab.config.json": JSON.stringify({ branch: "main" }),
    "tickets/README.md": addRow(boardReadme(c), { id: "T-001", file: "T-001-old.md", title: "Old", after: [] }),
    "tickets/T-001-old.md": renderTicket("T-001", "Old", {}),
  });
  const B = join(`${P}.vixtab`, "board");

  test("keeps the old copy on main; a later run removes it while it is still what was imported", () => {
    const k = vt(P, "board", "migrate", "--keep-on-main");
    expect(k.code).toBe(0);
    expect(k.out).toContain("Kept tickets/ (2 file(s)) and vixtab.config.json on origin/main (--keep-on-main)");
    expect(existsSync(join(B, "T-001-old.md"))).toBe(true);
    git(P, "fetch", "-q", "origin");
    expect(git(P, "log", "--format=%s", "origin/main")).toBe("initial\n");
    expect(vt(P, "ticket", "list").err).toBe(""); // the private board wins: no warning
    expect(vt(P, "board", "migrate", "--keep-on-main").out).toContain("kept (--keep-on-main)");
    const r = vt(P, "board", "migrate");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Removed tickets/ (2 file(s)) and vixtab.config.json from origin/main");
    expect(git(B, "log", "--format=%s").split("\n").filter((s) => s.startsWith("import from")).length).toBe(1); // not imported twice
    git(P, "fetch", "-q", "origin");
    expect(git(P, "ls-tree", "-r", "--name-only", "origin/main")).toBe("README.md\n");
  }, 60_000);
});
