// The board's text: README.md holds the ticket table, <id>-<slug>.md holds each ticket (where they live: boardstore.ts).
import BOARD_TEMPLATE from "../../templates/board-readme.md" with { type: "text" };
import TICKET_TEMPLATE from "../../templates/ticket.md" with { type: "text" };
import { type Args, has, str } from "./args.ts";
import { type Config, idPattern } from "./config.ts";
import { fail, today } from "./util.ts";

export const STATUS = {
  todo: "☐ TODO",
  doing: (who: string) => `⏳ DOING (${who})`,
  ask: (who: string) => `❓ ASK (${who})`,
  done: (who: string) => `✅ DONE (${who})`,
};
export const ANSWER_PLACEHOLDER = "_(the session that works on this ticket fills this in: commits, tests run, notes)_";
export const NO_QUESTIONS = "_(none)_";
const START = "<!-- vixtab:board -->", END = "<!-- /vixtab:board -->";

export const boardReadme = (c: Config) => BOARD_TEMPLATE.replaceAll("{{branch}}", c.branch);
/** README.md with the current protocol text above its table (a migrated board keeps its rows); unchanged without a table. */
export function withCurrentProtocol(c: Config, readme: string): string {
  const at = readme.indexOf(START), tpl = boardReadme(c);
  return at < 0 ? readme : tpl.slice(0, tpl.indexOf(START)) + readme.slice(at);
}
export const ticketBodyTemplate = () => TICKET_TEMPLATE;

export type Row = { id: string; file: string; title: string; after: string[]; status: string; line: number };

// ── Dependencies: a ticket's After list must be ✅ DONE before it can start ──────────────────────────────────────────────
export const isDoneStatus = (s: string) => s.startsWith("✅");
/** The After tickets of `row` that are not done yet (a ticket missing from the board blocks too). */
export function blockersOf(rows: Row[], row: Row): { id: string; status: string }[] {
  return row.after.map((id) => ({ id, status: rows.find((r) => r.id === id)?.status ?? "not on the board" })).filter((b) => !isDoneStatus(b.status));
}
/** TODO tickets whose After tickets are all done: they can start now. */
export const readyRows = (rows: Row[]) => rows.filter((r) => r.status.startsWith("☐") && !blockersOf(rows, r).length);

/** Table cells of a markdown row, honouring escaped pipes. */
const cells = (line: string) =>
  line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split(/(?<!\\)\|/).map((s) => s.trim());

export function parseRows(c: Config, readme: string): Row[] {
  const re = new RegExp(`^\\|\\s*\\[(${idPattern(c)})\\]\\(([^)]*)\\)`);
  const rows: Row[] = [];
  readme.split(/\r?\n/).forEach((l, i) => {
    const m = re.exec(l);
    if (!m) return;
    const cs = cells(l);
    rows.push({
      id: m[1],
      file: m[2],
      title: (cs[1] ?? "").replace(/\\\|/g, "|"),
      after: cs.length >= 4 ? (cs[2].match(new RegExp(idPattern(c), "g")) ?? []) : [],
      status: cs[cs.length - 1] ?? "",
      line: i,
    });
  });
  return rows;
}

/** Replace the Status cell of one row (always the last cell). */
export function setRowStatus(c: Config, readme: string, id: string, status: string): string | null {
  const re = new RegExp(`^(\\|\\s*\\[${id}\\]\\(.*\\|\\s)[^|]*?(\\s*\\|)\\s*$`, "m");
  return re.test(readme) ? readme.replace(re, (_m, a, b) => `${a}${status}${b}`) : null;
}

export function addRow(readme: string, row: { id: string; file: string; title: string; after: string[] }): string {
  const line = `| [${row.id}](${row.file}) | ${row.title.replace(/\|/g, "\\|")} | ${row.after.join(", ") || "—"} | ${STATUS.todo} |`;
  if (readme.includes(END)) return readme.replace(END, `${line}\n${END}`);
  return `${readme.trimEnd()}\n\n${START}\n| Ticket | Title | After | Status |\n|---|---|---|---|\n${line}\n${END}\n`;
}

/** Ticket file: replace the "- **Status:** …" line. */
export function setTicketStatus(text: string, line: string): string {
  return /^- \*\*Status:\*\* .*$/m.test(text) ? text.replace(/^- \*\*Status:\*\* .*$/m, `- **Status:** ${line}`) : text;
}

export function renderTicket(id: string, title: string, o: { area?: string; after?: string[]; body?: string; model?: string }): string {
  let body = (o.body ?? TICKET_TEMPLATE).trim();
  if (!/^## Questions\b/m.test(body)) body += `\n\n## Questions\n\n${NO_QUESTIONS}`;
  if (!/^## Answer\b/m.test(body)) body += `\n\n## Answer\n\n${ANSWER_PLACEHOLDER}`;
  return (
    `# ${id}: ${title}\n\n` +
    `- **Status:** ${STATUS.todo} (created ${today()})\n` +
    `- **After:** ${o.after?.length ? o.after.join(", ") : "—"}\n` +
    `- **Area:** ${o.area?.trim() || "<files / functions this ticket changes>"}\n` +
    (o.model ? `- **Model:** ${o.model}\n` : "") +
    `\n${body}\n`
  );
}

// ── Model: the Claude model a ticket's tab runs on ("—", "default" or no line = the user's default) ─────────────────────────
/** What Claude Code accepts for --model: an alias (sonnet, opus[1m]) or an id (claude-sonnet-5-5, us.anthropic.…-v1:0). */
export const isModelName = (m: string) => m.length <= 100 && /^[A-Za-z0-9][\w.:\[\]-]*$/.test(m);
/** undefined for the default ("—", "-", "default" or nothing), else the model. */
export const modelOrDefault = (m: string | undefined) => (!m || /^(—|-|default)$/i.test(m) ? undefined : m);

/** The value of --model as given ("default" included), undefined without the flag; exits on a missing or odd value. */
export function modelArg(a: Args): string | undefined {
  if (!has(a, "model")) return undefined;
  const m = str(a, "model") ?? fail("--model needs a value: an alias (sonnet, opus, haiku) or a model id (claude-sonnet-5-5)", 2);
  return isModelName(m) ? m : fail(`--model: not a model name: ${m}`, 2);
}

/** The ticket's "- **Model:** …" line, or undefined for the default. */
export const ticketModel = (text: string) => modelOrDefault(/^- \*\*Model:\*\*[ \t]*(.*?)[ \t\r]*$/m.exec(text)?.[1]);

/** Model for `session open`: --model, else the ticket's Model line, else undefined (the user's default). */
export function sessionModel(flag: string | undefined, ticketText: string | null): string | undefined {
  if (flag !== undefined) return modelOrDefault(flag);
  return ticketText === null ? undefined : ticketModel(ticketText);
}

/** Add a question (or an answer to the last question) to the ## Questions section, just above ## Answer. */
export function addQuestion(text: string, entry: string): { text: string; count: number } {
  const lines = text.split("\n");
  let q = lines.findIndex((l) => /^## Questions\b/.test(l));
  if (q < 0) {
    const a = lines.findIndex((l) => /^## Answer\b/.test(l));
    const at = a < 0 ? lines.length : a;
    lines.splice(at, 0, "## Questions", "", NO_QUESTIONS, "");
    q = at;
  }
  let end = lines.findIndex((l, i) => i > q && /^## /.test(l));
  if (end < 0) end = lines.length;
  const section = lines.slice(q + 1, end).filter((l) => l.trim() !== NO_QUESTIONS);
  while (section.length && section[section.length - 1].trim() === "") section.pop();
  if (!section.some((l) => l.trim())) section.length = 0, section.push("");
  section.push(entry, "");
  lines.splice(q + 1, end - q - 1, ...section);
  const out = lines.join("\n");
  return { text: out, count: countQuestions(out) };
}
export const countQuestions = (text: string) => (text.match(/^- \*\*Q\b/gm) ?? []).length;

export function questionsOf(text: string): string {
  const m = /^## Questions\b[^\n]*\n([\s\S]*?)(?=^## |\s*$(?![\s\S]))/m.exec(text);
  return (m?.[1] ?? "").trim() || NO_QUESTIONS;
}
