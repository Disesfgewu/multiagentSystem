# 首次設定與診斷（macOS／原生 Windows）

本頁描述目前擴充套件已有的操作入口。macOS 與原生 Windows 的乾淨機器安裝、升級、登入及完整流程尚待 #135／#28 實機驗收；Windows 請使用原生 VS Code，不以 WSL 結果代替。

1. 在 VS Code 開啟要工作的專案資料夾，再安裝與該作業系統相符的 VSIX。安裝後點開活動列 **Multiagent**，讓擴充套件首次啟用。VSIX 安裝本身不會執行外部工具安裝程式。
2. 開啟 **Tools Setup**。首次啟用會嘗試從固定的官方版本來源準備 `gh`，下載與 SHA-256 驗證完成才顯示 Ready。Codex CLI 與 Claude Code 為選用受管工具，需在該列使用 **Retry Verified Codex CLI Setup** 或 **Retry Verified Claude Code CLI Setup** 才開始下載；下載並通過雜湊驗證後會自動注入新終端的 PATH，但登入仍由 CLI 的正式流程完成。Git 目前僅做 PATH 偵測，agy 標示為未驗證／暫不支援自動部署（需手動安裝）。各工具與平台的限制見 [工具來源矩陣](TOOL_SOURCE_MATRIX.md)。
3. 選 **Multiagent: Open Masked Setup and Storage Diagnostics**。唯讀報告會區分工具準備失敗、來源不支援、私人儲存狀態與 provider 的未知能力，並給下一個動作。遮罩報告不是備份；若要分享報告，仍應先人工檢查內容。
4. 在 **Accounts and Sessions** 建立帳號設定，在 **Role Groups and Rules** 建立身份組。只有 CLI 程式存在不代表其服務身分、額度或規則注入已核實；若診斷顯示未知，先使用正式登入入口並在自己的環境核對。
5. 從命令選單執行 **Multiagent: Open Four Native Terminals**。擴充套件在目前專案開四個原生 shell（PM、Worker 1–3），以 2×2 排列；可拖動終端分頁重新排列。此動作只開 shell，不會自動啟動或登入四個 CLI。選擇身份組和帳號後，可使用對應啟動命令在原生 terminal 開始 session。若已有部分同名 terminal，先關閉舊組再建立新的四格。
6. 要查看 Issue／PR，使用 **Issues Report**／**PRs Report**，點選清單項目後在編輯器讀取報告。報告開頭的 **OPEN DISCUSSION** 可跳到留言與 review；PR 另有 **OPEN CODE CHANGES**，可點選每個檔名在套件內讀取 GitHub 回傳的 patch 全文。GitHub 未提供 patch 或讀取不完整時會明示未知。PR 合併權限預設為 `human`；**Multiagent: Configure Pull Request Merge Authority** 可在已開啟的 GitHub 專案中選擇 `human` 或 `pm`，並要求確認。`pm` 只允許已設定的 PM 發布者在最新 head、review、CI、對話、分支規則與發布掃描等 gate 通過後明確觸發合併；設定不會使 CI 通過後自動合併，也不會改變 GitHub 站外權限。

## 出錯時

| 畫面或情境 | 可採取的動作 |
| --- | --- |
| `gh`／Codex／Claude Code 顯示 Needs setup，或下載中斷、離線、雜湊驗證失敗 | 連線恢復後在 Tools Setup 使用該列 Retry。失敗的資產不加入新 terminal 的 PATH。下載進度提示可直接點選取消；取消會清理未完成的暫存檔並保留既有已驗證安裝，可隨時重試。 |
| Git 或某個 CLI 顯示 Found on PATH／Not prepared | 這只表示是否找到命令。參照工具來源矩陣確認該平台的受管支援；沒有受管來源時須自行從供應商官方管道安裝。 |
| 顯示 private storage unavailable、migration 或 lock 問題 | 先看遮罩診斷。**Migrate Private Storage Schema** 會建立備份並遷移資料；**Recover Stale Private Storage Lock** 只在確認其他 VS Code 視窗沒有寫入時使用。**Clear Private Storage Data** 會清除擴充套件的私人紀錄與可識別備份，需明確確認；不要將它當作一般重試。 |
| CLI 能啟動，但身份、登入或額度顯示未知 | 用供應商正式登入流程核對；目前沒有來源的欄位仍維持未知。不要把「找到程式」當成「已登入」或零額度。 |
| PR 合併被拒絕 | 在 PR 報告查看最新 head、正式 review、CI、對話及權限原因；`human-merge-required` 表示目前是預設人工模式。只有需要 PM 受管合併時才變更 merge 設定。 |

正式安裝來源、版本與授權條件隨各 provider 不同。這份指引不要求上傳帳號標籤、憑證、CLI 原始輸出或本機完整路徑。
