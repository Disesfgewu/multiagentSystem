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

## macOS 平台模組（Refs #25）

`src/isolation/macos.js` 提供 macOS 的積木（Seatbelt 設定檔產生器、環境憑證清除）；實際去試每條旁路的驗證 harness 是**測試程式碼** `test/isolation/macos-harness.js`（`createMacosModule()` 搭配 `collectProbes` 與 `assessIsolation`，測試見 `test/isolation/macos.test.js`）。harness 不隨擴充套件發佈：它的合成憑證與信箱正是發佈掃描必須擋下的形狀，所以不放進 `src/`。因此目前**擴充套件執行時無法自行跑這個驗證**；要在執行時使用，需要另外決定怎麼產生探測夾具。

**機制**：Seatbelt，透過 `/usr/bin/sandbox-exec`。Apple 把這個指令標為 deprecated；它是系統提供的「在設定檔下執行一個程序」的方式，不是長期承諾。設定檔由 `seatbeltProfile` 產生：預設全允許，但**一律拒絕網路**（只放行指定的本機埠）、拒絕讀取指定路徑、拒絕寫入指定路徑。路徑與埠不合格（相對路徑、含引號／括號／反斜線／控制字元／雙向字元、不是整數埠）直接丟錯，不會產生比呼叫端要求更開放的設定檔。

**怎麼判定**：每個通道在**本機**用合成憑證與本機假端點真的試一次，看觀察到的事實，不看結束碼——假端點是否收到連線、合成秘密是否出現在輸出、commit 是否真的多了一筆。每個嘗試各跑兩次：隔離內，以及隔離外的對照組；對照組沒成功（例如沒裝 `gh`、沒有 Python）該通道就是 `unknown`，絕不是 `blocked`。終端互動以 Python `pty` 提供真的 pseudo-terminal，輸入一行、檢查回應、送 Ctrl-C 看程式是否結束。

**已知邊界（沒有試、也不宣稱）**
- Seatbelt 只能依位址與埠過濾網路，不能依主機名稱。「允許 CLI 連自己的供應商、擋 GitHub」需要本機過濾代理，這裡**沒有**做；本模組只證明「只放行一個本機埠、其餘全拒」。真 CLI 是否肯走代理、登入是否仍可用，要實機驗證（#135）。
- 沒有測系統鑰匙圈（`osxkeychain` helper）、真的 GitHub 憑證、真的遠端、SSH、真的 CLI。`credential-helper` 通道只證明「檔案型 helper 讀不到被拒絕的目錄」。
- 環境憑證由 `scrubEnvironment` 移除（`GH_*`／`GITHUB_*` 含 TOKEN／KEY／SECRET／PASSWORD／CREDENTIAL 的變數、`GIT_ASKPASS`、`SSH_ASKPASS`、`SSH_AUTH_SOCK`、注入的 git config）；這不是 Seatbelt 的功能，而是啟動端的責任，尚未接進實際的 terminal 啟動流程。
- 這個模組還沒有接到任何命令或 terminal 啟動：現在使用者看不到任何變化。
