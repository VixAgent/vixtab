# Changelog

## 0.1.0 — 2026-10-24

First public release.

- Ticket board on the main branch: `ticket list/new/show/claim/merge/done/release/ask/answer/overlap`; atomic locks, one
  worktree and branch per ticket, serialized merge queue with tests after rebase, status written after rebase, board-only edits
  committed with git plumbing.
- `session open/close/count/list` and `tab layout/even/open/close/windows`: fresh labeled Claude Code tabs in their own column,
  created without a model turn; resource gate (free RAM with reservation, swap, commit, CPU) instead of a fixed cap.
- `wait`: background waiter with `done`, `ask`, `rebase` and `gone` events, per-orchestrator state.
- `heavy` (elastic memory-capped slots: cgroup scope on Linux, Job Object on Windows), `watch ram`, `procs`, `lock`.
- `setup`, `doctor`, `init`, `playground` (sandbox + scripted demos), Claude Code skills `vixtab-orchestrate` and `vixtab-ticket`,
  Claude Code plugin manifest.
- VS Code extension `phanthaitrung.vixtab`: file-command bridge, status-bar button, set-up and playground commands; tab actions
  run one at a time; an empty tab opened instead of the session is detected and retried.
- Linux (x64, arm64) and Windows (x64) builds with the runtime included.
