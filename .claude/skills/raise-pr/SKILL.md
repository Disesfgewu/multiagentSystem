---
name: raise-pr
description: Open a PR for this repo with the project's required description shape (user-visible-result-first, Refs, verification evidence) in one pass, instead of re-deriving the format and re-running checks ad hoc each time a worker finishes a slice.
---

Before opening, run once (not per-file):

```bash
git fetch origin --prune
git status --short
npm test 2>&1 | tail -20
```

If tests fail, fix first — do not open the PR planning to fix after; review will bounce it and cost a full round-trip.

This repo has a PR template (`.github/pull_request_template.md`) that `gh pr create` picks up automatically when you omit `--body`. In headless mode, fill the same shape explicitly — first paragraph is mandatory and must answer "what can the user now do on screen" or say plainly "基礎工作，使用者看不到":

```bash
gh pr create --title "<type>(<scope>): <summary> (Refs #<issue>[, #90])" --body "$(cat <<'EOF'
<一段話：使用者現在在畫面上能做到什麼，或明講「基礎工作，使用者看不到」>

Refs #<issue>

### 變更內容
- [重點變更，vertical slice 優先，不要夾帶無關範圍]

### 驗證
- `npm test`：<N>/<N> 通過
- [如有 host test / CI 矩陣，列出結果；沒跑過的就不要寫]

### 未驗證／待外部資源
- [真機、真帳號、原生 Windows 等明講，不要省略]
EOF
)"
```

After creating: do NOT wait idle for review. Immediately use `fetch-issues` to find the next unclaimed `ready`/`mvp` item and start it, per the project's "送出 PR 後不要等 review" convention — unless the human explicitly asked you to stop after one item.
