# 擴充套件內的唯讀 GitHub 讀取

對應 Issue #15 的本輪切片（本文件隨 PR 以 `Refs #15` 交付，Issue 保持開放）。實作位於 `src/github/`，讀取本身沿用 `packages/github-read-adapter`（唯讀、可注入 transport，見該套件的 README）。這裡只做兩件事：把 adapter 接進擴充套件，以及提供導向正確 GitHub 頁面的入口。

**這條路徑沒有任何寫入 GitHub 的能力。** adapter 只發 `GET`，唯一的 `POST` 是固定常數的 GraphQL 查詢；擴充套件這一層不自己組任何請求，也不呼叫 `fetch`。寫入屬 #24 的 broker。

## 1. 命令

| 命令 | 作用 |
| --- | --- |
| `Multiagent: Browse GitHub Issues and Pull Requests`（`multiagentSystem.github.browse`） | 讀取開啟中的 Issue 或 PR，挑一項後開啟對應的 GitHub 頁面；PR 另可選「Checks」、「Changed files」或「在這裡讀取審查與 CI 狀態」 |
| `Multiagent: Open GitHub Issue`／`Open GitHub Pull Request`／`Open GitHub Pull Request Checks` | 以號碼直接開啟頁面。**位址在本機組出來，不需要讀取、也不需要登入** |
| `Multiagent: Show GitHub Pull Request Review and CI Status` | 讀取一個 PR 的審查與 CI **證據**，沒讀到的部分顯示為「未知」；不判斷能不能 merge |
| `Multiagent: Sign In to GitHub` | 明確的登入動作。**沒有任何讀取會自己啟動登入** |

repo 的決定順序：命令的 `repository` 選項 → 工作區資料夾的 GitHub `origin`（**只在已信任的工作區**才執行 git 讀取，使用既有的 `WorktreeService`）→ 請使用者輸入 `owner/name`。要看別的 repo，輸入即可；目前沒有「在多個 repo 間切換」的畫面（屬 #13）。

每個命令也有**程式化形式**（沒有任何提示）：`{ interactive: false, repository, kind, number, open }`。非互動時不顯示任何畫面，也只有在 `open: true` 時才開啟瀏覽器。命令參數**只**取這幾個欄位且檢查型別，**不能**選擇 transport 或憑證（有測試）。

## 2. 憑證

- 憑證**只**來自編輯器的官方驗證 API：`vscode.authentication.getSession('github', ['repo'], { silent: true })`。靜默取得（不跳出任何提示）、只在請求當下放在記憶體、直接交給 adapter 放進 `Authorization` 標頭，**不儲存、不記錄、不顯示**，也不出現在結果、錯誤訊息或開啟的網址。使用者沒有登入時，請求是匿名的（只能讀公開 repo，且額度較低）。
- 不讀取 `gh` 的登入、CLI 的登入檔案、環境變數，也沒有使用 `SecretStorage`（沒有任何憑證需要由本擴充套件保存）。靜態測試守住這些邊界。
- 如果編輯器**無法**提供登入（例如驗證提供者出錯），讀取以「被拒絕：無法從編輯器讀取 GitHub 登入」結束，**不會**退回匿名請求。
- **範圍的限制（需 PM 決定）**：編輯器的 GitHub 驗證提供者能讀取私人 repo 的最小 OAuth 範圍是 `repo`，而這個範圍本身**也允許寫入**。本擴充套件從不寫入（adapter 只有 `GET`，靜態測試確認原始碼沒有寫入動詞），但權杖本身不是唯讀的。若要真正的最小權限，應改用細粒度、唯讀的個人存取權杖並放進 `SecretStorage`，這需要使用者自行建立權杖，屬產品決策。

## 3. 失敗與未知怎麼顯示

| adapter 的結果 | 顯示 |
| --- | --- |
| `ok` | 清單 |
| `empty` | 「GitHub 確認沒有開啟中的項目」，不彈出空的選單 |
| `truncated`／`partial` | 清單，並明說這份清單不完整 |
| `not_found` | 「找不到，或這個帳號看不到；GitHub 兩種情況回答一樣」 |
| `denied` | 「GitHub 拒絕存取」與原因（登入被拒、需要 SSO、權限不足…），建議登入；**不會自動開始登入** |
| `rate_limited` | 說明被限流與可再試的時間，建議登入以提高額度 |
| `transient`／`offline`／`invalid` | 各自的訊息，**不顯示空清單** |
| `offline`／`transient`／`rate_limited` 且記憶體有舊資料 | 顯示舊清單，標為「過期」並附讀取時間，提示它可能已過時 |
| `denied`／`not_found` 且記憶體有舊資料 | **不顯示舊資料**（帳號可能已失去權限） |
| `cancelled`（使用者取消，或切換了 repo） | 靜默結束：沒有訊息、沒有清單、不開啟任何東西；遲到的舊 repo 回應不會顯示 |

不重複 GitHub 回傳的訊息文字（避免遠端內容出現在介面上）。清單中的標題、標籤、登入名稱都來自遠端，一律當純文字顯示：控制字元、雙向覆寫與零寬字元以空白取代，壓成一行並限制長度。PR 清單**不顯示**審查或 CI 狀態（清單端點沒有），顯示為「review and CI: not loaded」；要看狀態須明確讀取，沒讀到的部分是「unknown」。

只有 `https://github.com` 的頁面會交給瀏覽器（檢查協定、主機、連接埠與帳密）。

## 4. 測試與驗證

- `test/unit/githubController.test.ts`（31 項）：以**真正的 adapter** 搭配合成 transport，涵蓋清單、各種失敗、不完整、離線的過期清單、取消、repo 切換、頁面位址、輸入檢查、文字安全、repo 決定、互動流程、憑證不外洩、狀態文字。
- `test/unit/githubBoundary.test.ts`（10 項）：靜態檢查來源不引入檔案／行程／網路模組、沒有環境或 CLI 登入、沒有寫入動詞、憑證只經 `authentication.getSession`、命令參數不能選 transport、`package.json` 的命令與程式一致、沒有宣告 Workspace Trust 支援。
- `test/host/suite/github.ts`：在**真的 VS Code Extension Host**（1.95.0 與 stable）以合成 fetch 驗證六個命令已註冊、匿名與帶憑證的讀取只對 API 主機發 `GET`、失敗不是空清單、取消與 repo 切換、命令參數不能注入 transport 或憑證、頁面位址與只在要求時開啟。測試用的覆寫只在編輯器處於測試模式時可安裝。

## 5. 未驗證（不宣稱通過）

- **真實的 GitHub 登入流程**：`Sign In to GitHub` 沒有在任何自動測試中執行（它會開啟瀏覽器）；`getSession` 在真實登入下的行為、多帳號選擇、權杖過期後的行為都沒有驗證。
- **對真實 GitHub 的完整權限／GraphQL 驗證**、GitHub Enterprise（本輪只支援 github.com）。
- **互動式畫面**（選單、進度、取消按鈕、modal）只以假的 UI 驗證；Extension Host 冒煙測試只驅動非互動形式。
- **Windows 實機**：CI 的 Windows 是 GitHub 託管環境，不是正式支援矩陣內的實機驗收。
- 專案總覽畫面與 repo 切換畫面屬 #13。
