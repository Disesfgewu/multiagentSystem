# 帳號檔案服務與顯示層

對應 Issue #12 的第一個切片。狀態：**核心服務與顯示資料已實作，以合成資料與真實暫存資料夾測試；VS Code UI、登入入口與真實 CLI 驗證尚未做。**

## 範圍與檔案

| 檔案 | 內容 |
| --- | --- |
| `src/accounts/profile-service.js` | `AccountProfileService`：建立、編輯、移除、指派。建構在 `PrivateStore`（`profiles` 集合，交易）與既有的 `validateProfile`／`findConfigDirConflicts`，沒有重寫驗證 |
| `src/accounts/profile-view.js` | `describeAccounts`：把檔案與「已觀測到的身分」整理成可顯示的資料；重用 `reportEntry`／`profileReadiness`／`groupBySubject` |

## 記錄

`profiles` 集合，id 為程式產生的 `acct-<12 hex>`（不是標籤）。欄位名稱固定：`provider`、`label`、`configDir`、`expectedAuthMethod`、`secretRef`、`revision`、`createdAt`、`updatedAt`。**不存任何憑證**：只有不透明的 `secretRef`（指向 `SecretVault`），任何看起來像憑證的值由儲存層拒絕。**不存**服務回報的資訊（身分、方案、額度）：那些是即時觀測，不持久化。遮罩匯出只會顯示 `provider`，標籤、路徑、id、`secretRef` 都被遮蔽（有測試）。

## 規則

- **建立／編輯**：provider 必須支援且不可更改；標籤 1–80 字元、無控制字元，**同 provider 內不可重複**（忽略大小寫與全形）；設定資料夾經既有路徑驗證（絕對路徑、不含 `..` 片段、不在 repo 內、不是 provider 預設資料夾、可解析），且**不可與其他 profile 相同或巢狀**（含經由連結指向同一資料夾）；最多 50 個。保存前會正規化路徑字串；受管啟動環境只會在再次驗證路徑後使用其解析結果。編輯只重驗有變動的部分：只改標籤不會因為資料夾暫時無法解析而被擋。
- **樂觀並行**：`update(id, changes, { expectedRevision })`，版本不符回 `stale-revision`。
- **指派**：`assign({ provider, sessionOverride, roleGroupDefault })`：session 的選擇優先於身份組預設；profile 必須存在且與 session 的 provider 相同；沒有任何選擇是 `no-account-assigned`（不猜；空字串與 `null` 都視為「沒有選擇」，改用身份組預設）；過期的覆寫回 `override-profile-missing`，**不會靜默改用預設**。session 啟動時以 `resolveForLaunch(id)` 取得 profile 並把 id 固定在 session（#11 的 `SessionManager`），之後修改 profile 不會改變已存在 session 的帳號。
- **啟動前閘門**：`resolveForLaunch` **每次**都重驗，而不只在建立／編輯時：該 profile 的資料夾必須仍通過 `validateProfile`（不在 repo 內或包含 repo、不是 provider 預設資料夾、可解析）、與目前所有 profile 都沒有相同或巢狀（資料夾事後被換成指向 repo 或另一個 profile 的連結時，兩邊都拒絕）、存在時必須是目錄（被換成檔案、權限錯誤都拒絕；尚未建立則允許，登入會建立它）。任何問題回 `config-dir-rejected`，附 `problems`（與 `conflictsWith`），**不回傳 profile**。`assign` 也經過同一道閘門，失敗時保留 `source`；因此 `resolveForLaunch`／`assign` 是啟動前的閘門，`get`／`list` 只讀取記錄、不重驗。顯示層（`describeAccounts`）同樣每次重驗。
- **使用中的 profile**：改變「帳號指向」的欄位（`configDir`、`secretRef`）在任何 session 仍引用該 profile 時一律拒絕（`profile-in-use`），因為重開 session 會沿用同一個 id，等於靜默換帳號；標籤與預期登入方式可改。`secretRef` 一旦設定就**不能更換或清除**（`secret-ref-locked`），否則舊的秘密會留在 SecretStorage 成為孤兒；需要時建立新 profile。刪除：有開啟 terminal 的 session 使用時拒絕；只有已關閉／未知的歷史 session 引用時回 `profile-referenced`，需 `allowHistoricalReferences: true` 明確確認。刪除只移除記錄與 `secretRef` 指向的秘密（失敗時回報 `secretCleanupFailed`，不含細節），**不碰 CLI 的設定資料夾與登入檔案**。
- **結果代碼**：每個失敗都有穩定代碼與可操作的訊息（`MESSAGES`）；儲存層錯誤只傳遞原因，不傳細節；憑證形態回 `secret-in-record`，不回顯內容。儲存無法讀取（損壞、被鎖）回 `store-unavailable`／`store-locked`，**不當成空清單**，原檔不改。

## 顯示層

每個帳號只呈現四種來源明確的欄位，其餘一律是「未知」並附原因：

| 欄位 | 來源 | 說明 |
| --- | --- | --- |
| `label` | `user-label` | 使用者輸入的標籤，**不是**身分證據 |
| `verifiedIdentity` | `service` 或 `unknown` | 服務確認的主體：以 8 碼不可逆指紋分辨「同一帳號／不同帳號」；**不保存** email 或組織（畫面顯示的 email 與組織見下一節）；未驗證時是 `unknown` 加原因（`not-logged-in`、`auth-method:…`、`not-inspected`） |
| `loginMethod` | `service` 或 `unknown` | CLI 回報的登入方式與預期值 |
| `health` | — | `ready`／`attention`／`unknown`；沒有觀測時是 `unknown`，**不會是 ready** |

`issues` 列出代碼與提示：未登入、設定資料夾不符、環境變數憑證覆蓋、登入方式不符、重複帳號（兩個 profile 登入同一真實帳號，互相列出 `duplicateOf`）、資料夾相同或巢狀。這個模組不執行 CLI、不讀登入檔案；觀測資料由呼叫端提供（既有的 `claudeIdentityFromAuthStatus`／`codexIdentityFromAccountRead`）。

## 驗證

- `test/accounts/profile-service.test.js`（30 項，真實 `PrivateStore` 與暫存資料夾，含空白與 Unicode 路徑、連結／junction 指向既有資料夾、檔案取代上層目錄、損壞的 `store.json`）與 `test/accounts/profile-view.test.js`（11 項）。變異檢查：移除使用中檢查、刪除保護、重複標籤、資料夾衝突、路徑驗證、provider 不可變、版本檢查、覆寫回退預設、provider 不符、只改標籤時重驗資料夾、指紋縮短、無觀測仍 ready、重複帳號標示，均有測試失敗。
- CI：`account-isolation` workflow 在 macOS／Windows × Node 20／24 執行（含新檔案的語法檢查）。

## 尚未完成／未驗證

- **VS Code UI**：建立／編輯／移除的畫面與選單、「使用中」的提示互動。
- **登入入口**：開啟對應原生 terminal 讓使用者自行登入、登入後重新檢查。
- **與 session 整合**：`SessionManager` 目前使用佔位帳號 `unassigned`，尚未呼叫 `assign`／`resolveForLaunch`；重開 session 時若 profile 已被刪除需要拒絕（本 PR 只提供 `resolveForLaunch`）。「使用中」判斷依呼叫端提供的 session 清單，檢查與刪除之間沒有跨元件的原子性，session 啟動端必須在啟動時再解析 profile。
- **真實驗證**：真實 CLI 的 `claude auth status`／Codex `account/read`、兩個真實帳號並行與額度來源、Windows 實機與 ACL，仍屬 #3 的未驗證項目。本 PR 只用合成資料，**不得視為已驗證**。
- **身份組預設**：`roleGroupDefault` 由呼叫端傳入，來源屬 #14。
- 未實作受管啟動的阻擋（`buildLaunchEnv` 的 blockers 在啟動流程接上之前不會阻擋任何東西）。

## 登入後的身份檢查（`Check Account Sign-in`）

`src/accounts/identity-check.js` 在使用者完成登入後，以**該帳號設定資料夾的環境**執行 provider 自己的狀態命令，並把結果還原成帳號畫面已經理解的觀測（8 碼不可逆指紋、登入方式、健康、可選的方案）。

- 只有 Claude Code 有檢查：`claude auth status --json`（命令固定，不由設定、標籤或工作區決定；可執行檔名取自 provider 登錄）。Codex 的檢查需要 app-server 協定工作階段，agy 沒有已驗證的檢查，兩者目前一律回「未知：此 provider 尚無檢查」，不猜測。
- 以 `execFile` 的參數陣列執行（不經 shell）、10 秒逾時、輸出上限 64 KB；環境以 `launchEnvironment` 為準（設定資料夾套用、繼承的憑證覆蓋變數移除）。只解析 stdout 的 JSON；stderr 不讀入任何值。
- **原始輸出不被保留、記錄或放進錯誤訊息。** 結果含指紋、登入方式、方案（僅在 CLI 回報、且是簡短單純文字時）、異常旗標、檢查時間與來源，以及另外放在 `display` 的 email 與組織名稱（見下）。
- **email 與組織只顯示在本機畫面上（#352，管理者要求，取代先前「只顯示指紋」的政策）**：帳號列與帳號詳情顯示 CLI 回報的帳號 email，以及組織名稱（如果有）。只接受格式正確、簡短、單行的值。這兩項只放在這個視窗的記憶體中：
  - **不寫入**私人儲存區、任何紀錄（dispatch、用量紀錄、稽核）、匯出（專案報告、用量紀錄）或 log。
  - 不送到 GitHub，也不放進 agent 的 prompt 或指示。
  - 測試會掃描私人儲存區的檔案，確認裡面沒有 email。
- 任何失敗（找不到 CLI、逾時、輸出過大、非 JSON、欄位不符、非零結束碼、設定資料夾不再通過檢查）都是「未知」加原因與白話說明，不會顯示 ready。
- 登入 terminal 關閉時自動檢查一次，也可按「我已完成登入，立即檢查」或用 `Check Account Sign-in`；確認身分後提供「以此帳號啟動 session」。
- 檢查結果（**不含** email 與組織）存在私人儲存區（`accountChecks`），重新載入視窗後仍看得到，並標示檢查時間與「檢查於這個視窗開啟之前」。擴充套件啟動時，會自動依序把每個有檢查的帳號重新檢查一次；email 與組織就是從這次檢查重新取得的。
- 帳號列一行顯示：管理者取的名稱、email（組織）、方案、登入狀態與檢查時間、額度（例如 `5h 32% (resets in 2h) · 7d 10%`）。沒有額度數字時，寫明原因與下一步（例如「status line not set up: use Configure Claude Status Line Bridge」、「no agent has run on this account yet: start one and its usage appears」）；過期的數字標示為 out of date。同一個真實帳號登入在兩個資料夾時，顯示 `DUPLICATE ACCOUNT`，並說明怎麼修正。Accounts 檢視最上方有一列總覽（幾個帳號、幾個已登入、幾個需要處理）。
- 訂閱方案欄位名稱（`subscriptionType`）沿用既有解析器，**未對真實 CLI 輸出驗證**；只有 free、pro、max、team、enterprise（不分大小寫，顯示為小寫）會被顯示，其他任何文字都丟棄為「未知」；清單是猜測的目前名稱，不是已驗證的。
- 逾時由執行器自己強制：到時限先送 SIGTERM，寬限期（1.5 秒）後仍未結束就 SIGKILL，並在固定的硬時限內一定回報；檢查本身另有硬時限，執行器若完全不回應也會被放棄並回報逾時。
- 帳號詳情把「設定資料夾是否通過本擴充套件的安全檢查」與「CLI 是否確認它使用這個資料夾」分成兩行：CLI 沒裝或沒回報只會讓第二行是未確認，不會讓資料夾顯示為被拒絕。
- **Windows 目前不執行這個檢查**：CLI 常是 `.cmd` 轉接檔，不經 shell 無法啟動，所以檢查直接回報「此檢查在 Windows 尚未支援」，身分維持未知（請改用 CLI 自己的狀態命令）；沒有在原生 Windows 實機驗證任何行為。
- 逾時會停止整個行程群組（POSIX 上子行程自成群組，連它啟動的行程一起停；Windows 以 `taskkill /T /F` 嘗試，未實機驗證）。找到但無法執行（權限）與找不到分開回報。
