---
name: vixtab-ticket
description: Work on one VixTab ticket end to end in its own git worktree — claim it, implement, merge through the test-gated merge queue, fill in the Answer, mark it done, and print the closing line. Use when told to work on or continue a ticket with the vixtab-ticket skill or with VixTab (for example "Work on ticket T-001 with the vixtab-ticket skill").
---
<!-- vixtab-managed: installed by VixTab (vixtab setup / vixtab skills); may be overwritten on upgrade -->

# Work on a VixTab ticket

Ticket and instructions: $ARGUMENTS (or the message you received). `vt` = `~/.vixtab/bin/vixtab`, run exactly that path via Bash.

1. **Name.** Your session name is the first line of ListAgents ("This session is <name>"); if unavailable, use the ticket id.
2. **Claim.** `vt ticket claim <ID> --as <name>` (add `--takeover` only when told to continue a ticket). It prints the worktree
   and the ticket file. All work happens in that worktree: `cd` there and `source .vixtab.env` (your private port is
   `$VIXTAB_PORT`). Never edit the main checkout.
3. **Read only what you need:** the ticket file, then the files it points to. Do not scan the repo.
4. **Implement.** Heavy steps (full test suite, E2E, bundler build, browser) go through `vt heavy -- <command>`, which waits for
   free resources and caps memory. One dev server and one browser at most. Commit only files you changed (`git add <files>`,
   never `git add -A`).
5. **Merge.** `vt ticket merge <ID> -- <test command from the ticket>`. Red tests ⇒ nothing is pushed: fix and merge again.
   Rebase conflict ⇒ resolve in the worktree, `git add <files>`, `GIT_EDITOR=true git rebase --continue`, merge again.
   A message says main changed your files ⇒ rebase now (`git fetch -q && git rebase <remote>/<branch>`) and re-run the tests.
6. **Answer.** Replace the placeholder under `## Answer` in the ticket file (in the worktree): commits, tests run, notes, open
   points. Commit it, then `cd` back to the repository root and run `vt ticket done <ID>`: it pushes the answer, marks ✅ DONE,
   stops processes in the worktree and removes it (Windows cannot delete a folder that is your shell's current directory).
7. **Stuck or unclear?** `vt ticket ask <ID> "<question>"`, then stop and wait: the answer arrives as a message. Continue from there.
   **Need another ticket's result first** (it is not on main yet)? Run `vt wait --as <ID> <other ID>` in the background, stop, and
   when it reports `done <other ID>`: `git fetch -q && git rebase <remote>/<branch>` and continue. Do not copy its code over.
8. **Last line** of your final message, exactly: `DONE — THIS SESSION CAN BE CLOSED (<ID>)`
