# VixTab — parallel Claude Code tabs

Run many Claude Code sessions in parallel on one repository. One **Orchestrator** tab splits your goal into tickets, opens a
**fresh, labeled tab for every ticket** in its own column, gives it a one-line assignment, waits without spending tokens, and
closes the tab when the ticket is done. Every ticket works in its own git worktree and lands on `main` through a test-gated
merge queue.

![One orchestrator tab and one fresh tab per ticket](https://raw.githubusercontent.com/VixAgent/vixtab/main/docs/images/hero.png)

## Get started

1. Install this extension (the Claude Code extension comes along if you do not have it).
2. Click **Set up** in the notification, or run *VixTab: Set up* — it installs the `vixtab` command (`~/.vixtab/bin`) and two
   Claude Code skills (`~/.claude/skills`).
3. Open a git repository and click **VixTab** in the status bar. An *Orchestrator* tab opens with `/vixtab-orchestrate` typed
   in: add your goal and press Enter.

Want to see it first? Run *VixTab: Create playground* — a safe sandbox with five sample tickets.

![How VixTab lays out the tabs](https://raw.githubusercontent.com/VixAgent/vixtab/main/docs/images/layout-flow.png)

## What you get

- **Context-saving orchestration:** each ticket runs in a new, small session; the orchestrator reads one-line results and sleeps
  on a background waiter.
- **A tab per ticket:** labeled with the ticket id, in a new column to the right, focus kept, columns evened, closed by label.
- **Parallel without conflicts:** atomic locks, worktree per ticket, one merge at a time, tests after the rebase, red never lands.
- **Resource gates:** tabs open only when RAM, swap, commit charge and CPU have room; heavy steps use elastic, memory-capped slots.
- **Linux and Windows.**

![Why many short sessions cost less than one long one](https://raw.githubusercontent.com/VixAgent/vixtab/main/docs/images/context-saving.png)

## Commands

- **VixTab: Start orchestrator** (status-bar button) · **VixTab: Set up** · **VixTab: Run doctor** · **VixTab: Create playground**
  · **VixTab: Even column widths**

## Requirements

VS Code 1.90+, the Claude Code extension (signed in), git, a remote with a `main` branch. Linux x64/arm64 or Windows x64.

VixTab uses Claude Code internals that are not public APIs (checked with Claude Code 2.1.280 and 2.1.308); a Claude Code update
can break them. Independent project, not affiliated with Anthropic.

Documentation, CLI reference and source: https://github.com/VixAgent/vixtab · MIT License
