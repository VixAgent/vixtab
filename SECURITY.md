# Security policy

Please report vulnerabilities privately through GitHub: **Security ▸ Report a vulnerability** on
https://github.com/VixAgent/vixtab. Do not open a public issue for them. You will get an answer within a few days.

What VixTab trusts and touches:

- It runs as your user. The VS Code extension executes only four actions on Claude Code tabs (open, close, layout, even) from
  command files in `~/.cache/vixtab/commands` — a file any process of your account can write, i.e. the same trust boundary as
  your account itself.
- Folder trust follows VS Code: VixTab creates sessions only for folders open in a VS Code window where its extension runs (so VS
  Code trusts the workspace), and starts its short bootstrap CLI there with `CLAUDE_CODE_SANDBOXED=1` instead of the CLI's own trust
  prompt; nothing is persisted. For other folders it answers that prompt only when you pass `--trust`.
- It stops processes only inside ticket worktrees, never VS Code, Claude Code, sshd or the desktop shell.
- Network access happens through git only. Release downloads in `install.sh` / `install.ps1` are checked against `SHA256SUMS`.
