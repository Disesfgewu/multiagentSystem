---
name: resolve-conflicts
description: Rebase a PR whose sibling merged first (the recurring "stacked PR on an unmerged branch" / merge-conflict pattern in this repo) without burning a full review round-trip. Use instead of re-deriving the rebase steps from scratch each time two PRs collide.
args: "<PR number>"
---

1. **Confirm it's a real conflict, not a stale UI cache:**
   ```bash
   N=<PR number>
   gh pr view "$N" --json mergeable,mergeStateStatus,baseRefName,headRefName
   ```
   `mergeable: CONFLICTING` is authoritative; `UNKNOWN` means GitHub hasn't computed it yet, re-check in a minute rather than acting on it.

2. **Isolate, don't touch the shared checkout:**
   ```bash
   git fetch origin --prune
   git worktree add /tmp/claude-conflict-$N "refs/heads/$(gh pr view $N --json headRefName -q .headRefName)" -q
   cd /tmp/claude-conflict-$N
   git rebase origin/main
   ```

3. **Resolve conflicts keep-both unless one side is clearly dead code**: when both sides added real functionality in the same region, keep both and re-check they compose correctly (don't silently drop a sibling's finished work) — this project has had two incidents of a dependent PR losing its content because of a bad base/rebase.

4. **Re-run tests after rebase, not just a visual diff check:**
   ```bash
   npm test 2>&1 | tail -30
   ```

5. **Push and comment:**
   ```bash
   git push --force-with-lease origin HEAD:$(gh pr view $N --json headRefName -q .headRefName)
   gh pr comment "$N" --body "Rebase only：解決與 main 的衝突，重跑測試 <N>/<N> 通過，沒有功能變更。"
   ```
   Say explicitly "rebase only" so reviewers know not to re-review unrelated lines.

6. If the PR was itself opened with `base` pointing at another not-yet-merged PR's branch (not `main`), don't rebase — re-target the base to `main` first (`gh pr edit "$N" --base main`), then rebase; otherwise a squash-merge of the base PR will make this PR show "merged" while its diff never lands on main.

7. Clean up: `git worktree remove /tmp/claude-conflict-$N --force`.
