# Tickets

This board is managed by [VixTab](https://github.com/VixAgent/vixtab). Each ticket is a self-contained task that one fresh
Claude Code session works on, in its own git worktree, while an orchestrator session dispatches tickets and closes finished tabs.

**Protocol for the session that works on a ticket** (details: the `vixtab-ticket` skill):

1. Claim: `vixtab ticket claim <id> --as <session>` — locks the ticket, creates its worktree and branch, marks it ⏳ DOING on `{{branch}}`.
2. Work only inside that worktree. Commit only the files you changed (never `git add -A`).
3. Merge: `vixtab ticket merge <id> -- <test command>` — merges are serialized, rebased on `{{branch}}` and tested after the rebase;
   red tests are never pushed.
4. Fill in `## Answer` in the ticket file, commit it, then `vixtab ticket done <id>` — ✅ DONE, the worktree is removed.
5. Stuck or unclear: `vixtab ticket ask <id> "<question>"` — ❓ ASK; the orchestrator answers.

Status values: ☐ TODO · ⏳ DOING (session) · ❓ ASK (session) · ✅ DONE (session). Do not edit the Status column by hand: VixTab
writes it after rebasing, so tickets claimed or finished at the same moment never conflict. **After** lists tickets that must be
merged first.

<!-- vixtab:board -->
| Ticket | Title | After | Status |
|---|---|---|---|
<!-- /vixtab:board -->
