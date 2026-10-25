import { describe, expect, test } from "bun:test";
import {
  ANSWER_PLACEHOLDER, addQuestion, addRow, boardReadme, countQuestions, isModelName, parseRows, questionsOf, renderTicket, sessionModel, setRowStatus,
  setTicketStatus, STATUS, ticketModel,
} from "../src/core/board.ts";
import { unblocked } from "../src/commands/wait.ts";

const c = { prefix: "T-", digits: 3, branch: "main" } as any;

describe("board table", () => {
  const empty = boardReadme(c);
  const one = addRow(empty, { id: "T-001", file: "T-001-a.md", title: "First | with pipe", after: [] });
  const two = addRow(one, { id: "T-002", file: "T-002-b.md", title: "Second", after: ["T-001"] });

  test("rows are added inside the board markers and parsed back", () => {
    const rows = parseRows(c, two);
    expect(rows.map((r) => r.id)).toEqual(["T-001", "T-002"]);
    expect(rows[0].title).toBe("First | with pipe");
    expect(rows[1].after).toEqual(["T-001"]);
    expect(rows[1].status).toBe(STATUS.todo);
    expect(two.indexOf("T-002")).toBeLessThan(two.indexOf("<!-- /vixtab:board -->"));
  });

  test("setRowStatus changes only the last cell of the right row", () => {
    const next = setRowStatus(c, two, "T-002", STATUS.doing("s1"))!;
    const rows = parseRows(c, next);
    expect(rows[0].status).toBe(STATUS.todo);
    expect(rows[1].status).toBe("⏳ DOING (s1)");
    expect(rows[0].title).toBe("First | with pipe");
    expect(setRowStatus(c, two, "T-009", "x")).toBeNull();
  });

  test("a board without markers gets a table appended", () => {
    const r = addRow("# My board\n", { id: "T-001", file: "T-001-a.md", title: "A", after: [] });
    expect(parseRows(c, r).length).toBe(1);
  });
});

describe("ticket file", () => {
  const t = renderTicket("T-005", "Soup", { area: "recipes/soup.md", after: ["T-003"] });

  test("has status, after, area, questions and answer sections", () => {
    expect(t).toMatch(/^# T-005: Soup/);
    expect(t).toContain("- **After:** T-003");
    expect(t).toContain("- **Area:** recipes/soup.md");
    expect(t).toContain(ANSWER_PLACEHOLDER);
    expect(questionsOf(t)).toBe("_(none)_");
  });

  test("the Model line is written only when a model is given and read back", () => {
    expect(t).not.toContain("**Model:**");
    expect(ticketModel(t)).toBeUndefined();
    const m = renderTicket("T-006", "Icon", { area: "assets/icon.svg", model: "sonnet" });
    expect(m).toContain("- **Area:** assets/icon.svg\n- **Model:** sonnet\n\n## Request");
    expect(ticketModel(m)).toBe("sonnet");
    expect(ticketModel(setTicketStatus(m, "⏳ DOING (s)"))).toBe("sonnet");
    expect(ticketModel(m.replace("**Model:** sonnet", "**Model:** —"))).toBeUndefined();
    expect(ticketModel(m.replace("**Model:** sonnet", "**Model:** default"))).toBeUndefined();
    expect(ticketModel(m.replace("**Model:** sonnet", "**Model:** claude-haiku-5-5  ").replaceAll("\n", "\r\n"))).toBe("claude-haiku-5-5");
  });

  test("session open: --model over the ticket's Model line over the default", () => {
    const withModel = renderTicket("T-006", "Icon", { model: "sonnet" });
    expect(sessionModel("haiku", withModel)).toBe("haiku");
    expect(sessionModel("default", withModel)).toBeUndefined();
    expect(sessionModel(undefined, withModel)).toBe("sonnet");
    expect(sessionModel(undefined, t)).toBeUndefined();
    expect(sessionModel("claude-sonnet-5-5", null)).toBe("claude-sonnet-5-5");
    expect(sessionModel(undefined, null)).toBeUndefined();
  });

  test("model names: aliases and ids pass, anything that could be typed as a command does not", () => {
    for (const m of ["sonnet", "opus[1m]", "claude-sonnet-5-5", "us.anthropic.claude-sonnet-5-5-v1:0"]) expect(isModelName(m)).toBe(true);
    for (const m of ["", "/model", "sonnet; rm", "a b", "—", "x".repeat(101)]) expect(isModelName(m)).toBe(false);
  });

  test("status line is replaced", () => {
    expect(setTicketStatus(t, "✅ DONE (x)")).toContain("- **Status:** ✅ DONE (x)");
  });

  test("questions go above ## Answer and are counted", () => {
    let r = addQuestion(t, "- **Q (2026-01-01, s):** Stock or water?");
    expect(r.count).toBe(1);
    r = addQuestion(r.text, "  - **A (2026-01-01):** Stock.");
    r = addQuestion(r.text, "- **Q (2026-01-02, s):** Salt?");
    expect(r.count).toBe(2);
    expect(countQuestions(r.text)).toBe(2);
    const q = r.text.indexOf("## Questions"), a = r.text.indexOf("## Answer");
    expect(q).toBeLessThan(r.text.indexOf("Stock or water?"));
    expect(r.text.indexOf("Salt?")).toBeLessThan(a);
    expect(r.text).not.toContain("_(none)_");
  });
});

describe("wait: ready never comes before the done that unblocks it", () => {
  let readme = boardReadme(c);
  for (const [id, after] of [["T-003", []], ["T-004", []], ["T-005", ["T-003"]], ["T-006", ["T-003", "T-004"]]] as const)
    readme = addRow(readme, { id, file: `${id}-x.md`, title: id, after: [...after] });
  for (const id of ["T-003", "T-004"]) readme = setRowStatus(c, readme, id, STATUS.done("s"))!;
  const rows = parseRows(c, readme), mine = new Set(["T-003"]);

  test("only the done markers seen before the board was read count for the watched tickets", () => {
    // `ticket done T-003` wrote ✅ DONE, then its marker while the waiter was reading the board: that pass reports nothing…
    expect(unblocked(rows, mine, new Set(), () => true)).toEqual([]);
    // …the next one sees the marker and reports "done T-003" together with these.
    expect(unblocked(rows, mine, new Set(["T-003"]), () => true)).toEqual(["T-005", "T-006"]);
  });
  test("an After ticket we do not watch holds its dependents back while its done is still running here", () => {
    expect(unblocked(rows, mine, new Set(["T-003"]), (x) => x !== "T-004")).toEqual(["T-005"]);
    expect(unblocked(rows, new Set(["T-004"]), new Set(["T-004"]), () => true)).toEqual(["T-006"]);
  });
});
