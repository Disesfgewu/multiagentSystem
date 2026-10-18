---
name: resolve-conflicts
description: Rebase a pull request whose sibling merged first (stacked PR on an unmerged branch, or a plain merge conflict with the default branch) without burning a full review round-trip. Use instead of re-deriving the rebase steps from scratch each time two PRs collide.
args: "<PR number>"
---

1. **Confirm it's a real conflict, not a stale UI cache:**
   ```bash
   N=<PR number>
   gh pr view "$N" --json mergeable,mergeStateStatus,baseRefName,headRefName
   BASE=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
   ```
   `mergeable: CONFLICTING` is authoritative; `UNKNOWN` means GitHub hasn't computed it yet, re-check in a minute rather than acting on it.

2. **Isolate, don't touch the shared checkout:**
   ```bash
   git fetch origin --prune
   HEAD_BRANCH=$(gh pr view "$N" --json headRefName -q .headRefName)
   WT="$(mktemp -d)/conflict-$N"
   git worktree add "$WT" "origin/$HEAD_BRANCH" -q
   cd "$WT"
   git rebase "origin/$BASE"
   ```

3. **Resolve conflicts keep-both unless one side is clearly dead code**: when both sides added real functionality in the same region, keep both and re-check they compose correctly. Don't silently drop a sibling's finished work — a bad base or rebase is a common way for a dependent PR to lose content.

4. **Re-run tests after rebase, not just a visual diff check** (use the project's own test command):
   ```bash
   <project test command> 2>&1 | tail -30
   ```

5. **Push and comment:**
   ```bash
   git push --force-with-lease origin "HEAD:$HEAD_BRANCH"
   gh pr comment "$N" --body "Rebase only：解決與 $BASE 的衝突，重跑測試 <N>/<N> 通過，沒有功能變更。"
   ```
   Say explicitly "rebase only" so reviewers know not to re-review unrelated lines.

6. If the PR was itself opened with its base pointing at another not-yet-merged PR's branch (not the default branch), don't rebase — re-target the base first (`gh pr edit "$N" --base "$BASE"`), then rebase; otherwise a squash-merge of the base PR will make this PR show "merged" while its diff never lands on the default branch.

7. Clean up: `git worktree remove "$WT" --force`.
