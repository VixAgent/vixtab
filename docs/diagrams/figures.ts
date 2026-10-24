// The README figures. Each function draws one figure for a theme; render.ts writes SVG (light + dark) and PNG.
import { type Hue, Sketch, type Theme } from "./sketch.ts";

type Col = { label: string; hue: Hue; status?: [string, Hue]; ghost?: boolean; orchestrator?: boolean; lines?: string[]; weight?: number; done?: boolean };

/** A small VS Code window with editor columns. */
function window_(s: Sketch, x: number, y: number, w: number, h: number, cols: Col[], o: { title?: string } = {}) {
  s.box(x, y, w, h, { hue: "ink", fill: "paper", r: 12, width: 2 });
  s.line(x, y + 26, x + w, y + 26, { hue: "ink", width: 1.4 });
  for (let i = 0; i < 3; i++) s.ellipse(x + 16 + i * 14, y + 13, 8, 8, { hue: (["red", "yellow", "green"] as Hue[])[i], fill: true, width: 1 });
  if (o.title) s.text(x + 70, y + 19, o.title, 14, { muted: true });
  const top = y + 36, bottom = y + h - 10, gap = 8;
  const weights = cols.map((c) => c.weight ?? (c.orchestrator ? 1.25 : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let cx = x + 10;
  const inner = w - 20 - gap * (cols.length - 1);
  cols.forEach((c, i) => {
    const cw = (inner * weights[i]) / total;
    s.box(cx, top, cw, bottom - top, { hue: c.hue, fill: c.ghost ? false : true, r: 8, dash: c.ghost, width: c.ghost ? 1.4 : 1.8 });
    s.text(cx + cw / 2, top + 22, c.label, cw < 90 ? 15 : 17, { hue: c.hue, anchor: "middle", maxWidth: cw - 10 });
    if (!c.ghost) {
      s.line(cx + 8, top + 32, cx + cw - 8, top + 32, { hue: c.hue, width: 1.1 });
      if (c.lines) c.lines.forEach((l, k) => s.text(cx + 12, top + 56 + k * 24, l, 15, { maxWidth: cw - 22 }));
      else s.scribble(cx + 10, top + 48, cw - 20, c.orchestrator ? 4 : 3);
      if (c.status) {
        const bw = s.badge(cx + 10, bottom - 14, c.status[0], c.status[1], 13);
        if (c.done) s.check(cx + 18 + bw, bottom - 12, 14);
      }
    } else if (c.lines) {
      c.lines.forEach((l, k) => s.text(cx + cw / 2, top + 70 + k * 22, l, 14, { anchor: "middle", muted: true, maxWidth: cw - 16 }));
    }
    cx += cw + gap;
  });
}

/** A ticket window: one group, Claude tabs stacked (a tab strip), one renderer of its own. */
function stackWindow(s: Sketch, x: number, y: number, w: number, h: number, tabs: [string, Hue][], active: number, title: string) {
  s.box(x, y, w, h, { hue: "ink", fill: "paper", r: 12, width: 2 });
  s.line(x, y + 24, x + w, y + 24, { hue: "ink", width: 1.3 });
  for (let i = 0; i < 3; i++) s.ellipse(x + 14 + i * 12, y + 12, 7, 7, { hue: (["red", "yellow", "green"] as Hue[])[i], fill: true, width: 1 });
  s.text(x + 54, y + 17, title, 12, { muted: true, maxWidth: w - 60 });
  const tw = Math.min(70, (w - 20) / tabs.length);
  tabs.forEach(([label, hue], i) => {
    const tx = x + 10 + i * tw;
    s.box(tx, y + 32, tw - 4, 24, { hue, fill: i === active, r: 6, width: i === active ? 1.8 : 1.2 });
    s.text(tx + (tw - 4) / 2, y + 49, label, 13, { hue, anchor: "middle", maxWidth: tw - 10 });
  });
  const [, hue] = tabs[active];
  s.box(x + 10, y + 60, w - 20, h - 70, { hue, fill: true, r: 8 });
  s.scribble(x + 20, y + 80, w - 40, 2);
}

export function layoutFlow(theme: Theme) {
  const s = new Sketch(1280, 450, theme);
  s.text(640, 44, "How VixTab lays out the tabs", 30, { anchor: "middle" });
  const O: Col = { label: "Orchestrator", hue: "purple", orchestrator: true };
  const y = 78;
  // 1. the orchestrator alone
  window_(s, 20, y, 220, 220, [{ ...O, status: ["planning", "purple"] }]);
  // 2. first tickets as columns
  window_(s, 282, y, 300, 220, [O, { label: "T-001", hue: "blue", status: ["DOING", "blue"] }, { label: "T-002", hue: "orange", status: ["DOING", "orange"] }, { label: "T-003", hue: "green", status: ["DOING", "green"] }]);
  // 3. more tickets: a ticket window with stacked tabs
  window_(s, 624, y, 300, 150, [O, { label: "T-001", hue: "blue" }, { label: "T-002", hue: "orange" }, { label: "T-003", hue: "green" }]);
  stackWindow(s, 700, y + 100, 240, 150, [["T-004", "yellow"], ["T-005", "red"], ["T-006", "blue"]], 0, "VixTab tickets 1");
  // 4. done: tabs close
  window_(s, 980, y, 280, 150, [O, { label: "T-002", hue: "orange" }, { label: "T-003", hue: "green", status: ["DONE", "green"], done: true }]);
  stackWindow(s, 1036, y + 100, 224, 150, [["T-004", "yellow"], ["T-006", "blue"]], 0, "VixTab tickets 1");
  s.arrow(246, y + 110, 276, y + 110, { width: 2.2 });
  s.arrow(588, y + 110, 618, y + 110, { width: 2.2 });
  s.arrow(946, y + 110, 976, y + 110, { width: 2.2 });
  const cap: [number, string, string][] = [
    [130, "1. One orchestrator tab", "type the goal"],
    [432, "2. First tickets: new columns", "focus stays, widths evened"],
    [780, "3. More tickets: a ticket window", "stacked tabs, its own renderer"],
    [1120, "4. Done: its tab closes", "the others keep working"],
  ];
  for (const [x, a2, b2] of cap) {
    s.text(x, y + 300, a2, 18, { anchor: "middle" });
    s.text(x, y + 324, b2, 16, { anchor: "middle", muted: true });
  }
  s.text(640, y + 364, "All Claude tabs of one VS Code window share one renderer thread — so after 3 columns, tickets go to ticket windows, 5 tabs each.", 16, { anchor: "middle", muted: true });
  return s.svg("How VixTab lays out the tabs: first tickets as columns next to the orchestrator, later ones stacked in ticket windows");
}

export function hero(theme: Theme) {
  const s = new Sketch(1280, 560, theme);
  s.text(640, 46, "One orchestrator. A fresh tab for every ticket.", 32, { anchor: "middle" });
  window_(s, 40, 76, 1200, 340, [
    { label: "Orchestrator", hue: "purple", orchestrator: true, weight: 1.5, lines: ["split the goal: 4 tickets", "open T-001 … T-003", "one-line task to each", "vixtab wait  (0 tokens)", "T-003 done: close its tab"], status: ["orchestrating", "purple"] },
    { label: "T-001", hue: "blue", status: ["DOING", "blue"] },
    { label: "T-002", hue: "orange", status: ["DOING", "orange"] },
    { label: "T-003", hue: "green", status: ["DONE", "green"], done: true },
    { label: "T-004 …", hue: "gray", ghost: true, lines: ["next tickets go to", "a ticket window:", "own renderer,", "5 tabs each"] },
  ], { title: "VS Code — your-repo" });
  const notes: [number, number, string, string][] = [
    [330, 475, "fresh session, own column,", "own git worktree and branch"],
    [690, 691, "merges queue up; tests run", "after the rebase, red never lands"],
    [1050, 909, "done: processes stopped,", "worktree removed, tab closed"],
  ];
  for (const [x, to, a, b] of notes) {
    s.arrow(x, 474, to, 424, { hue: "ink", width: 1.8, bend: 10 });
    s.text(x, 500, a, 18, { anchor: "middle" });
    s.text(x, 524, b, 18, { anchor: "middle", muted: true });
  }
  return s.svg("One orchestrator tab and one fresh tab per ticket, each in its own column of the VS Code window");
}

export function contextSaving(theme: Theme) {
  const s = new Sketch(1280, 520, theme);
  s.text(640, 46, "Why many short sessions cost less than one long one", 30, { anchor: "middle" });
  const base = 400;
  // left: one session does five tickets — context keeps growing
  s.text(330, 96, "One long session does 5 tickets", 21, { anchor: "middle" });
  [70, 125, 180, 235, 290].forEach((h, i) => {
    const x = 120 + i * 84;
    s.rect(x, base - h, 54, h, { hue: i === 4 ? "red" : "orange", fill: true, hachure: true });
    s.text(x + 27, base + 26, `#${i + 1}`, 17, { anchor: "middle" });
  });
  s.line(100, base, 560, base, { hue: "ink", width: 2 });
  s.text(330, base + 58, "every turn re-reads everything before it", 17, { anchor: "middle", muted: true });
  s.text(446, 132, "full: compaction,", 16, { hue: "red", anchor: "end" });
  s.text(446, 152, "lost details", 16, { hue: "red", anchor: "end" });
  // right: orchestrator + five fresh sessions
  s.text(950, 96, "VixTab: orchestrator + 5 fresh sessions", 21, { anchor: "middle" });
  s.rect(700, base - 46, 54, 46, { hue: "purple", fill: true, hachure: true });
  s.text(727, base + 26, "orch.", 17, { anchor: "middle", hue: "purple" });
  (["blue", "orange", "green", "yellow", "blue"] as Hue[]).forEach((hue, i) => {
    const x = 800 + i * 84;
    s.rect(x, base - 72, 54, 72, { hue, fill: true, hachure: true });
    s.check(x + 18, base - 92, 16);
    s.text(x + 27, base + 26, `T-00${i + 1}`, 15, { anchor: "middle" });
  });
  s.line(680, base, 1240, base, { hue: "ink", width: 2 });
  s.text(960, base + 58, "each session starts small and closes when its ticket is done;", 17, { anchor: "middle", muted: true });
  s.text(960, base + 80, "the orchestrator sleeps on \"vixtab wait\" and reads one-line results", 17, { anchor: "middle", muted: true });
  s.line(640, 90, 640, 470, { hue: "gray", width: 1.2, dash: true });
  s.text(60, 250, "context", 16, { muted: true });
  s.text(60, 270, "per turn", 16, { muted: true });
  return s.svg("One long session re-reads a growing context every turn; VixTab gives each ticket a fresh, short session");
}

export function lifecycle(theme: Theme) {
  const s = new Sketch(1280, 410, theme);
  s.text(640, 46, "The life of a ticket", 30, { anchor: "middle" });
  const y = 230, h = 64;
  const st: [number, string, Hue][] = [[40, "TODO", "gray"], [330, "DOING", "blue"], [650, "MERGE", "purple"], [1000, "DONE", "green"]];
  for (const [x, label, hue] of st) {
    s.box(x, y, 220, h, { hue, fill: true, r: 14, width: 2.2 });
    s.text(x + 110, y + 42, label, 26, { anchor: "middle", hue });
  }
  s.check(1170, y + 30, 22);
  s.arrow(266, y + 32, 324, y + 32, { width: 2.2 });
  s.arrow(556, y + 32, 644, y + 32, { width: 2.2 });
  s.arrow(876, y + 32, 994, y + 32, { width: 2.2 });
  s.text(150, y + 104, "claim:", 17, { anchor: "middle" });
  s.text(150, y + 126, "lock · worktree · branch", 16, { anchor: "middle", muted: true });
  s.text(440, y + 104, "work in the worktree,", 17, { anchor: "middle" });
  s.text(440, y + 126, "commit only your files", 16, { anchor: "middle", muted: true });
  s.text(760, y + 104, "fetch · rebase · status", 17, { anchor: "middle" });
  s.text(760, y + 126, "· tests · push", 16, { anchor: "middle", muted: true });
  s.text(1110, y + 104, "answer · stop processes", 17, { anchor: "middle" });
  s.text(1110, y + 126, "· remove the worktree", 16, { anchor: "middle", muted: true });
  // ask / answer
  s.box(330, 92, 220, 56, { hue: "yellow", fill: true, r: 14, width: 2 });
  s.text(440, 128, "ASK", 24, { anchor: "middle", hue: "yellow" });
  s.arrow(400, y - 4, 400, 154, { hue: "yellow", width: 2 });
  s.arrow(480, 154, 480, y - 4, { hue: "yellow", width: 2 });
  s.text(390, 196, "ask", 16, { anchor: "end", muted: true });
  s.text(492, 196, "answer", 16, { muted: true });
  // red tests loop back
  s.arrow(700, y - 6, 520, y - 6, { hue: "red", width: 2, bend: 46 });
  s.text(596, 182, "tests red: nothing pushed", 16, { hue: "red" });
  // release
  s.arrow(360, y + h + 6, 230, y + h + 6, { hue: "gray", width: 1.8, bend: -30, dash: true });
  s.text(296, y + h + 58, "release", 16, { anchor: "middle", muted: true });
  return s.svg("Ticket lifecycle: TODO, claim, DOING, ask and answer, merge queue with tests, DONE");
}

export function mergeQueue(theme: Theme) {
  const s = new Sketch(1280, 470, theme);
  s.text(640, 46, "Parallel work, one merge at a time", 30, { anchor: "middle" });
  const hues: Hue[] = ["blue", "orange", "green", "red"];
  ["T-001", "T-002", "T-003", "T-004"].forEach((id, i) => {
    const y = 96 + i * 76;
    s.box(40, y, 170, 52, { hue: hues[i], fill: true, r: 10 });
    s.text(125, y + 34, id, 20, { anchor: "middle", hue: hues[i] });
    s.arrow(216, y + 26, 388, 236, { width: 1.8, bend: (i - 1.5) * -18 });
  });
  s.box(396, 120, 260, 236, { hue: "purple", fill: true, r: 16, width: 2.4 });
  s.text(526, 156, "merge-main lock", 21, { anchor: "middle", hue: "purple" });
  ["1  fetch main", "2  rebase the ticket branch", "3  write its status cell", "4  run the tests", "5  push"].forEach((t, i) => s.text(420, 196 + i * 32, t, 17));
  s.arrow(662, 238, 742, 238, { width: 2.2 });
  s.line(760, 238, 1230, 238, { width: 2.6 });
  s.text(1234, 228, "main", 18, { anchor: "end" });
  [["T-002", "orange"], ["T-001", "blue"], ["T-003", "green"]].forEach(([id, hue], i) => {
    const x = 800 + i * 120;
    s.ellipse(x, 238, 30, 30, { hue: hue as Hue, fill: true, width: 2 });
    s.text(x, 284, id, 17, { anchor: "middle", hue: hue as Hue });
  });
  s.ellipse(1160, 160, 30, 30, { hue: "red", fill: true, dash: true, width: 1.8 });
  s.cross(1160, 160, 12);
  s.text(1160, 118, "T-004: tests red,", 16, { anchor: "middle", hue: "red" });
  s.text(1160, 138, "not pushed", 16, { anchor: "middle", hue: "red" });
  s.text(640, 410, "Status cells are written after the rebase, so tickets claimed or finished together never conflict.", 18, { anchor: "middle", muted: true });
  s.text(640, 436, "Two tickets changed the same file? \"vixtab wait\" tells the later one to rebase and re-test.", 18, { anchor: "middle", muted: true });
  return s.svg("Four tickets merge through one lock: fetch, rebase, status, tests, push; red tests never land");
}

export function gates(theme: Theme) {
  const s = new Sketch(1280, 500, theme);
  s.text(640, 46, "Room on the machine decides, not a fixed cap", 30, { anchor: "middle" });
  // left: session gate
  s.text(310, 98, "Open another tab?", 22, { anchor: "middle" });
  s.box(40, 116, 540, 214, { hue: "ink", fill: "paper", r: 14 });
  ["free RAM, minus RAM reserved for tabs", "swap use under the limit", "commit charge under 85% (Windows)", "CPU busy under 85%"].forEach((t, i) => {
    const y = 152 + i * 46 + (i ? 14 : 0);
    s.check(64, y - 4, 16);
    s.text(96, y, t, 18);
  });
  s.text(96, 174, "opened in the last 90 s, over the limit", 15, { muted: true });
  s.arrow(200, 336, 160, 392, { hue: "green", width: 2 });
  s.arrow(420, 336, 460, 392, { hue: "orange", width: 2 });
  s.text(150, 420, "yes: session open", 18, { anchor: "middle", hue: "green" });
  s.text(470, 420, "no: exit 6, the ticket waits", 18, { anchor: "middle", hue: "orange" });
  s.text(310, 454, "re-checked after the next ticket is done", 16, { anchor: "middle", muted: true });
  s.line(640, 90, 640, 470, { hue: "gray", width: 1.2, dash: true });
  // right: heavy slots
  s.text(960, 98, "Heavy steps: elastic slots", 22, { anchor: "middle" });
  const slots: [string, Hue | null][] = [["tests 6G", "blue"], ["e2e 6G", "orange"], ["build 4G", "green"], ["", null], ["", null]];
  slots.forEach(([t, hue], i) => {
    const x = 700 + i * 108;
    s.box(x, 130, 92, 92, { hue: hue ?? "gray", fill: hue ? true : false, dash: !hue, r: 10 });
    s.text(x + 46, 168, t || "free", 16, { anchor: "middle", hue: hue ?? undefined, muted: !hue });
    if (hue) s.text(x + 46, 196, "capped", 14, { anchor: "middle", muted: true });
  });
  s.text(960, 262, "slots = logical CPUs / 4; a run takes one inside a lock", 17, { anchor: "middle" });
  s.text(960, 286, "only if RAM, CPU and commit have room for its cap", 17, { anchor: "middle" });
  s.box(760, 316, 400, 70, { hue: "purple", fill: true, r: 12 });
  s.text(960, 346, "each run is memory-capped", 18, { anchor: "middle", hue: "purple" });
  s.text(960, 370, "Linux: cgroup scope · Windows: Job Object", 16, { anchor: "middle", hue: "purple" });
  s.text(960, 430, "vixtab watch ram: alerts the orchestrator", 17, { anchor: "middle", muted: true });
  s.text(960, 452, "before the machine starts swapping", 17, { anchor: "middle", muted: true });
  return s.svg("Resource gates: a tab opens only when RAM, swap, commit and CPU have room; heavy steps use elastic, capped slots");
}

export function architecture(theme: Theme) {
  const s = new Sketch(1280, 600, theme);
  s.text(640, 46, "What runs where", 30, { anchor: "middle" });
  // top: Claude Code tabs
  s.box(40, 80, 760, 110, { hue: "ink", fill: "paper", r: 14 });
  s.text(60, 108, "Claude Code tabs in VS Code", 18, { muted: true });
  s.box(60, 120, 200, 56, { hue: "purple", fill: true, r: 10 });
  s.text(160, 146, "Orchestrator", 18, { anchor: "middle", hue: "purple" });
  s.text(160, 168, "skill: vixtab-orchestrate", 13, { anchor: "middle", muted: true });
  ["T-001", "T-002", "T-003"].forEach((id, i) => {
    const x = 290 + i * 168, hue = (["blue", "orange", "green"] as Hue[])[i];
    s.box(x, 120, 150, 56, { hue, fill: true, r: 10 });
    s.text(x + 75, 146, id, 18, { anchor: "middle", hue });
    s.text(x + 75, 168, "skill: vixtab-ticket", 13, { anchor: "middle", muted: true });
  });
  s.arrow(420, 196, 420, 244, { width: 2 });
  s.text(430, 226, "~/.vixtab/bin/vixtab …", 16, { muted: true });
  // CLI with shared core
  s.box(40, 250, 760, 190, { hue: "blue", fill: true, r: 16, width: 2.4 });
  s.text(420, 280, "vixtab CLI — one program, shared core", 21, { anchor: "middle", hue: "blue" });
  ["board", "locks", "merge queue", "gates", "waiter", "sessions", "bridge"].forEach((m, i) => {
    const x = 62 + (i % 4) * 182, y = 300 + Math.floor(i / 4) * 64;
    s.box(x, y, 164, 46, { hue: "ink", fill: "paper", r: 8, width: 1.4 });
    s.text(x + 82, y + 30, m, 17, { anchor: "middle" });
  });
  // platform adapters
  s.box(40, 470, 370, 96, { hue: "orange", fill: true, r: 14 });
  s.text(225, 502, "linux.ts", 20, { anchor: "middle", hue: "orange" });
  s.text(225, 528, "/proc · systemd scope · nice", 16, { anchor: "middle", muted: true });
  s.text(225, 550, "~/.vscode(-server)/extensions", 15, { anchor: "middle", muted: true });
  s.box(430, 470, 370, 96, { hue: "green", fill: true, r: 14 });
  s.text(615, 502, "windows.ts", 20, { anchor: "middle", hue: "green" });
  s.text(615, 528, "CIM + PEB (FFI) · Job Object", 16, { anchor: "middle", muted: true });
  s.text(615, 550, "Git Bash for test commands", 15, { anchor: "middle", muted: true });
  s.arrow(225, 444, 225, 466, { width: 1.8 });
  s.arrow(615, 444, 615, 466, { width: 1.8 });
  // right side: git + extensions
  s.box(880, 80, 360, 110, { hue: "gray", fill: true, r: 14 });
  s.text(1060, 118, "git remote: main", 20, { anchor: "middle" });
  s.text(1060, 146, "board (tickets/README.md)", 16, { anchor: "middle", muted: true });
  s.text(1060, 168, "+ the code, merged in order", 16, { anchor: "middle", muted: true });
  s.arrow(804, 300, 876, 170, { width: 1.8, bend: -20 });
  s.box(880, 250, 360, 100, { hue: "purple", fill: true, r: 14 });
  s.text(1060, 284, "VixTab extension", 20, { anchor: "middle", hue: "purple" });
  s.text(1060, 310, "commands in ~/.cache/vixtab", 16, { anchor: "middle", muted: true });
  s.text(1060, 332, "open · close · layout · even", 16, { anchor: "middle", muted: true });
  s.arrow(804, 380, 876, 320, { width: 1.8, bend: 14 });
  s.arrow(876, 300, 806, 360, { width: 1.4, dash: true, bend: 14 });
  s.box(880, 400, 360, 100, { hue: "orange", fill: true, r: 14 });
  s.text(1060, 434, "Claude Code extension", 20, { anchor: "middle", hue: "orange" });
  s.text(1060, 460, "claude-vscode.editor.open", 16, { anchor: "middle", muted: true });
  s.text(1060, 482, "~/.claude/sessions · transcripts", 16, { anchor: "middle", muted: true });
  s.arrow(1060, 354, 1060, 396, { width: 1.8 });
  s.text(1060, 540, "a new tab = CLI in a pseudo-terminal,", 16, { anchor: "middle", muted: true });
  s.text(1060, 562, "/rename <label>, /exit: no model turn", 16, { anchor: "middle", muted: true });
  return s.svg("Architecture: Claude Code tabs call the vixtab CLI; shared core plus Linux and Windows adapters; VS Code extension bridge");
}

export function install(theme: Theme) {
  const s = new Sketch(1280, 330, theme);
  s.text(640, 46, "From install to orchestrating in three clicks", 30, { anchor: "middle" });
  const steps: [string, string, string, Hue][] = [
    ["1. Install VixTab", "VS Code Marketplace or .vsix", "(Claude Code comes along)", "blue"],
    ["2. Click \"Set up\"", "vixtab CLI in ~/.vixtab/bin", "nothing in your projects yet", "orange"],
    ["3. Click \"VixTab\"", "this repo gets the skills;", "an Orchestrator tab opens", "purple"],
  ];
  steps.forEach(([a, b, c, hue], i) => {
    const x = 40 + i * 420;
    s.box(x, 86, 360, 200, { hue, fill: true, r: 18, width: 2.2 });
    s.text(x + 180, 136, a, 24, { anchor: "middle", hue });
    s.text(x + 180, 196, b, 18, { anchor: "middle" });
    s.text(x + 180, 224, c, 18, { anchor: "middle", muted: true });
    if (i < 2) s.arrow(x + 366, 186, x + 414, 186, { width: 2.4 });
  });
  return s.svg("Install VixTab, click Set up, click VixTab in the status bar and type the goal");
}

export function icon(theme: Theme) {
  const s = new Sketch(256, 256, theme);
  s.box(20, 30, 216, 196, { hue: "ink", fill: "paper", r: 26, width: 6 });
  s.box(36, 66, 68, 144, { hue: "purple", fill: true, r: 10, width: 5 });
  s.box(112, 66, 52, 144, { hue: "blue", fill: true, r: 10, width: 5 });
  s.box(172, 66, 48, 144, { hue: "green", fill: true, r: 10, width: 5 });
  s.line(20, 54, 236, 54, { width: 5 });
  s.check(180, 150, 30, { width: 7 });
  return s.svg("VixTab");
}

/** Sessions wait for each other only when they must: After dependencies, questions, shared files, the resource gate. */
export function dependencies(theme: Theme) {
  const s = new Sketch(1280, 640, theme);
  s.text(640, 44, "Sessions wait for each other — only when they must", 30, { anchor: "middle" });
  const x0 = 150, lane = (i: number) => 160 + i * 72;
  const bar = (i: number, a: number, b: number, hue: Hue, label?: string) => {
    s.box(a, lane(i) - 16, b - a, 32, { hue, fill: true, r: 9, width: 1.8 });
    if (label) s.text(a + 12, lane(i) + 6, label, 15, { hue, maxWidth: b - a - 20 });
  };
  const waiting = (i: number, a: number, b: number, label: string, hue: Hue = "gray") => {
    s.box(a, lane(i) - 16, b - a, 32, { hue, dash: true, r: 9, width: 1.4 });
    s.text(a + 12, lane(i) + 6, label, 14, { muted: true, maxWidth: b - a - 20 });
  };
  // orchestrator lane: asleep on `vixtab wait`, woken by events (labels alternate above / below the line)
  const oy = 96;
  s.text(40, oy + 6, "orchestrator", 16, { hue: "purple" });
  s.line(x0, oy, 1230, oy, { hue: "purple", width: 1.4, dash: true });
  for (const x of [250, 1110]) s.text(x, oy - 10, "zZ", 16, { hue: "purple", muted: true });
  const wake = (x: number, label: string, i: number, below = false) => {
    s.line(x, lane(i) - 18, x, oy + 8, { hue: "purple", width: 1.1, dash: true });
    s.ellipse(x, oy, 16, 16, { hue: "purple", fill: true, width: 1.6 });
    s.text(x, below ? oy + 26 : oy - 12, label, 14, { hue: "purple", anchor: "middle" });
  };
  // lanes: the pairs that interact sit next to each other
  const lanes = ["T-001", "T-004", "T-003", "T-005", "T-002", "T-006"];
  lanes.forEach((id, i) => s.text(40, lane(i) + 6, id, 18));
  // wake-ups of the orchestrator (drawn first: the bars cover their guide lines)
  wake(340, "ask T-002", 4);
  wake(490, "rebase T-004", 1, true);
  wake(630, "done T-003, ready T-005", 2);
  wake(784, "done T-002: open T-006", 4, true);
  // T-001 merges first; T-004 changes the same file ⇒ told to rebase
  bar(0, x0, 470, "blue", "working, then merge");
  s.check(480, lane(0) + 2, 16);
  bar(1, x0, 900, "red", "working in parallel on the same file as T-001");
  s.arrow(470, lane(0) + 18, 500, lane(1) - 18, { hue: "red", width: 1.6, bend: -10 });
  s.text(510, lane(1) - 22, "rebase: T-001 changed INDEX.md", 14, { hue: "red" });
  s.check(910, lane(1) + 2, 16);
  // T-003 done ⇒ T-005 (After: T-003) becomes ready
  bar(2, x0, 610, "green", "working");
  s.check(620, lane(2) + 2, 16);
  waiting(3, x0, 630, "waits: After T-003 (a claim is refused until then)");
  bar(3, 640, 1010, "purple", "starts the moment T-003 is done");
  s.arrow(612, lane(2) + 18, 646, lane(3) - 18, { hue: "green", width: 1.8, bend: 14 });
  s.check(1020, lane(3) + 2, 16);
  // T-002 asks a question, waits for the answer, continues
  bar(4, x0, 330, "orange", "working");
  waiting(4, 340, 540, "ASK: waits for the answer", "yellow");
  bar(4, 550, 760, "orange", "continues");
  s.check(770, lane(4) + 2, 16);
  // T-006 queued by the resource gate until a session closes
  waiting(5, x0, 780, "queued: resource gate closed (free RAM, CPU)");
  bar(5, 790, 1180, "yellow", "a session closed: room again");
  // time axis + legend
  s.arrow(x0, 590, 1230, 590, { width: 1.6 });
  s.text(1230, 578, "time", 15, { anchor: "end", muted: true });
  s.box(160, 604, 34, 20, { hue: "blue", fill: true, r: 6, width: 1.4 });
  s.text(204, 620, "a session works", 15, { muted: true });
  s.box(360, 604, 34, 20, { hue: "gray", dash: true, r: 6, width: 1.2 });
  s.text(404, 620, "waits, spending no tokens", 15, { muted: true });
  s.ellipse(628, 614, 14, 14, { hue: "purple", fill: true, width: 1.4 });
  s.text(644, 620, "vixtab wait wakes the orchestrator: done, ready, ask, rebase, gone", 15, { muted: true });
  return s.svg("Tickets wait only when they must: After dependencies, questions, a shared file to rebase on, and the resource gate");
}

export const FIGURES: Record<string, (t: Theme) => string> = {
  hero,
  dependencies,
  "layout-flow": layoutFlow,
  "context-saving": contextSaving,
  lifecycle,
  "merge-queue": mergeQueue,
  gates,
  architecture,
  install,
  icon,
};
