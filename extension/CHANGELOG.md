# Changelog

## 0.9.0 — 2026-10-29

- **Usage guard for your Claude plan.** VixTab reads the usage of the account Claude Code is logged in with, the numbers of
  `/usage`: the 5-hour session, the week (all models), the week of single models and extra usage, each with its reset time.
  It uses the login Claude Code already keeps on the machine (`<claude dir>/.credentials.json`) and never refreshes or
  rewrites it; reading costs no usage, and nothing else needs to be installed. New commands: `vixtab usage [--json]`,
  `vixtab usage limit [<percent>]`, `vixtab usage wait` (sleeps until the account is below the limit, then exits) and
  `vixtab watch usage` (exits with `ALERT usage: …` when the 5-hour session or the week reaches the limit; it reads every
  240 s, every 120 s within 10 points of the limit). One reading is shared by every project and window (cached in
  `~/.cache/vixtab/usage.json`); the server rate-limits readings, so after a failure VixTab waits 1 to 15 minutes before
  asking again and shows the last reading (at most 15 minutes old), marked as such.
- **Usage limit setting.** *VixTab: Usage Limit* (`vixtab.usageLimit`, default 96 %), kept in `~/.vixtab/config.json` for
  every project on the machine (`VIXTAB_USAGE_LIMIT` overrides it). The orchestrator skill starts `vixtab watch usage` with
  `vixtab watch ram`; on an alert it pauses: no new tabs, each ticket tab closed without releasing its ticket (still ⏳ DOING,
  the work stays in its worktree), a handover note on the board, then `vixtab usage wait` in the background, and it reopens
  each ticket with `claim --takeover` once the limit has reset. `session open` exits 6 with `usage: …` while the account is
  at the limit; `session count` and `doctor` show the usage. An unknown usage (no claude.ai login, no network, an expired
  access token) never blocks anything.
- **Claude usage in the panel.** A **Claude usage** row shows `5h n % · week n %` (yellow within 10 points of the limit, red
  at it), the reset times and the account in its tooltip; click it (or *VixTab: Show Claude usage*) to read it again.

## 0.8.1 — 2026-10-26

- **Max tabs per window, in the settings.** New setting *VixTab: Max Tabs Per Window* (`vixtab.maxTabsPerWindow`, default
  6): the most Claude tabs VixTab opens in one VS Code window, the orchestrator's tab included. Ticket windows now take 6
  tabs too (they took 5). Each time a tab opens, VixTab counts the Claude tabs every window holds at that moment, so closed
  tabs free their place and tabs you opened yourself count; the chosen window counts once more right before opening, and
  VixTab chooses again if it filled up in between. A full window is never used: in `columns` mode, with
  `VIXTAB_EXT_HOST_PID`, or when no ticket window can open, `session open` exits 6 (queue the ticket) instead of adding a
  column. *Start orchestrator* (`--here`) ignores the cap. `"tabs"` `inWindowMax` / `perWindowMax` in `vixtab.config.json`
  still override the setting for one project. `vixtab session count` prints `claude_tabs=<n>/<cap>` for each window.

## 0.8.0 — 2026-10-25

- **Model per ticket.** `vixtab ticket new … --model <m>` writes a `- **Model:** <m>` line, and `vixtab session open <ID>
  [--model <m>]` opens the tab on that model (`--model`, else the ticket's Model line, else your default). `<m>` is an alias
  (`sonnet`, `opus`, `haiku`) or a model id. The model is set for that session only: the bootstrap CLI runs with `--model` and
  answers one short prompt, and Claude Code keeps a resumed session's model. No settings file changes. `session open` prints
  `model=<m>` or `model=default`; the orchestrator skill gives `--model` only to clearly simple tickets.
- **The ticket board is private.** `vixtab init` creates it in `<home>/board` (next to the ticket worktrees, by default
  `<repo>.vixtab/board`): a local git repository whose history records every claim, question, answer and status change, never
  pushed. The config goes to `<home>/vixtab.config.json`; a `vixtab.config.json` in the repository is still used when there
  is one. Nothing is committed in the project and only code reaches `<remote>/<branch>`. `--push` is ignored. Sessions write
  their Answer in the ticket file on the board (claim prints its path) and `ticket done` commits it. Boards already on the main
  branch keep working there, with a warning (also in `vixtab status` and `vixtab doctor`) until `vixtab board migrate` moves them.
- **Tabs overview.** The VixTab panel has a **Tabs** section: every Claude tab running on this machine, in every project,
  grouped by VS Code window (main or ticket window, number of Claude tabs, renderer load with ⚠ from 90 %), each with its
  state (busy, idle, asking) and for how long, its ticket's status and the model VixTab opened it on; a summary line from the
  resource gate (free RAM, CPU, can a new tab open); and *Finished and closed*, the tabs VixTab opened that have closed (last
  50, collapsed, with *Clear*). It refreshes every 5 s while the panel is visible, renderer load at most once a minute. New
  command `vixtab tabs [--json] [--load]` (and `tabs clear`); `session open` and `session close` record each tab in
  `~/.cache/vixtab/tabs.jsonl`.
- **`vixtab board migrate [--dry-run] [--keep-on-main] [--force]`** moves a board made by 0.7.0 or older (`tickets/` and
  `vixtab.config.json` on `<remote>/<branch>`) into the private board: every file is copied into `<home>/board` in one
  "import from <remote>/<branch> at <sha>" commit, the config into `<home>/vixtab.config.json`, then one commit on the main
  branch ("Move the VixTab board out of the repository") removes both. It is refused while a ticket is ⏳ DOING or ❓ ASK, runs
  under the merge lock, and a second run has nothing to do. The files stay in the remote's git history; VixTab never rewrites
  it. `vixtab board path` prints the board folder and `vixtab board write <name> --file F` commits an extra file there; the
  orchestrator skill writes its HANDOVER.md that way and migrates an old board before dispatching when nothing is in flight.
- The extension icon has a transparent background: only the window shape shows in the Extensions view.
- `vixtab wait` never reports `ready <id>` before the `done` of the watched ticket that unblocks it (a done marker written
  while a pass was reading the board could cause that), and it also waits until every other ticket in the After list has
  finished `ticket done` on this machine. Folders spelled with Windows 8.3 short names (`C:\Users\RUNNER~1\…`) now match
  their long form.
- `vixtab ticket merge`, `vixtab heavy` and `vixtab lock` accept the command after `--` as one quoted line
  (`-- "bun run typecheck && bun test test/"`): it runs through bash with pipefail instead of failing with `ENOENT`.

## 0.7.0 — 2026-10-25

- **The extension is now `vixagent.vixtab`** (VixAgent brand), in the Marketplace and in *Settings ▸ Extensions*
  (`@ext:vixagent.vixtab`). Up to 0.6.0 it was `phanthaitrung.vixtab`. VS Code sees a new extension, so the old one is removed:
  `vixtab setup --extension` (and the one-line installers) uninstall it; in a window that still runs it, the new one removes it,
  stays inactive and offers *Reload Window*, so the two never answer the same commands. Settings (`vixtab.*`) are kept.
- `vixtab status` and `vixtab doctor` name the extension and warn while `phanthaitrung.vixtab` is still installed. Installed
  versions are read from VS Code's own list (`extensions.json`), not from folders VS Code leaves behind until a restart.

## 0.6.0 — 2026-10-25

- **No folder-trust prompt.** VixTab creates sessions only for folders open in a VS Code window where it runs — VS Code
  runs extensions only in workspaces it trusts, and the Claude Code tab there has no trust prompt of its own. The short bootstrap
  CLI (it only types `/rename` and `/exit`) now starts with Claude Code's `CLAUDE_CODE_SANDBOXED` switch instead of stopping at
  *Do you trust the files in this folder?*. Nothing is written to `~/.claude.json`. `--trust` remains for other folders.
- **The orchestrator's own window first.** A new tab goes into the orchestrator's window until it holds 6 Claude tabs (new
  columns up to 3, then stacked in the last column); then into the ticket window with the fewest tabs (5 each); a new ticket
  window opens only when every existing one is full. New settings `inWindowMax` (6) and `columnsMax` (3) in `"tabs"`.
- **Ticket windows close themselves** as soon as they hold no Claude tab, however the tabs were closed (by VixTab, by hand, by
  Claude Code), 5 s later, never while a tab is being opened in them.
- `vixtab doctor` reports folder trust from VS Code instead of warning about the CLI prompt.

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
