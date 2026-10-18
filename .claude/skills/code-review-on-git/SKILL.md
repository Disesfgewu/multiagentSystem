---
name: code-review-on-git
description: Standard PM review procedure for one PR in this repo — isolated worktree, real test execution, the five recurring bug classes, the Pass/Needs-changes verdict format, and posting it. Use this instead of re-deriving review steps or review-comment wording from scratch for every PR.
args: "<PR number>"
---

Run in order. This is a checklist, not a prompt for open-ended exploration — don't read unrelated files.

1. **Never touch the shared/primary checkout** with `git switch`/`checkout`/`pull` — a worker may have it live. Isolate instead:
   ```bash
   N=<PR number>
   gh pr view "$N" --json headRefOid,title,body,additions,deletions -q '{head:.headRefOid[0:7],title,body,additions,deletions}'
   git worktree add /tmp/claude-review-$N "refs/pull/$N/head" --detach -q
   cd /tmp/claude-review-$N
   ```

2. **Run the real tests, don't just read code:**
   ```bash
   npm test 2>&1 | tail -30
   ```
   If the PR touches host/VS-Code-API surface, also run the host test suite if one exists and is fast enough locally; otherwise rely on CI for that part and say so.

3. **Check the five recurring bug classes** against the diff: fail-closed on unreadable/malformed state, input validation/injection at trust boundaries, race conditions on concurrent writes, private-data leakage into public/untrusted paths, and permission/role-boundary bypasses. For any protection you're unsure is tested, do one mutation check: comment it out locally, rerun the targeted test, confirm it fails — then revert.

4. **Check scope**: read the linked issue's acceptance criteria (`fetch-comments <issue> issue`), confirm the PR doesn't silently expand scope beyond its slice, and confirm it doesn't contradict the project's documented product direction if such a file exists.

5. **Check CI**: `gh pr checks "$N"`. A Pass requires CI green; if CI is still running, say so and don't guess the outcome.

6. **Post the verdict** — first line is load-bearing, exact format:
   ```
   結論：Pass｜head <sha7>｜CI 全綠（<N> 項）
   ```
   or
   ```
   結論：Needs changes｜<one-line blocking reason>
   ```
   followed by the evidence (test results, mutation check results, scope check) and, always, the next-step line for the worker:
   - Pass → "Pass，請直接去做下一個 ready/mvp 項目，不用等 merge。"
   - Needs changes → the exact one or two things to fix.

   ```bash
   gh pr comment "$N" --body "<verdict + evidence + next step>"
   gh pr view "$N" --json comments --jq '.comments[-1].body[0:80]'   # confirm it posted
   ```

7. **Clean up**: `git worktree remove /tmp/claude-review-$N --force`.

Never report a fork/subagent's review as your own personal verification — say whose verification it was. A Pass is only valid for the exact head SHA reviewed; a new commit voids it.
