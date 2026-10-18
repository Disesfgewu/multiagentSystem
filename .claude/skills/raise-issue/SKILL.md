---
name: raise-issue
description: Create a well-formed GitHub issue for this repo in one shot, using the project's standard template and labels, instead of free-composing issue structure from scratch each time.
argument-hint: "<one-line problem statement>"
---

Before creating, check for a near-duplicate in one call (don't open issues one by one to check):

```bash
gh issue list --state all --search "<keywords> in:title,body" --limit 10 --json number,title,state
```

If a clear duplicate exists, stop and report its number instead of creating a new one.

This repo has a GitHub issue template (`.github/ISSUE_TEMPLATE/standard.md`) — use `gh issue create` without `--body` to get the interactive template picker when running interactively, or fill the same sections explicitly in headless mode:

```bash
gh issue create --title "<type>: <one-line>" --label <valid-labels-only> --body "$(cat <<'EOF'
## 背景
[為什麼開這張；是誰發現的、什麼情境下發現]

## 現況
[具體程式位置與行為（file:line），必要時貼關鍵片段；不要憑印象]

## 驗收
[每一條都要能用程式/測試驗證；依賴真機/真帳號/原生 Windows/外部 GitHub 設定的項目要明講，不要混在可程式驗證的條件裡]

## 建議修法
[最小修正方向，不要順便擴張範圍]
EOF
)"
```

Labels: check `gh label list` once if unsure — never pass a label that doesn't exist (gh fails with an error and creates nothing). Do not mark `ready` yourself unless you have already confirmed no blocking dependency — that label drives other agents' claim behavior.
