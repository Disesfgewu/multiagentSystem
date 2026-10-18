---
name: resolve-issues
description: Strict-evidence issue triage/closure pass — read acceptance criteria, run real tests, close only when every criterion has program+test evidence and none depends on real devices/real accounts/real CLI/native Windows/external GitHub setup. Use this instead of re-deriving the closure standard each round.
argument-hint: "<issue number(s)>"
---

For each issue number:

1. **Check for collisions first:** read the last 2–3 comments; if another agent/PM already processed this issue in the current cycle, don't duplicate or contradict that decision.

2. **Read once, fully:** `gh issue view "$N" --json body,comments,labels,title`. Note every acceptance criterion and whether an earlier comment already proved it with evidence — don't re-verify unless main changed since.

3. **Run the corresponding tests on current main, in an isolated worktree** (not the shared checkout):
   ```bash
   git fetch origin --prune
   git worktree add "/tmp/claude-resolve-$N" origin/main --detach -q
   cd "/tmp/claude-resolve-$N" && npm ci --no-audit --no-fund && npm test 2>&1 | tail -30
   ```
   Reading the code is not enough — run it.

4. **Apply the strict standard:**
   - Close only if every criterion has program+test evidence AND none depends on a real device / real account / real CLI / native Windows / external GitHub configuration.
   - Otherwise don't close; comment `程式完成待外部資源` with what's done and what's missing, citing file paths and test names.
   - If the issue grew stuck under added scope but its original acceptance is met, report it for a PM/human split decision rather than closing or splitting silently.
   - If a higher-level decision cancelled the scope, close with `--reason "not planned"` and say why.

5. **Comment with evidence first, then close** — never a bare "done":
   ```bash
   gh issue comment "$N" --body "<檔案路徑、測試檔名稱、測試結果數字、對應 PR 編號與 head>"
   gh issue close "$N" --reason completed
   ```

6. Clean up: `git worktree remove "/tmp/claude-resolve-$N" --force`.

Never close to make a count go down. When in doubt, leave it open and say why.
