---
name: vixtab-orchestrate
description: Orchestrate parallel work with VixTab — split a goal into self-contained tickets, open one fresh labeled Claude Code tab per ticket in its own column, assign it with one line, wait for events in the background without spending tokens, and close each tab when its ticket is done. Use when the user names VixTab or runs /vixtab-orchestrate, or asks to orchestrate, parallelize or split work across sessions in a repository that already has a vixtab.config.json or a VixTab ticket board. Do not pick it on your own from general words such as "orchestrator", "coordinator" or "parallel", in any language — ask the user whether they mean VixTab first. Do not use in repositories that have their own orchestration tooling unless the user names VixTab.
---
<!-- vixtab-managed: installed by VixTab (vixtab setup / vixtab skills); may be overwritten on upgrade -->

# VixTab orchestrator

You plan, dispatch and verify. **You do not implement tickets yourself**: every ticket runs in a fresh session, so each context
stays small and every turn stays cheap. `vt` below means `~/.vixtab/bin/vixtab` — run exactly that path through Bash (it works on
Linux and in Git Bash on Windows). User goal / extra instructions: $ARGUMENTS

## 0. Check once
- Already orchestrating in this session (tabs open, a waiter running) and invoked again ⇒ treat it as a status request:
  `vt ticket list`, report, add the new goal's tickets if one is given, and keep going. Never dispatch a ticket twice.
- `vt doctor --brief`. Report any FAIL line with its fix to the user; do not work around it.
- "no board" ⇒ ask the user, then `vt init` (creates the private board and its config outside the repository; nothing is
  committed or pushed).
- A warning "this board is on <remote>/<branch>, published with your code" ⇒ a board made by an older VixTab. `vt ticket list`:
  no ticket ⏳ DOING or ❓ ASK ⇒ `vt board migrate` before you dispatch, and tell the user in one line (the board moved to the
  private folder; one commit removed it from <branch>; the old files stay in the remote's history). Tickets in flight ⇒ keep
  working on the old board and migrate once none is in flight. Never pass `--force` without the user's go-ahead.
- BOARD below = the folder `vt board path` prints.

## 1. Plan tickets that can run in parallel
- Split the goal by code area. Every ticket gets `--area "<files, functions>"`. Same function or algorithm as another ticket, or it
  needs another ticket's result ⇒ `--after <that id>[,<id>…]`: VixTab then refuses to start it before those are ✅ DONE and tells you
  the moment it can start. Only the same file ⇒ run in parallel and add "rebase carefully: <file> is shared with T-x" to
  Boundaries. Queue only for real conflicts — parallel is the default.
- A ticket is self-contained: Request, Why, Where to look (files, functions, line hints), Expected result, How to verify (exact
  command), Boundaries. The session must not need to explore the repo. Write the body to a temp file, then
  `vt ticket new "<title>" --area "…" [--after T-x] [--model sonnet] --body-file <file>` (prints `id=`). Never edit the board table by hand.
- `--model sonnet` (or haiku) only for a ticket that is clearly simple and self-contained: a small, fully specified edit, docs, an
  asset. Anything that needs judgment, debugging or design keeps the default (no `--model`). The ticket's tab then runs on that
  model; the user's default is untouched.

## 2. Dispatch
`vt ticket ready` lists the tickets that can start now (`ready:`) and the ones that wait (`waits: T-5 after T-3 (⏳ DOING …)`).
For each ready ticket:
1. `vt session open <ID>` ⇒ `session=… name=<NAME> pid=<PID> label=… auto_name=… model=…` (the ticket's Model line, or `default`). Exit 6 = resource gate closed (RAM/CPU/swap) or every window full (`max` per window: the user's setting): stop opening,
   keep the rest queued, retry after the next `done` event. Exit 3 with "trust" (rare: only when the folder is not open in a VS Code
   window running VixTab) = ask the user; if they agree, re-run with `--trust`. Exit 5 = label already open. Exit 4 = tab problem: with "reload needed", stop opening
   and ask the user to reload the VS Code window (that restarts every session in it, so they choose when); otherwise retry once.
2. SendMessage to NAME, one line: `Work on ticket <ID> with the vixtab-ticket skill (board: BOARD).` If NAME is
   not reachable, try the `label=` and then the `auto_name=` value (Claude Code versions differ; ListAgents shows the right one).
3. Keep one line per ticket in your notes: ID, NAME, PID, model. Where the tab opens (a column next to you, or a ticket window) is
   decided by VixTab — do not move tabs around.
Then start ONE background waiter (run_in_background): `vt wait T-001:PID T-002:PID …`. Do not poll, sleep or Monitor; you are
notified when it exits. Also start `vt watch ram` in the background once.

## 3. React to events
The waiter prints ONE OR MORE events, one per line, then exits. Handle every line. Order: first restart the waiter (background)
for the tickets still running, so nothing is missed while you work; then handle the events; then open what became ready.
- `done <ID>` ⇒ `vt session close <ID> <PID>` (frees RAM; it can take up to a minute — one close at a time, never in parallel).
- `ready <ID>` ⇒ a waiting ticket's last After ticket is done: dispatch it (step 2) and add it to the waiter.
- `ask <ID> #n` ⇒ `vt ticket show <ID> --questions`. If you can answer: `vt ticket answer <ID> "<answer>"`, then SendMessage the
  answer (1–2 lines) to NAME. If only the user can answer, ask the user, then do the same.
- `rebase <ID> <files>` ⇒ SendMessage to NAME: `main now changes <files>; rebase on main and re-run your tests before merging.`
- `gone <ID>` ⇒ the session exited early. `vt ticket list`: if it has work, open a new session and tell it
  `Continue ticket <ID> with the vixtab-ticket skill (claim with --takeover).`; otherwise `vt ticket release <ID>` and requeue.
- `vt watch ram` exited with ALERT ⇒ stop opening; tell the most recently opened session that runs a heavy step to pause at a
  safe point; resume when `vt session count` says `open: yes`.
- `vt ticket overlap` lists files that two active tickets change, whenever you want a full picture.
- Sessions lag although RAM and CPU look fine ⇒ `vt session count`: a renderer near 90 % means that window holds too many
  Claude tabs; tell the user (VixTab already spreads new tabs over ticket windows).

## 4. Keep your own context small
- Trust the waiter and `vt ticket list`; do not read worker transcripts or diffs unless a check fails.
- One-line messages; never paste long documents into messages.
- Your context is getting large ⇒ write a handover note (each ticket: state, NAME, PID; the queue; rules learned) to a temp file,
  `vt board write HANDOVER.md --file <file>` (it commits the note on the board), `vt session open Orchestrator-2`, SendMessage it
  `Continue orchestrating: read BOARD/HANDOVER.md and use the vixtab-orchestrate skill.`, stop your own background tasks, and
  tell the user.

## 5. Finish
All tickets done ⇒ stop your background tasks (the `vt watch ram` you started never exits on its own), `vt procs orphans --kill`,
`git pull --ff-only` in your checkout (merges went to the remote), run the project's test command once on the result, then tell
the user one line per ticket (id, title, result) and the test result.
