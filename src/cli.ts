#!/usr/bin/env bun
// VixTab — run many Claude Code sessions in parallel on one repository, one fresh labeled VS Code tab per ticket.
import { board, HELP as BOARD } from "./commands/board.ts";
import { doctor } from "./commands/doctor.ts";
import { heavy, HELP as HEAVY } from "./commands/heavy.ts";
import { init, HELP as INIT } from "./commands/init.ts";
import { lock, HELP as LOCK } from "./commands/lock.ts";
import { playground, HELP as PLAYGROUND } from "./commands/playground.ts";
import { procs, HELP as PROCS } from "./commands/procs.ts";
import { session, HELP as SESSION } from "./commands/session.ts";
import { setup, HELP as SETUP } from "./commands/setup.ts";
import { skills, HELP as SKILLS } from "./commands/skills.ts";
import { status, HELP as STATUS } from "./commands/status.ts";
import { tab, HELP as TAB } from "./commands/tab.ts";
import { tabs, HELP as TABS } from "./commands/tabs.ts";
import { ticket, HELP as TICKET } from "./commands/ticket.ts";
import { wait, HELP as WAIT } from "./commands/wait.ts";
import { watch, HELP as WATCH } from "./commands/watch.ts";
import { VixError } from "./core/util.ts";
import { VERSION } from "./version.ts";

const USAGE = `VixTab ${VERSION} — parallel Claude Code sessions, one fresh tab per ticket

Usage: vixtab <command> …      (vixtab help <command> for details)

  Getting started
    setup                 install the CLI to ~/.vixtab/bin, PATH, and the skills (every project, or chosen ones)
    skills scope|install|status   where the Claude Code skills apply: every project (default) or chosen ones
    status                is VixTab set up for this project? which versions (CLI, extension, skills), board
    doctor [--brief]      check git, the board, Claude Code, the VS Code extension, skills, resources
    init                  add a private ticket board (<home>/board, outside the repository, never pushed)
    playground …          a safe sandbox and scripted demos

  Tickets (any session)
    ticket list|new|show|ready|claim|merge|done|release|ask|answer|overlap
    board path|write|migrate      the private board: its folder, extra files (HANDOVER.md), moving an old board off main

  Tabs and sessions (orchestrator)
    session open|close|count|list     fresh labeled Claude Code tabs, resource-gated
    tab layout|even|open|close|windows
    tabs [--json] [--load] | clear    every Claude tab of this machine by window, state, ticket; the closed ones
    wait <id>[:pid] …                 sleep until a ticket is done / asks / needs a rebase / its session died

  Machine
    heavy -- <cmd>        run a heavy step through elastic, memory-capped slots
    watch ram             exit (alert) when the machine runs low on memory
    procs list|kill|orphans
    lock <name> -- <cmd>  portable flock

Docs: https://github.com/VixAgent/vixtab`;

const COMMANDS: Record<string, [(argv: string[]) => Promise<void>, string]> = {
  ticket: [ticket, TICKET],
  board: [board, BOARD],
  session: [session, SESSION],
  tab: [tab, TAB],
  tabs: [tabs, TABS],
  wait: [wait, WAIT],
  heavy: [heavy, HEAVY],
  watch: [watch, WATCH],
  procs: [procs, PROCS],
  lock: [lock, LOCK],
  init: [init, INIT],
  setup: [setup, SETUP],
  skills: [skills, SKILLS],
  status: [status, STATUS],
  doctor: [doctor, "vixtab doctor [--brief] [--json]"],
  playground: [playground, PLAYGROUND],
};

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    const topic = rest[0] && COMMANDS[rest[0]];
    console.log(topic ? topic[1] : USAGE);
    return;
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") return void console.log(VERSION);
  const c = COMMANDS[cmd];
  if (c && (rest.includes("--help") || rest.includes("-h"))) return void console.log(c[1]);
  if (!c) {
    console.error(`unknown command: ${cmd}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  await c[0](rest);
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  if (e instanceof VixError) {
    console.error(e.message);
    process.exitCode = e.code;
  } else {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exitCode = 1;
  }
}
process.exit(process.exitCode ?? 0);
