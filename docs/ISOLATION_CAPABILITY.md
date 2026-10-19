# 受管隔離的能力判定（macOS #25／原生 Windows #26 共用介面）

對應 Issue #25、#26（本文件隨 PR 以 `Refs #25、#26` 交付，兩張 Issue 保持開放）與 `docs/IMPLEMENTATION_PLAN.md` 的 R08。實作位於 `src/isolation/capabilities.js`。

**這個模組不隔離任何東西。** 它只決定「可以說什麼」與「可以啟動什麼」，依據是各平台模組真的去嘗試每一條旁路後留下的證據。VS Code 擴充套件無法單獨隔離任意 shell 的 GitHub 憑證與網路；真正的隔離機制（macOS 沙箱、Windows 程序／憑證隔離等）由各平台自己的模組與驗證 harness 提供，且沒有實機證據前不得宣稱已封閉（真機證據集中在 #135）。

## 通道

九個通道，前七個是旁路（結果只有 `blocked`／`open`），後兩個是必須維持可用的互動（結果只有 `works`／`broken`）：

`git-commit`、`git-push`、`gh-cli`、`credential-helper`、`direct-http`、`env-credentials`、`file-credentials`、`terminal-interaction`、`cli-own-login`。

## 什麼才算「已強制」

單一通道只有在下列全部成立時才是 `enforced`：這一輪有探測紀錄、**對照組有跑**（同一個探測方法在隔離之外確實能成功，所以「被擋」不是因為探測本身根本跑不起來）、時間有效（不是未來、不超過有效期，預設 24 小時）、結果是該通道種類認得的那個字。缺任何一項、格式錯誤、逾時、丟例外、被中止，一律是 `unknown`；`unknown` 不比 `open` 好。旁路成功的是 `open`。

整體只有在**每個通道**都 `enforced` 且平台是 macOS 或 Windows 時才是 `enforced` 模式，否則是 `advisory`（建議／檢查模式）。互動壞了也不是 `enforced`：若無法兼顧互動與隔離，就限制為建議模式。

## 啟動

`decideLaunch({ assessment, requested })`：要求 `advisory` 一律允許並明說只是建議；要求 `enforced` 只有在整體 `enforced` 時才允許，**否則拒絕並列出原因，絕不悄悄降級成建議模式**。輸入不合格同樣拒絕。

## 平台模組的契約

平台模組提供 `{ platform, probe(channel, { signal }) }`；`probe` 回傳 `{ outcome, control, observedAt? }`。`collectProbes` 逐一詢問九個通道，單一探測丟例外、逾時（預設 15 秒）、被中止或回傳非物件時，該通道視為沒探測（`unknown`），不丟例外、不阻塞其他通道。macOS 與 Windows 各自實作自己的 `probe`，不互改對方的模組。

## 尚未驗證

這份介面只有合成資料的單元測試。沒有任何平台模組、沒有真機證據、沒有真 CLI；`broker` 不能阻止 agent 自己執行 `git`／`gh`／HTTP 這件事（見 `docs/WRITE_BROKER.md`）也沒有因此改變。
