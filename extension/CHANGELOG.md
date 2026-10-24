# Changelog

## 0.5.1 — 2026-10-24

- Ticket windows say which project opened them: the title is `[<project>] VixTab tickets N — …` and the workspace file
  `<project>-tickets-N.code-workspace`.
- Upgrading while an orchestration runs: `vixtab setup` no longer stops when an earlier, renamed copy of the program is still
  running (Windows cannot delete it); it is left for the next upgrade.
- `vixtab status` in a folder that is not a git repository says whether its sessions see the skills, and that a board needs git.
- `ticket done` writes its done marker last, after the worktree is removed, so `vixtab wait` reports `done` (and the orchestrator
  closes the tab) only when the session has nothing left to clean up; `ready` events never come before the `done` that causes
  them (a race seen once in CI-like runs).

## 0.5.0 — 2026-10-24

- **VixTab in the Activity Bar.** A VixTab icon in VS Code's left bar, like Claude Code's, opens the VixTab panel: *Start
  orchestrator*, whether this project can use VixTab (and the skills version) or a one-click set-up, the board's tickets with
  their status (click one to read it; refreshed every minute while the panel is open), versions, playground, doctor, settings.
- **`vixtab status`**: is VixTab set up for this project, and which versions — the CLI (this program and `~/.vixtab/bin`), the
  VS Code extension (installed, and what each open window runs; a window keeps its version until reopened), the skills (scope,
  copies, version) and the board. `--json` for scripts. In VS Code: *VixTab: Show status*, and the VixTab button's tooltip.
- Every installed skill file carries the version that wrote it (`<!-- vixtab-managed v0.4.1: … -->`).

## 0.4.0 — 2026-10-24

- **Choose where VixTab applies: every project (default) or only the projects you choose.** The skills scope is saved in
  `~/.vixtab/config.json` and kept by later setups and upgrades.
  - Every project: the skills live in `~/.claude/skills`; any Claude Code session on the machine can use VixTab.
  - Only chosen projects: the 0.3.1 behaviour — the skills go into `<repo>/.claude/skills` (kept out of git) of the
    repositories where you click VixTab or run `vixtab init` / `vixtab skills install`.
  - Choose it in the first-run notification, in *Settings ▸ VixTab: Skills Scope* (applies at once), with
    `vixtab skills scope global|project`, `vixtab setup --scope …`, or `VIXTAB_SKILLS_SCOPE` for the one-line installers.
  - `vixtab doctor` and `vixtab skills status` report the scope and check the matching copies.
- The orchestrator skill no longer starts on its own from a general word such as "orchestrator" or "parallel": Claude asks
  whether you mean VixTab.
- The scripted playground demo installs no skills; the end-to-end test runs with an isolated Claude config.

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
