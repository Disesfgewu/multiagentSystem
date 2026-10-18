---
name: code-review-on-git
description: Standard PM review procedure for one PR — isolated worktree, real test execution, the five recurring bug classes, the Pass/Needs-changes verdict format, and posting it. Use this instead of re-deriving review steps or review-comment wording from scratch for every PR.
argument-hint: "<PR number>"
---

Run in order. This is a checklist, not a prompt for open-ended exploration — don't read unrelated files.

1. **Never touch the shared/primary checkout** with `git switch`/`checkout`/`pull` — a worker may have it live. Clones don't fetch pull refs by default, so fetch the PR head into a private ref, then isolate:
   ```bash
   N=<PR number>
   gh pr view "$N" --json headRefOid,title,body,additions,deletions -q '{head:.headRefOid[0:7],title,body,additions,deletions}'
   git fetch origin "pull/$N/head:refs/tmp/review-$N"
   git worktree add "/tmp/claude-review-$N" "refs/tmp/review-$N" --detach -q
   cd "/tmp/claude-review-$N" && git rev-parse --short HEAD   # must equal the head above
   npm ci --no-audit --no-fund
   ```

2. **Run the real tests, don't just read code:** `npm test 2>&1 | tail -30`. If the PR touches host/VS-Code-API surface, also run the host suite if it's fast enough locally; otherwise rely on CI for that part and say so.

3. **Check the five recurring bug classes** against the diff: fail-closed on unreadable/malformed state, input validation/injection at trust boundaries (including shell strings built from paths), race conditions on concurrent writes, private-data leakage into public/untrusted paths, and permission/role-boundary bypasses (e.g. an `interactive:false`/consent argument honored outside test mode). For any protection you're unsure is tested, do one mutation check: break it locally, rerun the targeted test, confirm it fails, then revert.

4. **Check scope**: read the linked issue's acceptance criteria (`fetch-comments <issue>`), confirm the PR doesn't silently expand scope, and doesn't contradict the project's documented product direction.

5. **Check CI**: `gh pr checks "$N"`. A Pass requires CI green; if CI is still running, say so and don't guess the outcome.

6. **Post the verdict** — first line is load-bearing, exact format:
   ```
   結論：Pass｜head <sha7>｜CI 全綠（<N> 項）
   ```
   or
   ```
   結論：Needs changes｜<one-line blocking reason>
   ```
   then evidence (test results, mutation checks, scope check, file:line for problems), non-blocking follow-ups, and always the worker's next step (Pass → go straight to the next ready item, don't wait for merge; Needs changes → exactly what to fix).
   ```bash
   gh pr comment "$N" --body "<verdict + evidence + next step>"
   gh pr view "$N" --json comments --jq '.comments[-1].body[0:80]'   # confirm it posted
   ```

7. **Clean up**: `git worktree remove "/tmp/claude-review-$N" --force && git update-ref -d "refs/tmp/review-$N"`.

Never report a subagent's review as your own personal verification — say whose verification it was. A Pass is only valid for the exact head SHA reviewed; a new commit voids it.
