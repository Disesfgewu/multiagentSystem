# Provider 登錄

第一階段內建三個 CLI agent provider：Claude Code（`claude`）、Codex CLI（`codex`）、agy（`agy`）。各模組應從登錄（`src/providers/registry.js`）取得 provider，不得再新增寫死的 provider 清單。使用者自訂 provider 不在第一階段範圍（見 #59）。

## 描述與安全規則

每個 provider 是一份描述：`id`、`label`、`executable`、`args`、`support`、`capabilities`。未知欄位一律拒絕，錯誤碼只指出欄位，不含被拒絕的值。

- `id`：小寫英數與 `-`，1–32 字元，不得像帳號、地址或路徑。
- `executable`：只能是裸檔名（不含路徑、空白、shell 字元），第一階段三個內建項目寫在程式裡，**不從設定、工作區或專案檔案讀取**。以參數陣列啟動，不經 shell 字串拼接。
- `args`：最多 32 個、每個由 `A-Za-z0-9._=:/@+-` 組成的單純 token，不含空白、引號、換行或控制字元。內建項目目前沒有額外參數。
- `label`：可顯示文字，不含控制字元、雙向或零寬格式字元，最長 64 字元。
- 輸出順序以 `id` 的 UTF-16 code unit 比較，與語系無關。

## 能力表

每項能力各自為 `verified`、`unverified`、`unsupported` 或 `unknown`，沒有說明的一律 `unknown`：`terminalLaunch`（終端啟動）、`accountIsolation`（帳號隔離）、`identityVerification`（實際身份核實）、`usageObservation`（額度／用量觀測）、`ruleInjection`（規則與記憶注入）、`resume`（續接）、`statusEvents`（狀態事件）、`webSearch`（網路搜尋／讀取網頁）、`mcp`（MCP 支援與依身份組限制）。

能力只表示「是否已被驗證」，不代表允許使用；是否允許上網、使用 MCP 等由身份組權限決定。升級為 `verified` 必須有該 CLI 的官方文件依據與 macOS／原生 Windows 實機驗證，CI 與合成資料不算。

| provider | 支援程度 | 已有程式但未經實機驗證（`unverified`） | 其餘 |
| --- | --- | --- | --- |
| `claude` | 專屬支援 | 終端啟動、帳號隔離、身份核實、用量觀測、規則注入、續接、狀態事件 | 網路搜尋、MCP：未知 |
| `codex` | 專屬支援 | 終端啟動、帳號隔離、身份核實、規則注入、額度／用量（讀取本機 session 紀錄，見 [額度政策](QUOTA_POLICY.md)） | 續接、狀態事件、網路搜尋、MCP：未知；session 內的即時狀態沒有來源 |
| `agy` | 終端啟動與手動注入 | 終端啟動（僅為假設） | 帳號、身份、額度、規則注入、續接、狀態、網路搜尋、MCP：未知；規則與記憶不會自動注入 |

目前沒有任何內建能力標為 `verified`。agy 的啟動參數、登入、帳號隔離、狀態事件、用量來源、規則注入入口與續接，在引用官方文件並實機驗證前都不得寫入程式或文件。

## 自動模式（#296）

使用者層級設定 `multiagentSystem.agents.autoMode`（`on`／`off`，預設 `on`）與每個 provider 的覆寫 `multiagentSystem.agents.autoModeOverrides`；工作區的值一律忽略。`src/providers/auto-mode.js` 是唯一決定旗標的地方，每個旗標都是官方文件列出的（2026-10-21 查閱）：

| provider | 帶入的參數 | 依據 | 沒有採用 |
| --- | --- | --- | --- |
| `claude` | `--permission-mode auto` | [CLI reference](https://code.claude.com/docs/en/cli-reference)、[permission modes](https://code.claude.com/docs/en/permission-modes)：`auto` 由 classifier 模型代替人審核；Claude Code v2.1.283 起是互動 session 的內建起始模式；**auto 不可用時 Claude Code 會改以 Manual 啟動**（所以這只是請求） | `--dangerously-skip-permissions`／`bypassPermissions`（文件：只適用於隔離的容器與 VM） |
| `codex` | `--sandbox workspace-write --ask-for-approval never` | [Codex CLI reference](https://developers.openai.com/codex/cli/reference)（導向 learn.chatgpt.com；頁面沒有版本）：`-a never` 不暫停詢問、`-s workspace-write` 把指令限制在工作區 | `--yolo`／`--dangerously-bypass-approvals-and-sandbox`（文件：只在外部已加固的環境使用）；`--full-auto` 該頁沒有列出 |
| `agy`、其他 | 無 | 沒有官方文件列出的自動模式旗標 | 不猜；畫面標為「未知」 |

選擇的理由：目標是讓 agent 不用一直等人工核准，同時只用文件列出且不是「完全繞過」的旗標。想要更強的繞過，使用者可以在自訂 provider 自己指定。**未驗證**：真實 CLI 是否接受並遵守這些旗標（#135）。無法讀懂的設定值（例如打錯字）視為 `off`，並在畫面說明，不會讓 agent 變得更不謹慎。與隔離的關係：enforced 時 CLI 在沙箱內，`wrap` 收到的最終參數含這些旗標；advisory 時畫面提醒「沒有隔離保護，agent 可以直接執行指令與寫入檔案」。「套件自己的確認視窗不能被參數跳過」（#183）不受這個設定影響。自訂 provider 的啟動不經過這個設定。

## 署名（co-author）

套件不讓自己啟動的 agent 在對外發佈的內容加上署名行（#293）。**Claude Code**：每次啟動（start、reopen、身份組啟動都走同一條路）帶 `--settings <路徑>`，路徑指向擴充套件**私人儲存區**裡每次啟動都重寫的設定檔（權限 0600，只含 `{"attribution":{"commit":"","pr":"","sessionUrl":false}}`），不改使用者的任何檔案。用路徑而不是行內 JSON，是因為 Windows PowerShell／cmd 會弄壞行內 JSON 的引號。**設定檔準備不了（沒有私人儲存區）就不啟動 Claude Code**，不會在沒有這個開關的情況下啟動。`--settings` 接受路徑與 `attribution` 設定名稱依 Claude Code 官方文件，**尚未用真實 CLI 實測**（#135）。**Codex、agy、自訂 provider**：沒有已證實的等效設定，**狀態未知**，不宣稱已關閉；它們若自己加署名行，會在經過 Broker 時被拒絕，但直接用 `git`／`gh` 的路徑不受 Broker 管轄。只傳一個 `--settings`；之後若別的功能也要傳設定，必須合併成同一個值。

## 登錄整合進度

啟動選單、身份組 provider 驗證、儲存匯出的 `provider` 公開值清單與注入 provider 的辨認已改用 `src/providers/registry.js`。Claude Code 與 Codex CLI 保留原有專屬注入方式；agy 目前產生明確的手動貼上計劃，不會假裝已自動注入。

## 自動模式的確認（Issue #296）

- **第一次**以自動模式（`on`）啟動 agent 時，會先跳出一個必須回答的視窗，說明自動模式代表什麼、如何關閉（`multiagentSystem.agents.autoMode`／各 provider 覆寫，僅使用者設定）；按 **I Understand, Continue** 後記住（跨工作區，只問一次），不按就不啟動、也不記住。新開與重開 session 都適用；自動模式關閉、未知（無官方旗標）或只開 shell 時不問。確認只能在這個視窗回答，參數不能代答。
- **enforced 隔離**的確認視窗也會列出自動模式的說明（在沙箱內執行）。
