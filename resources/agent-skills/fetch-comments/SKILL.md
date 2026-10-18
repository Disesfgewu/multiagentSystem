---
name: fetch-comments
description: Pull the comment/review history for one issue or PR in a single pass, trimmed to what matters (latest state, not every historical comment). Use instead of calling gh view multiple times or re-reading the whole thread with the model each time.
args: "<issue-or-pr-number> [issue|pr]"
---

Default to issue if the type is not given; try issue first, fall back to pr if it is not found.

```bash
N=<number>
# Issue:
gh issue view "$N" --json title,state,labels,body,comments \
  --jq '{title,state,labels:[.labels[].name],last3:[.comments[-3:][] | {at:.createdAt, body:.body[0:400]}]}'
# PR:
gh pr view "$N" --json title,state,headRefOid,comments,reviews \
  --jq '{title,state,head:.headRefOid[0:7],last3comments:[.comments[-3:][] | {at:.createdAt, body:.body[0:400]}], reviews:[.reviews[] | {state,at:.submittedAt,body:.body[0:200]}]}'
```

Report only: current state/labels/head, and the last 3 comments/reviews (not the full history — earlier comments are usually superseded). If the caller needs the full body of one specific comment, fetch that one comment by index, not the whole thread again.

Never re-summarize comments the caller has already seen in this same session unless asked.
