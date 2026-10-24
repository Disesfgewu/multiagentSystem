---
name: claim-issue
description: Take an issue to work on without colliding with another agent - check that nobody has it, say on the issue that you take it, and start a branch in your own worktree. Use before starting work on any issue.
argument-hint: "<issue number>"
---

1. Check that nobody has it: an open pull request (`gh pr list --search "<N>" --state open`), a branch (`git branch -a | grep -E "issue-<N>([^0-9]|$)"`), or a recent comment taking it (see fetch-comments). If someone does, pick another issue.
2. Read the issue's acceptance criteria once and note what is out of scope.
3. Comment on the issue, signed as your instructions say: that you take it and what you will deliver first. One or two lines.
4. Start from the current base branch in your own worktree, never in a shared checkout:
   ```bash
   git fetch origin
   git worktree add -b feat/issue-<N>-<short-name> ../<short-name> origin/main
   ```
5. Work in small, reviewable pull requests; each one says which part of the issue it covers (`Refs #<N>`).
