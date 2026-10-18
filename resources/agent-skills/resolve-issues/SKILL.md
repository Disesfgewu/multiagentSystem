---
name: resolve-issues
description: Strict-evidence issue triage/closure pass — read acceptance criteria, run real tests, close only when every criterion has program+test evidence and none depends on real devices, real accounts, real CLIs, native platforms or external service setup. Use this instead of re-deriving the closure standard from scratch each round.
args: "<issue number(s)>"
---

For each issue number given:

1. **Read once, fully:**
   ```bash
   gh issue view "$N" --json body,comments,labels,title
   ```
   Note every acceptance-criterion line and whether a prior comment already covers it — don't re-verify something a previous round already proved with evidence, unless the head/commit changed since.

2. **Find and actually run the corresponding tests** on the current default branch (in an isolated worktree, not the shared checkout), using the project's own test command:
   ```bash
   BASE=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
   git fetch origin --prune
   WT="$(mktemp -d)/resolve-$N"
   git worktree add "$WT" "origin/$BASE" --detach -q
   cd "$WT" && <project test command> 2>&1 | tail -30
   ```
   Reading the code is not enough — run it.

3. **Apply the strict standard**:
   - Close only if every acceptance criterion has program+test evidence AND none depends on a real device / real account / real CLI / native platform / external service configuration.
   - If even one criterion needs those, do not close. Comment "程式完成待外部資源" with what's done and what's missing, citing file paths and test names — don't write a vague "done".
   - If the issue's scope has grown under added requirements but the original acceptance is actually met, don't silently close or split it yourself — report it back for a human decision on how to split (for example a tracking issue for the external/manual part, closing the original once its real scope is met).

4. **Close with evidence, never with a bare "done":**
   ```bash
   gh issue comment "$N" --body "<具體證據：檔案路徑、測試檔名稱、測試結果數字、對應 PR 編號>"
   gh issue close "$N" --reason completed
   ```

5. **Check for collisions**: before acting, check the last 2-3 comments for signs another agent or person already processed this issue in the same cycle — don't duplicate or contradict a decision made minutes ago.

6. Clean up the worktree: `git worktree remove "$WT" --force`.

Never close to make a count go down. When in doubt, leave it open and say why.
