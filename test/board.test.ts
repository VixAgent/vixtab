import { describe, expect, test } from "bun:test";
import { ANSWER_PLACEHOLDER, addQuestion, addRow, boardReadme, countQuestions, parseRows, questionsOf, renderTicket, setRowStatus, setTicketStatus, STATUS } from "../src/core/board.ts";

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
