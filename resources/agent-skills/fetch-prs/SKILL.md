---
name: fetch-prs
description: Low-token snapshot of pull request state (open PRs, heads, recent merges) for the current repository. Use at the start of a review/maintenance pass or before deciding what to review or merge, instead of re-deriving this with ad-hoc gh calls and reasoning each time.
---

Run exactly this, no extra exploration:

```bash
git fetch origin --prune
gh pr list --state open --limit 20 --json number,title,headRefOid,isDraft,updatedAt \
  --jq '.[] | "#\(.number)\t\(.headRefOid[0:7])\t\(.title)"'
gh pr list --state merged --limit 8 --json number,title,headRefOid,mergedAt \
  --jq '.[] | "#\(.number)\t\(.headRefOid[0:7])\t\(.mergedAt)\t\(.title)"'
```

Output the two lists verbatim (open PRs, then recently merged). Do not summarize, editorialize, or re-fetch per-PR detail here — that belongs in `code-review-on-git`. If the open list is empty, say "no open pull requests" and stop; do not speculate about why.

If you need CI status for a specific PR, run `gh pr checks <N>` only for that PR, not for the whole list.
