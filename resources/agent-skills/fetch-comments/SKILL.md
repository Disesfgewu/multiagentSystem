---
name: fetch-comments
description: Pull the latest state and comments/reviews for one issue or PR in a single pass, trimmed to what matters. Use instead of calling gh view multiple times or re-reading the whole thread each time.
argument-hint: "<issue-or-pr-number>"
---

`gh issue view` also succeeds on PR numbers (and then omits head SHA and reviews), so try the PR view first and fall back to the issue view only if it fails:

```bash
N=<number>
gh pr view "$N" --json title,state,headRefOid,comments,reviews \
  --jq '{kind:"pr",title,state,head:.headRefOid[0:7],last3comments:[.comments[-3:][] | {at:.createdAt, body:.body[0:400]}], reviews:[.reviews[-5:][] | {state,at:.submittedAt,body:.body[0:200]}]}' 2>/dev/null \
|| gh issue view "$N" --json title,state,labels,comments \
  --jq '{kind:"issue",title,state,labels:[.labels[].name],last3:[.comments[-3:][] | {at:.createdAt, body:.body[0:400]}]}'
```

Report only: kind, current state/labels/head, and the last 3 comments (plus last reviews for PRs). Earlier comments are usually superseded. If the caller needs one full comment, fetch that one by index, not the whole thread.

Never re-summarize comments the caller has already seen in this same session unless asked.
