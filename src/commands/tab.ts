// vixtab tab layout | even | open <session> | close <label> — low-level tab control through the VixTab extension.
import { has, parseArgs, str } from "../core/args.ts";
import { callerWindow, claudeTabCount, layout, openTicketWindow, send, windows } from "../core/bridge.ts";
import { loadConfig } from "../core/config.ts";
import { fail } from "../core/util.ts";

export const HELP = `vixtab tab — tab control of the current VS Code window (needs the VixTab extension)

  tab layout [--json]                    columns and their tabs
  tab even                               equal column widths
  tab open <session-uuid> [--prompt T] [--focus] [--here]
                                         open an existing Claude Code session in a new column (or the active one)
  tab close <label>                      close the Claude tab with exactly this label
  tab join                               join all columns into one group (stacked tabs)
  tab windows                            VS Code windows that run the extension: kind, Claude tabs, folders
  tab new-window                         open a ticket window on this repository (prints its extension-host pid)`;

export async function tab(argv: string[]): Promise<void> {
  const [action, ...rest] = argv;
  const a = parseArgs(rest, ["prompt"]);
  switch (action) {
    case "layout": {
      const l = await layout();
      if (has(a, "json")) return void console.log(JSON.stringify(l, null, 1));
      for (const g of l) console.log(`column ${g.column}${g.active ? " (active)" : ""}: ${g.tabs.map((t) => `${t.active ? "*" : ""}${t.label}${t.claude ? " [claude]" : ""}`).join(" | ")}`);
      return;
    }
    case "even":
      await send("even");
      return void console.log("Columns evened.");
    case "join":
      await send("join");
      return void console.log("Joined all columns into one group.");
    case "new-window":
      return void console.log(`window=${await openTicketWindow(loadConfig().repo)}`);
    case "open": {
      const session = a._[0] ?? fail("usage: vixtab tab open <session-uuid>", 2);
      const r = await send("open", { session, prompt: str(a, "prompt"), focus: has(a, "focus"), here: has(a, "here") });
      return void console.log(`Opened in column ${r.column}.`);
    }
    case "close": {
      const label = a._[0] ?? fail("usage: vixtab tab close <label>", 2);
      const r = await send("close", { label });
      if (!r.closed) fail(`NOT CLOSED: ${r.matches} Claude tabs are labeled "${label}"`, 1);
      return void console.log(`Closed "${label}".`);
    }
    case "windows": {
      const me = callerWindow();
      for (const w of windows()) console.log(`${w.pid}  v${w.version}  ${(w.kind ?? "main").padEnd(7)}  claude_tabs=${await claudeTabCount(w.pid)}${w.pid === me ? "  (this window)" : ""}  ${w.folders.join(", ")}`);
      return;
    }
    default:
      console.log(HELP);
      if (action && action !== "help") process.exitCode = 2;
  }
}
