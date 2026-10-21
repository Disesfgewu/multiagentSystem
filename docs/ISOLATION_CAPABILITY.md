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

`src/isolation/macos.js` 提供 macOS 的積木（Seatbelt 設定檔產生器、環境憑證清除）；實際去試每條旁路的驗證 harness 是 `src/isolation/macos-harness.js`（`createMacosModule()` 搭配 `collectProbes` 與 `assessIsolation`，測試見 `test/isolation/macos.test.js`）。harness **隨擴充套件發佈**（PM 於 #25 決定）：它的夾具不再是憑證的形狀（沒有 token／password 欄位、沒有信箱），所以能通過發佈掃描；它只在使用者**明確選擇強制隔離**時才會執行，暫存資料放在呼叫端**必須**指定的資料夾（`tmpRoot` 沒傳就丟錯；啟動流程接上時會是擴充套件的私有儲存區）下新建的專屬目錄，建立到一半失敗或 `dispose()` 時都會清掉（含測試鑰匙圈，某一步失敗不會跳過後面的清理），結果只記錄通道與結果（不含路徑或帳號）。鑰匙圈探測用一個暫存的測試鑰匙圈，不碰使用者的鑰匙圈。每次探測前先做 `selfCheck()`：嘗試時的 HOME 必須是夾具資料夾（沙箱內外皆是），且 git 不得列出任何 credential helper（Apple 的 git 在系統設定檔裡就有 osxkeychain，所以嘗試時設 `GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`，並先清空 helper 清單再加 store）；不符就回報控制組失敗（unknown），不執行探測。目前**尚未接上啟動流程**（下一個 PR）。

**機制**：Seatbelt，透過 `/usr/bin/sandbox-exec`。Apple 把這個指令標為 deprecated；它是系統提供的「在設定檔下執行一個程序」的方式，不是長期承諾。設定檔由 `seatbeltProfile` 產生：預設全允許，但**一律拒絕網路**（只放行指定的本機埠）、拒絕讀取指定路徑、拒絕寫入指定路徑。路徑與埠不合格（相對路徑、含引號／括號／反斜線／控制字元／雙向字元、不是整數埠）直接丟錯，不會產生比呼叫端要求更開放的設定檔。

**怎麼判定**：每個通道在**本機**用合成憑證與本機假端點真的試一次，看觀察到的事實，不看結束碼——假端點是否收到連線、合成秘密是否出現在輸出、commit 是否真的多了一筆。每個嘗試各跑兩次：隔離內，以及隔離外的對照組；對照組沒成功（例如沒裝 `gh`、沒有 Python）該通道就是 `unknown`，絕不是 `blocked`。終端互動以 Python `pty` 提供真的 pseudo-terminal，輸入一行、檢查回應、送 Ctrl-C 看程式是否結束。

**已知邊界（沒有試、也不宣稱）**
- Seatbelt 只能依位址與埠過濾網路，不能依主機名稱。「允許 CLI 連自己的供應商、擋 GitHub」需要本機過濾代理，這裡**沒有**做；本模組只證明「只放行一個本機埠、其餘全拒」。真 CLI 是否肯走代理、登入是否仍可用，要實機驗證（#135）。
- 沒有測真的 `git-credential-osxkeychain`、真的 GitHub 憑證、真的遠端、SSH、真的 CLI。`credential-helper` 通道證明「檔案型 helper 讀不到被拒絕的目錄」與「`security` 讀不到暫存測試鑰匙圈的項目（Security 服務被拒）」。
- 環境憑證由 `scrubEnvironment` 移除（`GH_*`／`GITHUB_*` 含 TOKEN／KEY／SECRET／PASSWORD／CREDENTIAL 的變數、`GIT_ASKPASS`、`SSH_ASKPASS`、`SSH_AUTH_SOCK`、注入的 git config）；這不是 Seatbelt 的功能，而是啟動端的責任，尚未接進實際的 terminal 啟動流程。
- 這個模組還沒有接到任何命令或 terminal 啟動：現在使用者看不到任何變化。

### PM 要求補充（#264 審查）

- **接受 `sandbox-exec` 的理由與條件**：Apple 把它標為 deprecated，但目前版本仍可用；判定完全依實測探測，所以它不存在、回錯或行為改變時，得不到「對照組成功＋嘗試被擋」，結果一律是 `unknown`／advisory，不會誤報 enforced（fail closed）。實測版本：macOS 26.6（`sw_vers -productVersion`），Apple Silicon。這只代表在這個版本上跑過，不代表其他版本。
- **網路**：harness 的 `direct-http` 實際嘗試連到允許清單以外的本機埠（假的 GitHub 端點）並被擋，對照組在沙箱外連得上；放行的是另一個本機埠（`cli-own-login` 通道用它證明「被放行的位址仍可連」）。**沒有**證明真 CLI 的登入與 API 呼叫在這種「只放行一個本機埠」的網路下仍可用：真的供應商位址不是固定一個埠，需要本機代理，尚未做（#135）。
- **真實憑證位置**：`credentialLocations(home)` 回傳 `~/.git-credentials`、`~/.config/git/credentials`、`~/.config/gh`、`~/.netrc`、`~/.ssh`、`~/Library/Keychains`，harness 的設定檔都拒絕讀取它們；測試用暫存 HOME 實際驗證每一個在沙箱內讀不到、沙箱外讀得到。**鑰匙圈**：除了拒絕 `~/Library/Keychains` 的檔案讀取，profile 也拒絕 `mach-lookup com.apple.SecurityServer`（`git-credential-osxkeychain` 與 `security` 取鑰匙圈內容走的服務）。harness 以一個暫存的測試鑰匙圈（合成密碼，絕不碰使用者的鑰匙圈）實測：不受限讀得到、沙箱內讀不到、拿掉這條規則就讀得到（測試保證是這條規則在擋）。仍未試：不經這個服務取得憑證的其他途徑，以及真的 `git-credential-osxkeychain`。
- **環境變數**：`scrubEnvironment` 另移除 `GIT_CONFIG_PARAMETERS`（git 可由它注入 `credential.helper` 等設定）。
- **對照組沒成功就不是 blocked**：測試以 PATH 不含 `gh` 實測 gh-cli 回 `{ control: false }`，`assessIsolation` 為 `control-did-not-run`，整體 mode 不是 enforced。

## 原生 Windows 平台模組（Refs #26）

`src/isolation/windows.js` 提供 Windows 的積木（受限啟動的請求檢查與回覆解析、環境清除、使用者資料夾的憑證位置清單）；實際啟動由隨 VSIX 出貨的 `resources/isolation/restricted-launch.ps1` 完成，驗證 harness 是**測試程式碼** `test/isolation/windows-harness.js`（與 macOS 相同，不隨套件發佈）。環境清除與 macOS 共用 `src/isolation/environment.js`。

**機制（第一版）**：受限權杖＋Job Object。腳本把目前使用者的 SID 設為 *deny-only*（不能再授予存取），移除除「略過走訪檢查」以外的所有特權，並讓程式在逾時或腳本結束會整批結束的 Job Object 內執行；把權杖的預設存取清單與權杖物件本身的存取清單改為登入階段（沒有就用 Everyone）與 SYSTEM，否則程式連自己建立的物件都用不了。P/Invoke 定義寫死在腳本內；以 `execFile`（不經 shell）執行 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File … -Request <Base64 JSON>`。`-ExecutionPolicy Bypass` 只對這個行程生效；若群組原則強制執行原則，啟動會失敗而回報為 unknown。程式與引數以資料傳入，腳本內以 C 執行階段規則加引號，不經任何 shell 字串；腳本不下載任何東西。回覆另外帶 `elevated`：呼叫者的權杖是否已提升權限。

**windows-latest CI 實測（run 39436977571，`caller elevated=true`）**
- 預設設定：git-commit／git-push／gh-cli／credential-helper／direct-http／file-credentials 全部報 `open`，只有 env-credentials 是 `blocked`、cli-own-login 是 `works`、terminal-interaction 是 `unknown`；整體 advisory。
- **原因寫明（不是 bug）**：CI 的 runner 是**已提升權限的管理員**，權杖內 Administrators 群組是啟用的，而真實使用者資料夾的存取清單有 `使用者＋SYSTEM＋Administrators`（harness 的憑證資料夾照這個 ACL 建立），所以只讓使用者 SID 變成 deny-only 擋不住。**這個機制擋不了已提升權限的管理員 session**；一般（含 UAC 過濾後的管理員）session 的權杖中 Administrators 本來就是 deny-only，才有保護。未提升的 session 由實機驗證（#135 T26）。
- 同時讓 Administrators 也 deny-only：檔案類通道會被擋（先前的 run 中 file-credentials／git-commit 報 `blocked`，且每個都有「受限程式能對開放資源做同一類動作」的對照），**但是**程式無法連到自己建立的具名管線（`CreateFile` 對自己的 pipe 回 EPERM：Node 的 `child_process` 以管線啟動子程序就失敗，匿名管線與 `cmd` 管線沒問題；用 restricting SIDs 也一樣）。這會讓 Claude Code／Codex 這類 Node 程式無法開子程序，所以**預設不啟用**；原因尚未查清（預設存取清單與權杖物件的存取清單都已改過仍不行），是後續工作。
- 受限程式能正常啟動、git 與 gh 能運作；`git push`／`gh`／HTTP 一律 `open`（權杖不能擋網路）。

**驗證環境**：本機開發環境是 macOS，Windows 只由 windows-latest CI 驗證（虛擬機，不能取代乾淨實機；實機項在 #135 T26）。CI 日誌印出受限啟動是否成功、被設為 deny-only 的群組數、每個通道的 `control`／`outcome`。

## 本機過濾代理（#25／#26，尚未接到任何啟動路徑）

`src/isolation/filter-proxy.js`：沙箱 profile 只能依位址／埠過濾網路，所以 agent CLI 要連自己的供應商、但不能連 GitHub，必須經過一個依**主機名稱**決定的本機代理。profile 之後只放行這個代理的一個本機埠，CLI 以 `HTTPS_PROXY` 指向它；不走代理的程式連不出去。

每個請求依序檢查，任何一步失敗就拒絕（只回短狀態碼，不解釋規則）：(1) 必須帶這個代理自己的隨機憑證（每個代理不同，`http://managed:<憑證>@127.0.0.1:<埠>`）；(2) 只服務 `CONNECT`，一般 HTTP 一律 405；(3) 主機必須是純 DNS 名稱（IP 字面值與各種數字寫法都不是名稱），埠必須在允許清單（預設只有 443）；(4) **拒絕清單優先**：GitHub 與它供應檔案的網域（`github.com`、`githubusercontent.com`、`ghcr.io`、`github.io`…）即使也在允許清單內也拒絕；(5) 必須符合允許清單（完全相符或 `*.example.com` 的子網域，不含本身）；(6) 代理自己解析名稱，所有位址都必須是公開位址（拒絕 loopback、私有、link-local／雲端 metadata、共享位址空間、多播、保留、文件用位址與包在 IPv6 內的私有 IPv4），**並且連到檢查過的那個位址**，不再做第二次解析。之後只複製位元組；不看隧道內容（TLS）；不記錄主機名稱，只有計數。

邊界：代理不知道 CLI 對允許的主機送了什麼；不能阻止忽略代理設定的程式（那是沙箱 profile 只放行代理埠要做的事）；允許清單決定它有多好，而各供應商需要哪些網域、真 CLI 是否肯走代理屬 #135 實機。預設的真實 DNS 解析與 TCP 連線沒有自動化測試（私有位址檢查使得無法在測試中連到本機）；測試以可注入的 `lookup`／`connect` 取代。

## 啟動路徑：enforced 模式（macOS，#25，使用者明確選用）

預設永遠是 **advisory**：啟動行為與以前完全相同。只有使用者在**自己的使用者設定**（不是工作區設定，工作區的值一律忽略）把 `multiagentSystem.isolation.mode` 設為 `enforced`，才會走這條路，且需要 `multiagentSystem.isolation.allowedDomains`（允許 CLI 連線的主機名稱；空的就拒絕啟動；GitHub 主機一律在拒絕清單且優先，即使寫進去也不通）。

每次啟動（`src/isolation/enforcedStart.ts`、`enforced-launch.js`）依序：(1) 模式不是 `advisory`／`enforced`（例如打錯字）→ 拒絕，不當成 advisory 默默啟動；(2) 沒有擴充套件私人儲存區、不是 macOS、沒有允許網域 → 拒絕；(3) 在私人儲存區下建專屬目錄，**實際**跑 harness 的每一條通道（含 `selfCheck`），任何通道是 unknown、open、對照組失敗、探測丟錯或逾時 → 拒絕並列出原因（只有通道名稱與短代碼，不含路徑或帳號）；(4) 起這次啟動專用的代理（只聽 127.0.0.1、每次新的隨機憑證），沒起來或位址不是 127.0.0.1 → 拒絕；(5) 寫 `0600` 的 profile（拒絕讀取憑證位置與 keychain 服務，網路只放行代理埠）；(6) 畫面顯示「已證明什麼、**未驗證什麼**（真實 CLI 是否肯走代理、需要哪些網域，#135）」，使用者按「Start」才繼續；(7) 終端機輸入的指令是 `/usr/bin/sandbox-exec -f <profile> <CLI> <含模型與指示的最終參數>`，環境加上 `HTTPS_PROXY` 等。任何一步失敗都**不啟動**，也不退回無隔離的啟動；已建立的東西（代理、profile、夾具資料夾、測試鑰匙圈）在失敗、取消、工作階段結束或終端機關閉時都清掉。

**探測用的設定就是啟動用的設定**：沙箱由同一個函式 `isolationSpec` 產生（harness 探測與實際啟動都呼叫它）；啟動時額外加上該資料夾的 git 目錄寫入拒絕（`gitDirectoriesFor`：`.git` 目錄，或 linked worktree 的 `.git` 檔案、它指向的 git 目錄與 common 目錄；讀不懂的 `.git` 檔案就不啟動）。實測：實際輸入的指令在一般資料夾與 linked worktree 都無法 commit。環境：終端機環境把 `scrubEnvironment` 會移除的變數設為 null，並在指令前加 `/usr/bin/env -u …`（連 shell 啟動檔匯出的 `GH_TOKEN` 等也移除）；已知限制：shell 啟動檔用**新的、未知名稱**匯出的 token 無法事先列舉，這一點未涵蓋（#135）。**reopen 與 start 走同一條路**（總覽的 Reopen 也會探測、包裝、確認，失敗就不開），有測試鎖住兩個入口都必須經過判斷並傳入包裝。

只有 Extension Host 測試（`interactive: false`）能代替使用者跳過確認，一般安裝的擴充套件會強制互動。沒有啟動 CLI 的純 shell（`launch: false`）不探測、不包裝。**範圍**：enforced 只涵蓋 session 的 start 與 reopen。「Start Custom Provider Terminal」在 enforced（或模式值不是 advisory／enforced）時**拒絕啟動**（`isolation-enforced-unsupported`／`isolation-mode-invalid`），因為自訂 provider 還沒有受管隔離；要使用請先把模式改回 advisory。空白 shell、四格 terminal 與登入用 terminal 不啟動 agent CLI，使用者自己在裡面輸入的指令**不在受管範圍內**。沙箱只包住 CLI 程式，不包住使用者的 shell 本身。

**未驗證**：真實 CLI 是否肯走 `HTTPS_PROXY`、各供應商需要哪些網域、沒有 `gh` 的機器上（gh-cli 對照組無法成功＝unknown）enforced 會一律拒絕、真實 keychain helper（#135 T25）。Windows 端尚未接上（#26）。
