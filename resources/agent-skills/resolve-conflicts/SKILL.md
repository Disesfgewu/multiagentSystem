---
name: resolve-conflicts
description: Rebase a pull request whose sibling merged first (or that was stacked on an unmerged branch) without losing anyone's commits. Use instead of re-deriving the rebase steps each time two PRs collide. Normally the PR author runs this; a reviewer should ask the author rather than resolve and merge their own resolution.
argument-hint: "<PR number>"
---

1. **Confirm it's a real conflict:**
   ```bash
   N=<PR number>
   gh pr view "$N" --json mergeable,mergeStateStatus,baseRefName,headRefName,headRefOid,isCrossRepository
   BASE=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
   ```
   `CONFLICTING` is authoritative; `UNKNOWN` means GitHub hasn't computed it yet — wait and re-check rather than acting.

2. **If `baseRefName` is not the default branch** (the PR was stacked on another unmerged branch), retarget first, before any rebase — otherwise a squash-merge of the base PR makes this PR show "merged" while its diff never lands:
   ```bash
   gh pr edit "$N" --base "$BASE"
   ```

3. **If `isCrossRepository` is true** (the PR comes from a fork), its branch is not on `origin`, so the steps below don't apply. Either ask the author to rebase, or check it out with `gh pr checkout "$N"` inside a fresh temporary worktree and push only if the author allowed maintainer edits.

4. **Work from the remote branch, not a possibly stale local one, in an isolated worktree:**
   ```bash
   BR=$(gh pr view "$N" --json headRefName -q .headRefName)
   git fetch origin --prune
   EXPECTED=$(git rev-parse "origin/$BR")          # the head you are about to rewrite
   WT="$(mktemp -d)/conflict-$N"
   git worktree add "$WT" "origin/$BR" --detach -q
   cd "$WT"
   git rebase "origin/$BASE"
   ```

5. **Resolve keep-both** unless one side is clearly dead code: when both sides added real functionality in the same region, keep both and check they compose (shared exports, lists, docs tables). Don't silently drop a sibling's finished work.

6. **Re-run tests after rebase**, using the project's own install and test commands (README, `package.json` scripts, `Makefile`, CI workflow):
   ```bash
   <project test command> 2>&1 | tail -30
   ```

7. **Push only if nobody pushed meanwhile** — pin the lease to the SHA recorded in step 4 so newer author commits are never overwritten:
   ```bash
   git push --force-with-lease="$BR:$EXPECTED" origin "HEAD:$BR"
   gh pr comment "$N" --body "rebase only：解決與 $BASE 的衝突，重跑測試 <N>/<N> 通過，沒有功能變更。"
   ```
   If the push is rejected, someone pushed after step 4: start over from step 4.

8. Clean up: `git worktree remove "$WT" --force`.
