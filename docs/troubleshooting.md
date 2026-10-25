# Troubleshooting

Start with `vixtab doctor` inside the repository: every FAIL line comes with its fix.

## `session open` exit codes

| Exit | Meaning | What to do |
|---|---|---|
| 2 | bad label, or the VS Code window's folder is not the `--cwd` folder | Claude Code only opens sessions of the window's own folder: open the repository in VS Code (`code -n <repo>`) and run the orchestrator there |
| 3 + `trust:` | the folder is not open in a VS Code window running VixTab, so VixTab cannot rely on VS Code's trust (normally there is no prompt at all) | open the folder in VS Code; or, if the user agrees, run the same command with `--trust` (VixTab then selects "Yes, I trust this folder") |
| 3 (other) | the Claude CLI did not start or did not save the session title | the message ends with the CLI screen; check that the Claude Code extension is installed and signed in |
| 4 + `reload needed` | Claude Code's own tab state is broken ("Webview is disposed") | reload the VS Code window (*Developer: Reload Window*); this restarts every Claude session of that window, so the user chooses when |
| 4 (other) | the tab did not start its Claude process, or the extension did not answer | retry once; `vixtab tab windows` lists the windows that run the extension |
| 5 | a Claude tab with this label is already open | pick another label or close that tab |
| 6 | resource gate closed (RAM, swap, commit, CPU, or `sessions.max`) | keep the ticket queued; `vixtab session count` shows what is missing |

## Tabs close slowly

Closing a Claude tab makes Claude Code shut its CLI down, MCP servers included; that took up to a minute in tests on Linux.
VixTab waits (up to two minutes) and runs tab actions one at a time: with Claude Code 2.1.280, two Claude tabs disposed at the
same moment could leave a disposed panel in Claude Code's session map, after which opening any tab failed until the window was
reloaded.

## "No agent named 'T-001' is reachable"

Claude Code versions differ in how cross-session messages address a session: 2.1.308 uses the tab label (the `/rename` title),
2.1.280 the auto-generated name (`project-47`). `session open` prints `name=` (the one expected to work), `label=` and
`auto_name=`; the orchestrator skill tries them in that order. `ListAgents` shows the right one.

## A tab opened as an empty "Claude Code" conversation

Claude Code could not load the session yet (busy window). The extension detects the unlabeled tab, closes it, and retries up to
three times. If it still fails, `session open` exits with code 4.

## All tabs lag although the machine is idle

All Claude tabs of one VS Code window run in that window's renderer thread. `vixtab session count` prints the busiest renderer
thread of each local VS Code window; around 90 % or more means that window is saturated. Use ticket windows (`"tabs": {"mode":
"windows"}` or a lower `perWindowMax`), and *View: Join All Editor Groups* (`vixtab tab join`) to stack the columns of an
overloaded window. Do not reload a window that runs sessions: reloading restarts every Claude session in it.

## A ticket window does not open

`vixtab tab new-window` runs `code -n <repo>/.vixtab/windows/<project>-tickets-N.code-workspace` and waits 60 s for the new window to
register. Check that the `code` command works, that VS Code is not waiting on a dialog (or a locked screen), and that the
repository folder is trusted in VS Code (a workspace in an untrusted folder opens in Restricted Mode, without extensions).

## Tests run in the wrong shell on Windows

Test commands from `vixtab.config.json` (`"test"`) run in Git Bash. `C:\Windows\System32\bash.exe` is the WSL launcher and would
run them inside Linux, so VixTab looks for `bash.exe` next to `git.exe` instead. Without Git Bash it falls back to `cmd.exe`.

## Heavy runs are not memory-capped on Linux

The cap uses `systemd-run --user --scope`. WSL and containers often have no systemd user session; `vixtab doctor` then reports
`heavy cap: none` and runs only get a lower CPU priority.

## Logs

- Extension: *Output ▸ VixTab*, and `~/.cache/vixtab/logs/ext-<pid>.log` (every tab action with its duration).
- RAM watch: `<repo>.vixtab/logs/ram.log`.
