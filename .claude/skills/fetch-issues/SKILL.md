---
name: fetch-issues
description: Low-token snapshot of open issues (number, labels, title, last activity) for this repo. Use before an issue audit or when deciding what to assign, instead of re-listing and re-reading issues one by one with free-form reasoning.
---

Run exactly this:

```bash
gh issue list --state open --limit 60 --json number,title,labels,updatedAt \
  --jq 'sort_by(.number) | .[] | "#\(.number)\t[\([.labels[].name] | join(","))]\t\(.title)"'
```

Output the list verbatim. Then partition it into three buckets by label only (no re-reading issue bodies yet):
- `blocked` label → list as-is, do not investigate further unless the user asks.
- `ready`/`mvp`/`priority` and no recent branch/PR → candidates to assign (check per candidate with `git branch -a | grep -E "issue-<N>([^0-9]|$)"` so issue-1 does not match issue-11).
- everything else → list as-is.

Do not open individual issue bodies in this skill. That belongs in `resolve-issues` (for closing/triage) or when a human asks about one specific issue.
