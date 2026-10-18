---
name: fetch-issues
description: Low-token snapshot of open issues (number, labels, title) for the current repository. Use before an issue audit or when deciding what to work on next, instead of re-listing and re-reading issues one by one with free-form reasoning.
---

Run exactly this:

```bash
gh issue list --state open --limit 60 --json number,title,labels,updatedAt \
  --jq 'sort_by(.number) | .[] | "#\(.number)\t[\([.labels[].name] | join(","))]\t\(.title)"'
```

Output the list verbatim. Then partition it into three buckets by label only (no re-reading issue bodies yet). Label names differ per project: if you don't already know them in this session, run `gh label list` once and map them to these meanings using their names and descriptions:
- labels meaning "blocked / waiting" → list as-is, do not investigate further unless the user asks.
- labels meaning "ready to work / high priority" and no existing branch or PR → candidates to pick up (check with `git branch -a | grep "issue-<N>"` and `gh pr list --search "<N>"` per candidate, not per whole list).
- everything else → list as-is.

If the project has no such labels, say so and list everything as one bucket.

Do not open individual issue bodies in this skill. That belongs in `resolve-issues` (for closing/triage) or when a human asks about one specific issue.
