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

### PM 要求補充（#264 審查）

- **接受 `sandbox-exec` 的理由與條件**：Apple 把它標為 deprecated，但目前版本仍可用；判定完全依實測探測，所以它不存在、回錯或行為改變時，得不到「對照組成功＋嘗試被擋」，結果一律是 `unknown`／advisory，不會誤報 enforced（fail closed）。實測版本：macOS 26.6（`sw_vers -productVersion`），Apple Silicon。這只代表在這個版本上跑過，不代表其他版本。
- **網路**：harness 的 `direct-http` 實際嘗試連到允許清單以外的本機埠（假的 GitHub 端點）並被擋，對照組在沙箱外連得上；放行的是另一個本機埠（`cli-own-login` 通道用它證明「被放行的位址仍可連」）。**沒有**證明真 CLI 的登入與 API 呼叫在這種「只放行一個本機埠」的網路下仍可用：真的供應商位址不是固定一個埠，需要本機代理，尚未做（#135）。
- **真實憑證位置**：`credentialLocations(home)` 回傳 `~/.git-credentials`、`~/.config/git/credentials`、`~/.config/gh`、`~/.netrc`、`~/.ssh`、`~/Library/Keychains`，harness 的設定檔都拒絕讀取它們；測試用暫存 HOME 實際驗證每一個在沙箱內讀不到、沙箱外讀得到。**鑰匙圈只是檔案路徑被拒**：透過 Security 服務（mach 服務）取得登入鑰匙圈內容的路徑沒有試，也沒有封。
- **環境變數**：`scrubEnvironment` 另移除 `GIT_CONFIG_PARAMETERS`（git 可由它注入 `credential.helper` 等設定）。
- **對照組沒成功就不是 blocked**：測試以 PATH 不含 `gh` 實測 gh-cli 回 `{ control: false }`，`assessIsolation` 為 `control-did-not-run`，整體 mode 不是 enforced。

## 原生 Windows 平台模組（Refs #26）

`src/isolation/windows.js` 提供 Windows 的積木（受限啟動的請求檢查與回覆解析、環境清除、使用者資料夾的憑證位置清單）；實際啟動由隨 VSIX 出貨的 `resources/isolation/restricted-launch.ps1` 完成，驗證 harness 是**測試程式碼** `test/isolation/windows-harness.js`（與 macOS 相同，不隨套件發佈）。環境清除與 macOS 共用 `src/isolation/environment.js`。

**機制（第一版）**：受限權杖＋Job Object。腳本把目前使用者與 Administrators 兩個 SID 設為 *deny-only*（不能再授予存取），移除除「略過走訪檢查」以外的所有特權，並讓程式在會於逾時或腳本結束時整批結束的 Job Object 內執行。P/Invoke 定義寫死在腳本內；以 `execFile`（不經 shell）執行 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File … -Request <Base64 JSON>`。`-ExecutionPolicy Bypass` 只對這個行程生效；若群組原則強制執行原則，啟動會失敗而回報為 unknown。程式與引數以資料傳入，腳本內以 C 執行階段規則加引號，不經任何 shell 字串；腳本不下載任何東西。

**能擋什麼、不能擋什麼（誠實）**
- 能擋：存取清單只寫了該使用者（加 SYSTEM／Administrators）的檔案與資料夾，例如使用者資料夾下的 `.config\gh`、`.netrc`、`.ssh`、`AppData\Roaming\GitHub CLI`、Credential Manager 的檔案。對 `Users`／`Everyone` 也開放的地方（系統資料夾、程式資料夾）仍可讀，所以程式可以正常啟動。
- **不能擋網路**：權杖不能禁止連線。`git-push`、`gh-cli`、`direct-http` 預期報 `open`，整體因此維持 advisory。要擋網路需要 Windows 防火牆規則或 AppContainer（需要回環豁免，且 AppContainer 與 CLI 登入的相容性未知），列為後續。
- 不涵蓋：Credential Manager 的 API 呼叫（`git-credential-manager` 經 DPAPI 在使用者身分下解密）、真 CLI、真 GitHub 憑證、`terminal-interaction`（harness 沒有 pseudo-console，維持 unknown）。
- harness 的每個 `blocked` 都要求：受限程式能對**開放的資源**做同一類動作（例如能讀 `shared` 內的檔案、能在開放的儲存庫 commit），否則視為受限啟動本身失敗而回報 unknown，不是 blocked。

**驗證環境**：本機開發環境是 macOS，Windows 只由 windows-latest CI 驗證（虛擬機，不能取代乾淨實機；實機項在 #135 T26）。CI 日誌印出受限啟動是否成功、被設為 deny-only 的群組數、每個通道的 `control`／`outcome`。
