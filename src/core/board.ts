// The board: <board>/README.md holds the ticket table, <board>/<id>-<slug>.md holds each ticket.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import BOARD_TEMPLATE from "../../templates/board-readme.md" with { type: "text" };
import TICKET_TEMPLATE from "../../templates/ticket.md" with { type: "text" };
import { type Config, idPattern, mainRef } from "./config.ts";
import { git } from "./run.ts";
import { fail, today } from "./util.ts";

export const STATUS = {
  todo: "☐ TODO",
  doing: (who: string) => `⏳ DOING (${who})`,
  ask: (who: string) => `❓ ASK (${who})`,
  done: (who: string) => `✅ DONE (${who})`,
};
export const ANSWER_PLACEHOLDER = "_(the session that works on this ticket fills this in: commits, tests run, notes)_";
export const NO_QUESTIONS = "_(none)_";
const END = "<!-- /vixtab:board -->";

export const boardReadme = (c: Config) => BOARD_TEMPLATE.replaceAll("{{branch}}", c.branch);
export const ticketBodyTemplate = () => TICKET_TEMPLATE;

export type Row = { id: string; file: string; title: string; after: string[]; status: string; line: number };

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
  return `${readme.trimEnd()}\n\n<!-- vixtab:board -->\n| Ticket | Title | After | Status |\n|---|---|---|---|\n${line}\n${END}\n`;
}

/** Ticket file: replace the "- **Status:** …" line. */
export function setTicketStatus(text: string, line: string): string {
  return /^- \*\*Status:\*\* .*$/m.test(text) ? text.replace(/^- \*\*Status:\*\* .*$/m, `- **Status:** ${line}`) : text;
}

export function renderTicket(id: string, title: string, o: { area?: string; after?: string[]; body?: string }): string {
  let body = (o.body ?? TICKET_TEMPLATE).trim();
  if (!/^## Questions\b/m.test(body)) body += `\n\n## Questions\n\n${NO_QUESTIONS}`;
  if (!/^## Answer\b/m.test(body)) body += `\n\n## Answer\n\n${ANSWER_PLACEHOLDER}`;
  return (
    `# ${id}: ${title}\n\n` +
    `- **Status:** ${STATUS.todo} (created ${today()})\n` +
    `- **After:** ${o.after?.length ? o.after.join(", ") : "—"}\n` +
    `- **Area:** ${o.area?.trim() || "<files / functions this ticket changes>"}\n\n` +
    `${body}\n`
  );
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

/** Ticket file inside a checkout or worktree W. */
export function ticketFileIn(c: Config, W: string, id: string): string | null {
  const d = join(W, c.board);
  if (!existsSync(d)) return null;
  const f = readdirSync(d).find((n) => (n.startsWith(`${id}-`) || n === `${id}.md`) && n.endsWith(".md"));
  return f ? join(d, f) : null;
}

/** Write DOING/DONE… into README + ticket inside worktree W; returns repo-relative paths to stage. */
export function writeStatusIn(c: Config, W: string, id: string, cell: string, ticketLine: string): string[] {
  const readme = join(W, c.board, "README.md");
  const changed: string[] = [];
  if (existsSync(readme)) {
    const next = setRowStatus(c, readFileSync(readme, "utf8"), id, cell);
    if (next !== null) {
      writeFileSync(readme, next);
      changed.push(`${c.board}/README.md`);
    } else console.log(`  (no row for ${id} in ${c.board}/README.md — skipped)`);
  }
  const t = ticketFileIn(c, W, id);
  if (t) {
    writeFileSync(t, setTicketStatus(readFileSync(t, "utf8"), ticketLine));
    changed.push(`${c.board}/${t.split(/[\\/]/).pop()}`);
  }
  return changed;
}

// ── Reading the board from the main branch on the remote (the shared checkout may be stale) ───────────────────────────────
export const fetchMain = (c: Config) => git(c.repo, "fetch", "-q", c.remote, c.branch);

export function showMain(c: Config, path: string): string | null {
  const r = git(c.repo, "show", `${mainRef(c)}:${path}`);
  return r.code === 0 ? r.out : null;
}
export function boardFilesOnMain(c: Config): string[] {
  const r = git(c.repo, "ls-tree", "--name-only", `${mainRef(c)}:${c.board}`);
  return r.code === 0 ? r.out.split("\n").filter(Boolean) : [];
}
export function readBoard(c: Config): { readme: string; rows: Row[] } {
  const readme = showMain(c, `${c.board}/README.md`);
  if (readme === null) fail(`no board on ${mainRef(c)}: ${c.board}/README.md is missing (run: vixtab init --push)`, 2);
  return { readme, rows: parseRows(c, readme) };
}
export function ticketOnMain(c: Config, id: string): { path: string; text: string } | null {
  const f = boardFilesOnMain(c).find((n) => (n.startsWith(`${id}-`) || n === `${id}.md`) && n.endsWith(".md"));
  if (!f) return null;
  const path = `${c.board}/${f}`;
  const text = showMain(c, path);
  return text === null ? null : { path, text };
}
