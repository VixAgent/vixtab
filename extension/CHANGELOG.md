# Changelog

## 0.3.1 — 2026-10-24

- **VixTab is per project.** Up to 0.3.0, `vixtab setup` put the skills in `~/.claude/skills`, so every Claude Code session of
  every project on the machine listed them, and a session in an unrelated project could pick VixTab up on its own. Now:
  - `vixtab setup` installs only the CLI, and removes the user-level copies older versions left (only files that carry the
    VixTab marker; a copy you edited is kept). `--global-skills` restores the old behaviour, for those who want it.
  - The skills go into the repository being orchestrated, `<repo>/.claude/skills/vixtab-*`, kept out of git through
    `.git/info/exclude`: the VixTab button, `vixtab init` and `vixtab playground create` do it; `vixtab skills install
    [--commit] | remove [--global] | status` by hand.
  - `vixtab doctor` checks the repository's skills and warns about user-level copies.

## 0.3.0 — 2026-10-24

- **Sessions wait for each other, only when they must.** A ticket's After list is now enforced: `ticket claim` refuses
  (exit 8) while an After ticket is not ✅ DONE (`--ignore-after` overrides); `vixtab ticket ready` lists what can start and what
  the others wait for; `vixtab wait` reports `ready <id>` the moment a ticket's last dependency is done. A ticket session can wait
  for another ticket by itself (`vixtab wait --as T-005 T-003`). The playground demo checks all of it (19 checks).
- Orchestrator skill, from a real run on Windows: restart the waiter before handling events; handle several events per wake-up;
  dispatch on `ready`; a second `/vixtab-orchestrate` during a run is a status request, never a second dispatch; at the end stop
  `watch ram`, pull and run the tests on the result. The board folder is named explicitly.
- Extension page and README: a tour of every feature, with a new hand-drawn figure of the ways sessions wait for each other.
- Windows: answering Claude Code's folder-trust prompt with `--trust` works. ConPTY repaints only the cells that change, so the
  pointer position cannot be read back from later redraws; VixTab now reads the option order from the first drawing and presses
  the arrow key the right number of times.
- Release builds run on Windows as well as Linux: Bun runtimes for cross-compiling are downloaded from npm and checked against
  the registry's sha512 (`bun build --compile` could not extract Linux runtimes on Windows); `.tar.gz` archives are written by
  the build script with proper modes (the Linux program keeps its executable bit when built on Windows); no `zip` needed.
- x64 builds use Bun's baseline runtime (CPUs without AVX2 too). `install.sh` marks the program executable.

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
