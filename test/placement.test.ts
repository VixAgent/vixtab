// Where session open puts a new tab: each window's Claude tabs, counted when the tab opens, against its cap.
import { describe, expect, test } from "bun:test";
import { type Layout, type WindowInfo, MAX_TABS_DEFAULT, tabsIn } from "../src/core/bridge.ts";
import type { Config } from "../src/core/config.ts";
import { type WindowIO, capOf, chooseWindow } from "../src/commands/session.ts";
import { VixError } from "../src/core/util.ts";

const REPO = "/work/my-app";
const config = (tabs: Partial<Config["tabs"]> = {}) => ({ tabs: { mode: "auto", inWindowMax: null, columnsMax: 3, perWindowMax: null, ...tabs } }) as Config;
/** A layout with `n` Claude tabs spread over `columns` columns. */
const lay = (n: number, columns = 1): Layout =>
  Array.from({ length: columns }, (_, i) => ({ column: i + 1, active: i === 0, tabs: Array.from({ length: n }, (_, j) => j).filter((j) => j % columns === i).map((j) => ({ label: `t${j}`, claude: true, active: false })) }));
const win = (pid: number, kind: "main" | "tickets", folder = REPO): WindowInfo => ({ pid, folders: [folder], version: "0.8.1", at: "", kind });

/** Fake windows: pid → [Claude tabs, setting, columns]; openTicketWindow adds window 900 (or fails). */
function io(base: number, ws: Record<number, [number, number, number?]>, o: { kinds?: Record<number, "main" | "tickets">; pinned?: boolean; canOpen?: boolean } = {}) {
  const opened: number[] = [];
  const fake: WindowIO = {
    base: () => ({ win: base, pinned: !!o.pinned }),
    windows: () => Object.keys(ws).map(Number).map((p) => win(p, o.kinds?.[p] ?? (p === base ? "main" : "tickets"))),
    tabs: async (p) => (ws[p] ? tabsIn({ layout: lay(ws[p][0], ws[p][2] ?? 1), maxTabs: ws[p][1] }) : { n: -1, max: MAX_TABS_DEFAULT, layout: null }),
    openTicketWindow: async () => {
      if (o.canOpen === false) throw new Error("code -n failed");
      ws[900] = [0, MAX_TABS_DEFAULT];
      opened.push(900);
      return 900;
    },
  };
  return { fake, opened };
}
const exitCode = async (p: Promise<unknown>) => {
  try {
    await p;
    return 0;
  } catch (e) {
    return e instanceof VixError ? e.code : -1;
  }
};

describe("layout answers", () => {
  test("the window's setting comes with its layout; extensions up to 0.8.0 send none: 6", () => {
    expect(tabsIn({ layout: lay(4), maxTabs: 8 })).toMatchObject({ n: 4, max: 8 });
    expect(tabsIn({ layout: lay(4) }).max).toBe(6);
    expect(tabsIn({ layout: lay(4), maxTabs: 0 }).max).toBe(6);
    expect(tabsIn({ layout: [{ column: 1, active: true, tabs: [{ label: "a.ts", claude: false, active: true }, { label: "T-1", claude: true, active: false }] }] }).n).toBe(1);
  });
  test("vixtab.config.json \"tabs\" overrides the setting for its project", () => {
    expect(capOf(config(), "main", 6)).toBe(6);
    expect(capOf(config({ inWindowMax: 4 }), "main", 6)).toBe(4);
    expect(capOf(config({ inWindowMax: 4 }), "tickets", 7)).toBe(7);
    expect(capOf(config({ perWindowMax: 3 }), "tickets", 7)).toBe(3);
  });
});

describe("auto", () => {
  test("the orchestrator's window while it holds fewer Claude tabs than its setting: columns up to 3, then stacked", async () => {
    expect(await chooseWindow(config(), REPO, false, io(100, { 100: [2, 6, 2] }).fake)).toEqual({ win: 100, stack: false, max: 6 });
    expect(await chooseWindow(config(), REPO, false, io(100, { 100: [5, 6, 3] }).fake)).toEqual({ win: 100, stack: true, max: 6 });
  });
  test("6 of 6 ⇒ the ticket window with the fewest Claude tabs below its own cap", async () => {
    const { fake, opened } = io(100, { 100: [6, 6, 3], 200: [6, 6], 300: [4, 6], 400: [3, 6] });
    expect(await chooseWindow(config(), REPO, false, fake)).toEqual({ win: 400, stack: true, max: 6 });
    expect(opened).toEqual([]);
  });
  test("each window keeps its own setting", async () => {
    expect((await chooseWindow(config(), REPO, false, io(100, { 100: [4, 4, 3], 200: [7, 8] }).fake)).win).toBe(200);
    expect((await chooseWindow(config(), REPO, false, io(100, { 100: [4, 8, 3], 200: [1, 8] }).fake)).win).toBe(100);
  });
  test("ticket windows of another folder are not used", async () => {
    const { fake, opened } = io(100, { 100: [6, 6, 3], 200: [0, 6] });
    const other = { ...fake, windows: () => [win(100, "main"), win(200, "tickets", "/work/other")] };
    expect((await chooseWindow(config(), REPO, false, other)).win).toBe(900);
    expect(opened).toEqual([900]);
  });
  test("every window full ⇒ a new ticket window", async () => {
    const { fake, opened } = io(100, { 100: [6, 6, 3], 200: [6, 6] });
    expect(await chooseWindow(config(), REPO, false, fake)).toEqual({ win: 900, stack: true, max: 6 });
    expect(opened).toEqual([900]);
  });
  test("a lower cap in vixtab.config.json fills windows sooner", async () => {
    expect((await chooseWindow(config({ inWindowMax: 3 }), REPO, false, io(100, { 100: [3, 6, 3], 200: [1, 6] }).fake)).win).toBe(200);
    expect((await chooseWindow(config({ perWindowMax: 2 }), REPO, false, io(100, { 100: [6, 6, 3], 200: [2, 6] }).fake)).win).toBe(900);
  });
  test("no ticket window can open: the caller's window only while below its cap, else exit 6", async () => {
    expect(await exitCode(chooseWindow(config(), REPO, false, io(100, { 100: [6, 6, 3] }, { canOpen: false }).fake))).toBe(6);
    const t = await chooseWindow(config({ mode: "windows" }), REPO, false, io(100, { 100: [1, 6] }, { canOpen: false }).fake);
    expect(t).toMatchObject({ win: 100, stack: false, max: 6 });
    expect(t.note).toContain("could not open a ticket window");
  });
});

describe("other modes", () => {
  test("windows: never the orchestrator's window, even with room", async () => {
    expect((await chooseWindow(config({ mode: "windows" }), REPO, false, io(100, { 100: [1, 6], 200: [5, 6] }).fake)).win).toBe(200);
  });
  test("columns and VIXTAB_EXT_HOST_PID: that window while below its cap, else exit 6", async () => {
    expect(await chooseWindow(config({ mode: "columns" }), REPO, false, io(100, { 100: [5, 6] }).fake)).toEqual({ win: 100, stack: false, max: 6 });
    expect(await exitCode(chooseWindow(config({ mode: "columns" }), REPO, false, io(100, { 100: [6, 6] }).fake))).toBe(6);
    expect(await exitCode(chooseWindow(config(), REPO, false, io(200, { 200: [6, 6] }, { pinned: true }).fake))).toBe(6);
  });
  test("--here: the caller's column, no cap (the Start orchestrator button)", async () => {
    expect(await chooseWindow(config(), REPO, true, io(100, { 100: [9, 6] }).fake)).toEqual({ win: 100, stack: false, max: 0 });
  });
});
