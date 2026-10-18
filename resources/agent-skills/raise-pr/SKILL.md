---
name: raise-pr
description: Open a pull request for the current repository with a consistent description shape (user-visible result first, issue reference, verification evidence) in one pass, instead of re-deriving the format and re-running checks ad hoc each time a slice of work is finished.
---

Before opening, run once (not per-file), using the project's own test command (README, `package.json` scripts, `Makefile`, CI workflow):

```bash
git fetch origin --prune
git status --short
<project test command> 2>&1 | tail -20
```

If tests fail, fix first — do not open the PR planning to fix after; review will bounce it and cost a full round-trip.

If the project has a PR template (`.github/pull_request_template.md`), `gh pr create` picks it up automatically when you omit `--body`. In headless mode, fill the same shape explicitly — the first paragraph is mandatory and must answer "what can the user now do on screen" or say plainly "基礎工作，使用者看不到". Follow the project's own title convention if it has one (check `git log --oneline -20`):

```bash
gh pr create --title "<type>(<scope>): <summary> (Refs #<issue>)" --body "$(cat <<'EOF'
<一段話：使用者現在在畫面上能做到什麼，或明講「基礎工作，使用者看不到」>

### 變更內容
- [重點變更，vertical slice 優先，不要夾帶無關範圍]

### 驗證
- 測試：<N>/<N> 通過
- [如有整合測試 / CI 矩陣，列出結果；沒跑過的就不要寫]

### 未驗證 / 待外部資源
- [真機、真帳號、原生平台等明講，不要省略]
EOF
)"
```

After creating: unless the human asked you to stop after one item, don't wait idle for review — use `fetch-issues` to find the next unclaimed item and start it, if the project's own instructions allow that.
