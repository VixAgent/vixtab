# Changelog

## 0.2.0 — 2026-10-24

- **Ticket windows.** All Claude tabs of one VS Code window share one renderer thread (14 visible columns: 102 % of a core,
  every session frozen; 7 stacked tabs: 91 %). New `"tabs"` policy: `auto` (default — 3 columns next to the orchestrator,
  then ticket windows with 5 stacked tabs each), `windows`, `columns`. Ticket windows open from
  `<repo>/.vixtab/windows/tickets-N.code-workspace` (inside the trusted repo, excluded from git). `session close` finds tabs in
  every window; a ticket window closes itself after its last Claude tab; `session count` lists windows, their Claude tabs and the
  busiest renderer thread; `tab join`, `tab new-window`; `VIXTAB_ORCHESTRATOR_WINDOW` for driving VixTab from outside VS Code.
- Test commands always run with `pipefail` (`bash -o pipefail`; Ubuntu dash has none); `-- bash -c …` / `-- sh -c …` too.
- Worktree removal on Windows: leaves the worktree first, stops processes again between attempts (15 tries), unlinks leftover
  junctions without following them, keeps real files and reports them.
- `session open` waits up to 45 s for the tab Claude process on a busy machine.

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
