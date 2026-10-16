# agy CLI 官方資料調查

擷取日期：**2026-10-16**（Google 官方網站）。本文件的「已確認」只表示**官方文件如此記載**，不表示已在使用者的 macOS 或原生 Windows 上驗證。沒有安裝或執行 `agy`，沒有登入帳號，也沒有讀取任何憑證。所有待實機驗證的能力，在產品內仍須顯示「未知／未驗證」。

## 九項問題與證據

| 編號 | 結論 | 官方出處（均於 2026-10-16 擷取） | 是否需要實機驗證 |
| --- | --- | --- | --- |
| 1. 來源、版本、授權、安裝、執行檔 | **部分已確認。** Google 稱此產品為 Antigravity CLI，執行檔名 `agy`。官方快速入門列出 macOS／Linux 的預設位置 `~/.local/bin/agy`，原生 Windows 的預設位置 `%LOCALAPPDATA%\agy\bin`；官方安裝腳本分別支援 Unix shell、PowerShell、CMD。更新紀錄於擷取日列出 v1.3.6（2026-10-15），但版本漸進推出，**本機版本未知**。找到適用條款；**查不到獨立 CLI 原始碼授權或二進位軟體授權條款**，不得推定為開源或可再散布。 | [快速入門：安裝位置與驗證版本](https://antigravity.google/docs/getting-started?tab=cli)、[版本紀錄](https://antigravity.google/docs/changelog?tab=cli)、[Antigravity 服務條款](https://www.antigravity.google/terms) | **是。** 由使用者核對條款、官方下載來源及實際版本；在 macOS 和原生 Windows 分別核對 `agy` 路徑。 |
| 2. 啟動 | **部分已確認。** 官方快速入門要求在專案目錄執行 `agy`，開啟互動式 TUI 並進行工作區信任確認。官方另記載 `agy -p`／`--print` 單次無互動模式，`--output-format` 可用 `text`、`json`、`stream-json`；參數以文件中的 flag reference 為準。可由終端直接執行的說法有官方步驟，**原生終端實際相容性未驗證**。 | [快速入門](https://antigravity.google/docs/getting-started?tab=cli)、[Headless mode 與參數](https://www.antigravity.google/docs/cli/headless/) | **是。** 使用者於兩個系統的原生終端確認 `agy --version` 與互動式啟動，不必送回畫面中的帳號資訊。 |
| 3. 登入、帳號隔離 | **部分已確認，隔離能力查不到。** 官方說明本機啟動會嘗試作業系統安全金鑰圈的既有 token profile，否則開瀏覽器登入個人 Google 帳號或 Gemini Enterprise；另有 Gemini API key 及 ADC 路徑。`GEMINI_API_KEY` 只有在設定 `modelProvider: gemini` 時才啟用，啟用後略過帳號登入。**查不到**相當於 `CLAUDE_CONFIG_DIR`／`CODEX_HOME` 的 agy 設定根目錄環境變數、同時登入兩個帳號的方法、每個啟動程序獨立指定憑證的官方保證。金鑰圈中 token 的精確位置／格式亦查不到，不能讀取或推測。 | [認證](https://antigravity.google/docs/install?tab=cli) | **是。** 由使用者在自己的安全環境測試帳號切換與同時登入；在找到官方隔離規格前，不將 agy 標成支援多帳號隔離。 |
| 4. 身份核實 | **查不到。** 官方 CLI 指令參考有 `/logout`、`/usage` 等，但查不到等同 `claude auth status` 的可程式讀取身份與方案指令或 API。登入畫面可能顯示身份，**不能據此宣稱擴充套件可核實身份或方案**。 | [CLI 指令參考](https://www.antigravity.google/docs/cli/reference/)、[認證](https://antigravity.google/docs/install?tab=cli) | **是。** 使用者在真實 CLI 上查官方版本的命令清單與 UI；如有可讀身份來源，須先確認其格式、授權與不洩漏個資的讀取方式。 |
| 5. 額度與用量 | **部分已確認。** `/usage`（別名 `/quota`）會更新後端狀態並開互動式 TUI 面板，顯示模型剩餘請求或 token；`/credits` 與狀態列有 credits 資訊。Headless `json` 結果的 `usage` 是 token 計數；`stream-json` 的 `step_update.usage` 在已知時記錄單一步驟的 token 用量，最終 `result.usage` 記錄執行用量；持續以 stdin 傳入多輪時，`result.usage` 是整個 session 的累計值。這些欄位**不是訂閱剩餘額度**。**查不到**可由擴充套件安全讀取的剩餘額度 API／檔案格式、計量時間窗與重置時間。 | [模型額度](https://antigravity.google/docs/cli/commands/usage)、[AI credits](https://antigravity.google/docs/cli/credits)、[Headless 輸出結構](https://www.antigravity.google/docs/cli/headless/) | **是。** 使用者檢查真實 `/usage` 可見欄位與重置資訊；若要自動讀取額度，另需官方可程式介面和不含憑證的測試。 |
| 6. 狀態事件 | **部分已確認。** Headless `--output-format stream-json` 有 `init`、`step_update`、`result` 事件；`step_update.state` 記載 `ACTIVE`／`DONE`。`result.status` 的 `SUCCESS`、`ERROR`、`CANCELED`、`INTERRUPTED`、`INVALID`、`WAITING` 表示各種結束結果；`RUNNING` 表示尚未達到終態，不得當成已完成。這是 **headless 工作**的輸出；stdin 多輪模式可逐輪產生 `result`。**查不到**目前互動式 TUI 工作階段提供等效外部事件流或「等待使用者」的完整可觀測性保證。 | [Headless mode](https://www.antigravity.google/docs/cli/headless/)、[CLI 指令參考](https://www.antigravity.google/docs/cli/reference/) | **是。** 用非敏感測試工作由使用者確認實際事件順序、斷線／取消／權限詢問時的行為；TUI 狀態維持未知。 |
| 7. 規則與記憶注入 | **部分已確認。** 官方列出工作區／目錄的 `AGENTS.md`、`GEMINI.md`、`.agents/rules/*.md`，以及全域 `~/.gemini/AGENTS.md`、`~/.gemini/GEMINI.md`、`~/.gemini/config/rules/*.md`、`~/.gemini/antigravity-cli/rules/*.md`；規則依範圍累積，較具體的目錄規則優先。**查不到**啟動時以參數傳入私有規則全文的支援，也查不到 resume 必然重新讀取規則的承諾。專案不得把私人身份組規則寫入 repo，亦不得把共用全域檔案當作個別 agent 的安全注入。 | [規則](https://www.antigravity.google/docs/rules/)、[Headless 續接](https://www.antigravity.google/docs/cli/headless/) | **是。** 使用者以無敏感資料的測試規則確認各作用域、衝突優先序、續接時機；找到官方隔離入口前，產品顯示「不支援／需手動」，不聲稱已注入。 |
| 8. MCP 與網路 | **部分已確認。** CLI 官方文件支援本機 `stdio` 與遠端 MCP，`/mcp` 管理；全域設定 `~/.gemini/config/mcp_config.json`，工作區設定 `.agents/mcp_config.json`。`mcp(server/tool)`、`mcp(server/*)` 等權限規則可限制工具。**查不到**以單次 CLI 啟動參數替每個身份組提供獨立 MCP 清單的官方保證；本專案禁止從 repo 讀取決定行為的私人 MCP 設定，因此不得採用工作區檔案作身份隔離。網路可達性須連同沙箱與權限規則驗證。 | [MCP](https://antigravity.google/docs/mcp?tab=cli)、[權限](https://www.antigravity.google/docs/permissions?tab=cli) | **是。** 使用者在隔離測試環境確認工具 deny／ask／allow 和遠端網路存取；未驗證前預設不授予。 |
| 9. 權限與沙箱 | **部分已確認。** 官方 CLI 文件列出 Deny、Ask、Allow 規則，衝突時 Deny > Ask > Allow，設定及 `/permissions` 可編輯；Headless 文件說明使用者可自行在 `permissions.allow` 加入規則，提前授予特定工具權限，並非預設允許。官方說明 Windows 與 macOS／Linux 目前權限系統不同，不能假設跨系統相同效果。**未驗證**實際 CLI 對每種工具、MCP 及網路操作的阻擋結果。 | [權限](https://www.antigravity.google/docs/permissions?tab=cli)、[Headless 權限](https://www.antigravity.google/docs/cli/headless/)、[Agent 設定的系統差異](https://antigravity.google/docs/agent-settings) | **是。** 在無私人資料的測試專案，分別於 macOS、原生 Windows 驗證三種規則及沙箱逃逸請求；產品不得只依文件就標示「已套用」。 |

## 能力升級為 `verified` 前的實機驗證

由使用者自行決定是否安裝官方 CLI、接受條款並使用自己的帳號。回報只需要**版本、作業系統、測試步驟與去識別化結果**；請勿貼本機完整路徑、帳號標籤、token、API key、CLI 原始輸出或含有規則全文的截圖。

1. **終端啟動**：在 macOS 與原生 Windows 確認官方來源和條款後，使用無敏感資料的測試專案執行 `agy --version`，再從原生終端啟動 TUI。記錄是否可啟動、退出碼及版本；核對執行檔的安裝位置時只回報是否符合官方預設位置。
2. **帳號隔離與身份**：先取得官方多帳號隔離接口及可讀身份接口，再由使用者用兩個自行掌控的測試帳號逐一與同時登入、切換、重啟；僅回報是否互不影響及方案能否核實。不得讀取金鑰圈或 CLI 登入資料，也不得讓本擴充套件自動試探憑證位置。
3. **額度**：使用者目視比對 `/usage` 與 `/credits` 的欄位、刷新和重置資訊。若官方提供機器可讀介面，再用不含個資的測試資料驗證欄位、時間窗、失敗與過期顯示；單次 `usage` token 不得充當剩餘額度。
4. **狀態事件**：由使用者在測試專案以非敏感 prompt 驗證 headless `stream-json` 的啟動、工作、等待授權、成功、錯誤、中斷、取消事件。先確認輸出可能含工作區路徑、prompt、工具參數與結果，**不可上傳原始事件**；TUI 另需官方事件介面才可升級。
5. **規則注入**：先找到能隔離個別 agent 且不寫 repo 的官方入口。用假規則測試首次啟動、續接、衝突優先序及失敗狀態；僅在有可重現的注入證據時標示「已送入 CLI」。
6. **MCP、權限、網路與沙箱**：使用無敏感資料的本機假 MCP server 和測試工作區，在 macOS、原生 Windows 分別測 deny／ask／allow、工具範圍與網路封鎖。確認失敗時維持「未知」且不自動放寬權限。

## 實作界線

- 官方文件已提供 `agy` 的 TUI、headless 與部分規則／權限資料；這些是**後續實作線索**，本調查不改 `src/providers/registry.js` 的 capability 狀態。
- 官方[服務條款](https://www.antigravity.google/terms)包含第三方軟體存取服務的限制。任何超出使用者從原生終端手動啟動 CLI 的產品整合，應先由專案管理者確認適用條款；本文件不作法律結論。
- 找不到官方證據或實機驗證失敗時，顯示「未知／未驗證」，不將空值當成通過、未登入、零額度或已套用規則。
