---
name: respond-to-review
description: Answer a review of your pull request item by item - fix, add a regression test, push, and reply with the new head. Use whenever a review says "Needs changes" or leaves comments on your pull request.
argument-hint: "<PR number>"
---

1. Read the latest review and the comments after your last push (see fetch-comments). List each requested change as one line.
2. For each item, in order:
   - Fix it in your own worktree on the pull request's branch.
   - Add or change a test that fails without the fix. Check that it does: undo the fix, run the test, put the fix back.
   - If you disagree with an item, do not skip it silently: say why in your reply and leave the decision to the reviewer.
3. Run the tests the change touches (see run-tests).
4. Commit, push, and note the new head: `git rev-parse --short HEAD`.
5. Reply on the pull request, signed as your instructions say: one line per item (what changed and which test covers it), the test results with counts, and the new head. Do not mark anything resolved for the reviewer.
