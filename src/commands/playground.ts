// vixtab playground — a self-contained sandbox (local bare "origin" + a tiny recipe-book project + 5 tickets) to try VixTab
// without touching real repositories, plus scripted demos. `playground demo board` doubles as the end-to-end test.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import README from "../../playground/project/README.md" with { type: "text" };
import APPLE from "../../playground/project/recipes/apple-pie.md" with { type: "text" };
import INDEX from "../../playground/project/recipes/INDEX.md" with { type: "text" };
import OMELETTE from "../../playground/project/recipes/omelette.md" with { type: "text" };
import SOUP from "../../playground/project/recipes/tomato-soup.md" with { type: "text" };
import T1 from "../../playground/tickets/T-001.md" with { type: "text" };
import T2 from "../../playground/tickets/T-002.md" with { type: "text" };
import T3 from "../../playground/tickets/T-003.md" with { type: "text" };
import T4 from "../../playground/tickets/T-004.md" with { type: "text" };
import T5 from "../../playground/tickets/T-005.md" with { type: "text" };
import { has, parseArgs, str } from "../core/args.ts";
import { waitForWindow, windows } from "../core/bridge.ts";
import { addRow, boardReadme, renderTicket, ticketBodyTemplate } from "../core/board.ts";
import { git, gitOk, run } from "../core/run.ts";
import { selfArgv, selfLine } from "../core/self.ts";
import { HOME, fail, native, norm, parseSizeMB, pathKey, sleep } from "../core/util.ts";
import { platform } from "../platform/index.ts";
import { BIN_DIR } from "./setup.ts";

export const HELP = `vixtab playground — try VixTab safely

  playground create [<dir>]      sandbox in <dir> (default ~/vixtab-playground): origin.git, project/, 5 tickets
  playground demo board [--dir D] [--keep]
                                 scripted run, no Claude, no tokens: parallel claims, merge queue, red tests blocked,
                                 rebase and question events, done stops processes, abandoned lock taken over
  playground demo tabs [--dir D] [--trust]
                                 opens 3 labeled Claude tabs to the right, evens them, closes them (no tokens)
  playground demo heavy          elastic heavy-run slots and the memory cap, with fake memory hogs
  playground check [<dir>]       the test suite of the sample project (used by ticket merge)
  playground reset [<dir>] · playground remove [<dir>]`;

const TICKETS = [
  { title: "Add a pancakes recipe", area: "recipes/pancakes.md (new), recipes/INDEX.md (one line)", after: [] as string[], body: T1 },
  { title: "Fix the typo in the omelette recipe", area: "recipes/omelette.md (step 1)", after: [], body: T2 },
  { title: "Add a serving size to the tomato soup", area: "recipes/tomato-soup.md (below the title)", after: [], body: T3 },
  { title: "Add a crêpes recipe", area: "recipes/crepes.md (new), recipes/INDEX.md (one line)", after: [], body: T4 },
  { title: "Make the tomato soup vegetarian", area: "recipes/tomato-soup.md (## Ingredients)", after: ["T-003"], body: T5 },
];

const defaultDir = () => join(HOME, "vixtab-playground");
/** Prefer the installed CLI path (stable across extension upgrades) for the test command written into the sandbox config. */
function stableSelf(): string {
  const installed = join(BIN_DIR, `vixtab${platform.exeSuffix}`);
  return existsSync(installed) ? JSON.stringify(norm(installed)) : selfLine();
}

export function createPlayground(dir: string, quiet = false): string {
  dir = norm(resolve(dir));
  if (existsSync(dir) && readdirSync(dir).length) fail(`${native(dir)} already exists (vixtab playground reset ${native(dir)} recreates it)`, 2);
  mkdirSync(dir, { recursive: true });
  const origin = join(dir, "origin.git"), project = join(dir, "project");
  gitOk(dir, "init", "-q", "--bare", "-b", "main", origin);
  gitOk(dir, "clone", "-q", origin, project);
  gitOk(project, "checkout", "-q", "-B", "main");
  if (!git(project, "config", "user.email").out.trim()) {
    gitOk(project, "config", "user.name", "VixTab Playground");
    gitOk(project, "config", "user.email", "playground@vixtab.invalid");
  }
  const files: Record<string, string> = {
    "README.md": README,
    "recipes/INDEX.md": INDEX,
    "recipes/apple-pie.md": APPLE,
    "recipes/omelette.md": OMELETTE,
    "recipes/tomato-soup.md": SOUP,
    "vixtab.config.json": JSON.stringify({ board: "tickets", branch: "main", test: `${stableSelf()} playground check`, ports: { base: 4600 } }, null, 2) + "\n",
    "tickets/TEMPLATE.md": ticketBodyTemplate(),
  };
  const fakeConfig = { branch: "main" } as any;
  let board = boardReadme(fakeConfig);
  TICKETS.forEach((t, i) => {
    const id = `T-00${i + 1}`;
    const file = `${id}-${t.title.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.md`;
    files[`tickets/${file}`] = renderTicket(id, t.title, { area: t.area, after: t.after, body: t.body });
    board = addRow(board, { id, file, title: t.title, after: t.after });
  });
  files["tickets/README.md"] = board;
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(project, p, ".."), { recursive: true });
    writeFileSync(join(project, p), text);
  }
  gitOk(project, "add", "-A");
  gitOk(project, "commit", "-q", "-m", "playground: a tiny recipe book with five tickets");
  gitOk(project, "push", "-q", "-u", "origin", "main");
  if (!quiet) {
    console.log(`Playground ready: ${native(dir)}`);
    console.log(`  project : ${native(project)}   (origin: ${native(origin)}, a local bare repo)`);
    console.log(`  tickets : vixtab ticket list    (run inside the project)`);
    console.log(`  try     : open the project in VS Code, click "VixTab: Orchestrate", type: do all tickets on the board`);
    console.log(`  or      : vixtab playground demo board   (scripted, no Claude, no tokens)`);
  }
  return project;
}

// ── The sample project's test suite ──────────────────────────────────────────────────────────────────────────────────────
export function check(dir: string): string[] {
  const R = join(dir, "recipes"), errors: string[] = [];
  if (!existsSync(R)) return [`no recipes/ folder in ${native(dir)}`];
  const titles = new Map<string, string>();
  for (const f of readdirSync(R).filter((f) => f.endsWith(".md") && f !== "INDEX.md")) {
    const t = readFileSync(join(R, f), "utf8").replace(/\r\n/g, "\n");
    const title = /^# (.+)$/m.exec(t)?.[1]?.trim();
    if (!title || !t.startsWith("# ")) errors.push(`${f}: must start with "# <Title>"`);
    const ing = /^## Ingredients\n+((?:- .+\n?)+)/m.exec(t);
    if (!ing) errors.push(`${f}: needs "## Ingredients" followed by a "- " list`);
    const steps = /^## Steps\n+((?:\d+\. .+\n?)+)/m.exec(t);
    if (!steps) errors.push(`${f}: needs "## Steps" followed by a numbered list`);
    if (/\bTODO\b/.test(t)) errors.push(`${f}: still contains TODO`);
    if (title) titles.set(f, title);
  }
  const idx = existsSync(join(R, "INDEX.md")) ? readFileSync(join(R, "INDEX.md"), "utf8") : "";
  const listed = [...idx.matchAll(/^- \[(.+?)\]\((.+?)\)\s*$/gm)].map((m) => ({ title: m[1], file: m[2] }));
  for (const [f, title] of titles) {
    const n = listed.filter((l) => l.file === f).length;
    if (n !== 1) errors.push(`INDEX.md: ${f} must be listed exactly once (found ${n})`);
    else if (listed.find((l) => l.file === f)!.title !== title) errors.push(`INDEX.md: ${f} is listed with a title different from "${title}"`);
  }
  for (const l of listed) if (!titles.has(l.file)) errors.push(`INDEX.md: ${l.file} does not exist`);
  const sorted = [...listed].sort((a, b) => a.title.localeCompare(b.title, "en", { sensitivity: "base" }));
  if (sorted.some((l, i) => l.file !== listed[i].file)) errors.push("INDEX.md: entries must be sorted by title");
  return errors;
}

// ── Demo helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const self = selfArgv();
type Out = { code: number; out: string };
function vt(args: string[], cwd: string, env: Record<string, string> = {}): Out {
  const r = run([...self, ...args], cwd, { ...process.env, ...env });
  return { code: r.code, out: (r.out + r.err).trim() };
}
async function vtAsync(args: string[], cwd: string): Promise<Out> {
  const p = Bun.spawn([...self, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: (o + e).trim() };
}
const indent = (s: string) => s.split("\n").map((l) => "    " + l).join("\n");

export async function demoBoard(dir: string | undefined, keep: boolean): Promise<boolean> {
  const root = dir ? norm(resolve(dir)) : norm(mkdtempSync(join(tmpdir(), "vixtab-demo-")));
  if (dir && existsSync(root)) rmSync(root, { recursive: true, force: true });
  const P = createPlayground(root, true);
  const home = `${P}.vixtab`, wt = (id: string) => `${home}/wt-${id}`;
  const results: [string, boolean][] = [];
  let n = 0;
  const step = (title: string) => console.log(`\n── ${++n}. ${title}`);
  const expect = (what: string, ok: boolean, detail = "") => {
    results.push([what, ok]);
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}${detail && !ok ? `\n${indent(detail)}` : ""}`);
  };
  const show = (o: Out) => o.out && console.log(indent(o.out.split("\n").slice(0, 14).join("\n")));
  const write = (id: string, rel: string, text: string) => writeFileSync(join(wt(id), rel), text);
  const commit = (id: string, msg: string, ...files: string[]) => {
    gitOk(wt(id), "add", "--", ...files);
    gitOk(wt(id), "commit", "-q", "-m", msg);
  };
  const ticketPath = (id: string) => readdirSync(join(wt(id), "tickets")).find((f) => f.startsWith(id))!;
  const answer = (id: string, text: string) => {
    const f = join(wt(id), "tickets", ticketPath(id));
    writeFileSync(f, readFileSync(f, "utf8").replace(/_\(the session that works on this ticket fills this in[^\n]*\)_/, text));
    commit(id, `tickets: ${id} answer`, `tickets/${ticketPath(id)}`);
  };
  console.log(`Playground: ${native(root)}`);
  try {
    step("Four sessions claim T-001 … T-004 at the same moment");
    const claims = await Promise.all(["T-001", "T-002", "T-003", "T-004"].map((id, i) => vtAsync(["ticket", "claim", id, "--as", `session-${i + 1}`], P)));
    expect("all four claims succeed (status cells are written after rebase, so adjacent rows never conflict)", claims.every((c) => c.code === 0), claims.map((c) => c.out).join("\n"));
    show(vt(["ticket", "list"], P));

    step("Another session tries to take T-001");
    const dup = vt(["ticket", "claim", "T-001", "--as", "intruder"], P);
    show(dup);
    expect("the duplicate claim is refused (exit 5)", dup.code === 5, dup.out);

    step("Each session works in its own worktree (T-004 forgets the Steps section)");
    write("T-001", "recipes/pancakes.md", "# Pancakes\n\n## Ingredients\n\n- 200 g flour\n- 2 eggs\n- 300 ml milk\n\n## Steps\n\n1. Whisk everything into a smooth batter.\n2. Cook small ladles in a hot pan, 1 minute per side.\n");
    write("T-001", "recipes/INDEX.md", INDEX.replace("- [Tomato soup]", "- [Pancakes](pancakes.md)\n- [Tomato soup]"));
    commit("T-001", "recipes: pancakes", "recipes/pancakes.md", "recipes/INDEX.md");
    write("T-002", "recipes/omelette.md", OMELETTE.replace("Whisk the egs", "Whisk the eggs"));
    commit("T-002", "recipes: fix typo in omelette", "recipes/omelette.md");
    write("T-003", "recipes/tomato-soup.md", SOUP.replace("# Tomato soup\n", "# Tomato soup\n\nServes 4.\n"));
    commit("T-003", "recipes: tomato soup serves 4", "recipes/tomato-soup.md");
    write("T-004", "recipes/crepes.md", "# Crêpes\n\n## Ingredients\n\n- 125 g flour\n- 2 eggs\n- 250 ml milk\n");
    write("T-004", "recipes/INDEX.md", INDEX.replace("- [Omelette]", "- [Crêpes](crepes.md)\n- [Omelette]"));
    commit("T-004", "recipes: crepes", "recipes/crepes.md", "recipes/INDEX.md");
    expect("four commits on four branches", true);

    step("Overlap check: which files do two active tickets change?");
    const ov = vt(["ticket", "overlap"], P);
    show(ov);
    expect("recipes/INDEX.md is reported for T-001 and T-004", ov.code === 1 && /recipes\/INDEX\.md: T-001, T-004/.test(ov.out), ov.out);

    step("The orchestrator starts a background waiter for T-004, then T-001 … T-003 merge at the same moment");
    const waiter = Bun.spawn([...self, "wait", "--as", "demo", "--every", "5", "T-004"], { cwd: P, stdout: "pipe", stderr: "pipe" });
    const stateFile = join(home, "locks", "wait-demo.json");
    for (let i = 0; i < 100 && !existsSync(stateFile); i++) await sleep(100);
    const merges = await Promise.all(["T-001", "T-002", "T-003"].map((id) => vtAsync(["ticket", "merge", id], P)));
    expect("three merges pass their tests and land on main one after another", merges.every((m) => m.code === 0), merges.map((m) => m.out).join("\n"));
    const woke = await Promise.race([waiter.exited.then(() => new Response(waiter.stdout).text()), sleep(30_000).then(() => "")]);
    console.log(indent(woke.trim() || "(waiter did not wake up)"));
    expect('the waiter wakes up with "rebase T-004 recipes/INDEX.md"', /^rebase T-004 recipes\/INDEX\.md/m.test(woke), woke);
    if (waiter.exitCode === null) waiter.kill();

    step("T-004 merges its broken recipe");
    const red = vt(["ticket", "merge", "T-004"], P);
    show(red);
    gitOk(P, "fetch", "-q", "origin", "main");
    expect("tests fail after the rebase and NOTHING is pushed", red.code !== 0 && git(P, "cat-file", "-e", "origin/main:recipes/crepes.md").code !== 0, red.out);

    step("T-004 fixes the recipe and merges again");
    write("T-004", "recipes/crepes.md", "# Crêpes\n\n## Ingredients\n\n- 125 g flour\n- 2 eggs\n- 250 ml milk\n\n## Steps\n\n1. Whisk into a thin batter, rest 30 minutes.\n2. Cook thin layers in a buttered pan.\n");
    commit("T-004", "recipes: crepes steps", "recipes/crepes.md");
    const green = vt(["ticket", "merge", "T-004"], P);
    show(green);
    expect("merged; INDEX.md on main lists both new recipes in order", green.code === 0 && /Crêpes[\s\S]*Omelette[\s\S]*Pancakes/.test(gitOk(P, "show", "origin/main:recipes/INDEX.md")), green.out);

    step("A dev server keeps running in T-002's worktree; all four sessions fill in their answer and finish");
    const server = Bun.spawn([...self, "playground", "sleep", "300"], { cwd: wt("T-002"), stdout: "ignore", stderr: "ignore" });
    await sleep(500);
    for (const id of ["T-001", "T-002", "T-003", "T-004"]) answer(id, `Done in the demo. Tests: vixtab playground check (green).`);
    const dones = await Promise.all(["T-001", "T-002", "T-003", "T-004"].map((id) => vtAsync(["ticket", "done", id], P)));
    await sleep(300);
    expect("four tickets done, worktrees removed", dones.every((d) => d.code === 0) && ["T-001", "T-002", "T-003", "T-004"].every((id) => !existsSync(wt(id))), dones.map((d) => d.out).join("\n"));
    expect("the dev server left in T-002's worktree was stopped", server.exitCode !== null || server.killed || (await Promise.race([server.exited.then(() => true), sleep(3000).then(() => false)])));

    step("T-005 (after T-003) needs a decision: the session asks, the orchestrator answers");
    show(vt(["ticket", "claim", "T-005", "--as", "session-5"], P));
    show(vt(["ticket", "ask", "T-005", "Vegetable stock or water?"], P));
    const ev = vt(["wait", "--as", "demo", "--every", "5", "T-005"], P);
    show(ev);
    expect('the waiter reports "ask T-005 #1"', /^ask T-005 #1$/m.test(ev.out), ev.out);
    show(vt(["ticket", "answer", "T-005", "Vegetable stock."], P));
    expect("the question and the answer are in the ticket on main", /Vegetable stock or water\?[\s\S]*A \(.*\):\*\* Vegetable stock\./.test(vt(["ticket", "show", "T-005", "--questions"], P).out));
    gitOk(wt("T-005"), "fetch", "-q", "origin", "main");
    gitOk(wt("T-005"), "rebase", "-q", "origin/main");
    write("T-005", "recipes/tomato-soup.md", readFileSync(join(wt("T-005"), "recipes/tomato-soup.md"), "utf8").replace("chicken stock", "vegetable stock"));
    commit("T-005", "recipes: vegetarian tomato soup", "recipes/tomato-soup.md");
    answer("T-005", "Vegetable stock, as answered. Tests: vixtab playground check (green).");
    const early = vt(["ticket", "done", "T-005"], P);
    show(early);
    expect("done refuses while the code change is not merged (done never pushes untested code)", early.code === 2 && /not merged yet/.test(early.out), early.out);
    const m5 = vt(["ticket", "merge", "T-005"], P);
    const d5 = vt(["ticket", "done", "T-005"], P);
    expect("T-005 merged and done", m5.code === 0 && d5.code === 0, m5.out + "\n" + d5.out);

    step("A session dies while holding a lock; the next one takes it over");
    const holder = Bun.spawn([...self, "lock", "demo-stale", "--", ...self, "playground", "sleep", "8"], { cwd: P, stdout: "ignore", stderr: "ignore" });
    const lockDir = join(home, "locks", "demo-stale.lock", "owner.json");
    for (let i = 0; i < 100 && !existsSync(lockDir); i++) await sleep(100);
    holder.kill("SIGKILL");
    await holder.exited;
    show(vt(["lock", "demo-stale", "--show"], P));
    const take = vt(["lock", "demo-stale", "--wait", "10", "--", ...self, "--version"], P);
    expect("the abandoned lock is taken over", take.code === 0, take.out);

    step("Final board");
    const list = vt(["ticket", "list"], P);
    show(list);
    expect("all five tickets are ✅ DONE", (list.out.match(/✅ DONE/g) ?? []).length === 5, list.out);
  } catch (e) {
    expect(`unexpected error: ${(e as Error).message}`, false);
  } finally {
    const failed = results.filter(([, ok]) => !ok);
    console.log(`\n${failed.length ? "DEMO FAILED" : "DEMO PASSED"}: ${results.length - failed.length}/${results.length} checks`);
    if (keep || failed.length) console.log(`Sandbox kept: ${native(root)}`);
    else rmSync(root, { recursive: true, force: true });
    return !failed.length;
  }
}

async function demoTabs(dir: string, trust: boolean): Promise<void> {
  const P = join(dir, "project");
  if (!existsSync(P)) createPlayground(dir);
  // Claude Code opens only sessions of the window's own folder: the demo runs in a window that has the playground open.
  let win = windows().find((w) => w.folders.some((f) => pathKey(f) === pathKey(P)))?.pid ?? null;
  if (!win) {
    const code = Bun.which("code") ?? fail(`open ${native(P)} in VS Code, then run this command again`, 2);
    console.log(`Opening the playground in a new VS Code window: ${native(P)}`);
    Bun.spawn([code, "-n", P], { stdout: "ignore", stderr: "ignore" });
    win = await waitForWindow(P);
    if (!win) fail("the new window did not register (is the VixTab extension enabled there?)", 7);
    await sleep(3000);
  }
  const env = { VIXTAB_EXT_HOST_PID: String(win) };
  const labels = ["DEMO-1", "DEMO-2", "DEMO-3"];
  const opened: { label: string; pid: string }[] = [];
  for (const label of labels) {
    console.log(`\nOpening ${label} (a new column on the right; your focus stays where it is)…`);
    const r = vt(["session", "open", label, "--cwd", P, "--no-gate", ...(trust ? ["--trust"] : [])], P, env);
    console.log(indent(r.out));
    if (r.code !== 0) {
      if (/trust/.test(r.out) && !trust) console.log("\nRun again with --trust if you agree that Claude Code may trust the playground folder.");
      break;
    }
    opened.push({ label, pid: /pid=(\d+)/.exec(r.out)?.[1] ?? "" });
    console.log(indent(vt(["tab", "layout"], P, env).out));
    await sleep(2500);
  }
  for (const o of opened.reverse()) {
    await sleep(2000);
    console.log(`Closing ${o.label}…`);
    console.log(indent(vt(["session", "close", o.label, o.pid, "--cwd", P], P, env).out));
  }
}

async function demoHeavy(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "vixtab-heavy-"));
  gitOk(cwd, "init", "-q");
  console.log("Five heavy runs ask for 2 slots at once (each holds 300 MB for 6 s): watch them wait for a free slot.");
  const t0 = Date.now();
  const runs = await Promise.all(
    [1, 2, 3, 4, 5].map(async (i) => {
      const r = await vtAsync(["heavy", "--mem", "1G", "--slots", "2", "--", ...self, "playground", "hog", "300M", "6"], cwd);
      console.log(`  run ${i} finished after ${((Date.now() - t0) / 1000).toFixed(0)} s (exit ${r.code})`);
      return r;
    }),
  );
  console.log(`\nA run capped at 512 MB tries to use 1.5 GB (${platform.memoryCapKind()}):`);
  const over = await vtAsync(["heavy", "--mem", "512M", "--", ...self, "playground", "hog", "1536M", "3"], cwd);
  console.log(`  exit ${over.code} — ${over.code !== 0 ? "stopped by the cap, as intended" : "NOT stopped (no memory cap on this machine)"}`);
  rmSync(cwd, { recursive: true, force: true });
  if (runs.some((r) => r.code !== 0)) process.exitCode = 1;
}

export async function playground(argv: string[]): Promise<void> {
  const [action, ...rest] = argv;
  const a = parseArgs(rest, ["dir"]);
  switch (action) {
    case "create":
      createPlayground(a._[0] ?? defaultDir());
      return;
    case "reset":
    case "remove": {
      const dir = norm(resolve(a._[0] ?? defaultDir()));
      if (!existsSync(join(dir, "origin.git"))) fail(`${native(dir)} is not a VixTab playground`, 2);
      run([...self, "procs", "kill", dir]);
      rmSync(dir, { recursive: true, force: true });
      if (action === "reset") createPlayground(dir);
      else console.log(`Removed ${native(dir)}.`);
      return;
    }
    case "check": {
      const errors = check(norm(resolve(a._[0] ?? ".")));
      if (errors.length) {
        console.log(`playground check: ${errors.length} problem(s)\n${errors.map((e) => "  - " + e).join("\n")}`);
        process.exitCode = 1;
      } else console.log("playground check: OK");
      return;
    }
    case "demo": {
      const what = a._[0];
      if (what === "board") process.exitCode = (await demoBoard(str(a, "dir"), has(a, "keep"))) ? 0 : 1;
      else if (what === "tabs") await demoTabs(norm(resolve(str(a, "dir") ?? defaultDir())), has(a, "trust"));
      else if (what === "heavy") await demoHeavy();
      else fail("usage: vixtab playground demo board|tabs|heavy", 2);
      return;
    }
    case "sleep":
      await sleep(Number(a._[0] ?? 60) * 1000);
      return;
    case "hog": {
      const mb = parseSizeMB(a._[0], 256), chunks: Uint8Array[] = [];
      for (let i = 0; i < mb / 64; i++) chunks.push(new Uint8Array(64 * 1048576).fill(i % 255 || 1));
      await sleep(Number(a._[1] ?? 5) * 1000);
      console.log(`held ${chunks.length * 64} MB`);
      return;
    }
    default:
      console.log(HELP);
      if (action && action !== "help") process.exitCode = 2;
  }
}
