# P0：同供應商多帳號隔離與額度來源

對應 Issue #3，以及 `docs/IMPLEMENTATION_PLAN.md` 的 R06、R12、R13。

狀態：**部分驗證**。macOS 上以無需憑證的方式完成了隔離機制、覆寫來源與欄位來源的實測；路徑與環境變數規則另在 CI 的 macOS 與 Windows runner 上通過。兩個真實登入帳號的並行測試，以及原生 Windows 上的 CLI 登入隔離與 terminal 整合，尚未驗證，原因見第 7 節。

測試環境：macOS（Darwin 25.6）、Node.js 24、Claude Code 2.1.299、Codex CLI 0.162.1，實測日期 2026-10-14。本文不含任何真實帳號身份、token、設定目錄或 session 資訊；實測使用空的暫存設定目錄與明顯無效的假值。

## 1. 結論摘要

| 項目 | 結果 | 依據 |
| --- | --- | --- |
| Claude Code 以 `CLAUDE_CONFIG_DIR` 隔離登入 | macOS 空目錄**不串用**預設登入（已實測）；兩個真實登入並行**未驗證** | 第 3.1 節 |
| Codex 以 `CODEX_HOME` 隔離登入 | macOS 空目錄**不串用**預設登入（已實測）；兩個真實登入並行**未驗證** | 第 3.2 節 |
| 能否確認「實際生效的設定目錄」 | 兩個 CLI 都可以（已實測） | `claude auth status` 的 `configDirectory`、App Server `initialize` 的 `codexHome` |
| 繼承環境造成的意外覆寫 | Claude 多種來源會改變實際使用的憑證（已實測）；Codex 的 API key 變數是否生效**未驗證** | 第 3.1、3.2 節 |
| 登入狀態等於已核實身份 | **否**：`loggedIn: true` 可能只是未驗證的 API key | 第 3.1 節 |
| 逐帳號額度來源 | Claude：status line `rate_limits`（只在執行中的 session、僅限訂閱帳號）；Codex：App Server `account/rateLimits/read` | 第 4 節 |
| Claude status line 是否帶帳號身份 | **否**，額度須經啟動時的設定目錄與 `auth status` 綁定到帳號 | 第 4 節 |

## 2. AccountProfile 與 session 的固定對應

欄位依計劃書第 5 節；以下為本實驗實作與驗證的部分（`src/accounts/profile.js`）。

| 欄位 | 說明與規則 |
| --- | --- |
| `id` | 本機唯一識別。公開內容不得使用。 |
| `provider` | `claude` 或 `codex`。 |
| `label` | 使用者標籤，**不等於**已核實身份。 |
| `configDir` | 該帳號專用的設定目錄，須為絕對路徑。 |
| `expectedAuthMethod`（選填） | 預期的登入方式；實際不同時標為異常。 |
| `privacyDomain` | 記憶共享邊界，預設每帳號一域（本 Issue 僅保留欄位，不實作）。 |

`configDir` 的驗證規則（任一不符即拒絕受管啟動）：

- 必須是絕對路徑。Windows 上沒有磁碟機代號或 UNC 前綴的路徑（例如 `\temp\x`）會依「目前磁碟機」解析，因此視為不穩定而拒絕。
- 不得位於 repo 內，也不得是 repo 的上層目錄；比較前先解析符號連結，目錄尚未建立時解析最近的既有上層目錄。**只有 `ENOENT` 被視為「尚未建立」**；權限錯誤、迴圈、路徑中有檔案（`ENOTDIR`）或沒有錯誤碼的失敗一律 fail closed，回報 `config-dir-unresolvable`（repo 根目錄或預設目錄無法解析時分別為 `repo-root-unresolvable`、`provider-default-unresolvable`），不會當成「不存在」而通過。
- **一路 `ENOENT` 走到磁碟根目錄也 fail closed**（例如沒有掛載的 `Z:\`、不存在的 UNC 主機）：沒有任何一層被驗證過，不能當成「尚未建立」。repo 根目錄與預設目錄同理，無法解析時不宣稱已驗證。
- **最近的既有祖先必須是目錄**：Windows 對一般檔案之下的路徑回報 `ENOENT`（macOS 回報 `ENOTDIR`），兩者都拒絕，避免把檔案祖先當成可建立的目錄。
- 不得等於該 provider 的預設設定目錄（`~/.claude`、`~/.codex`），避免與使用者自己開的非受管 terminal 共用登入。
- 兩個 profile 不得相同或互相包含；Windows 比較時忽略大小寫。

啟動時由 `buildLaunchEnv` 設定 `CLAUDE_CONFIG_DIR` 或 `CODEX_HOME`，並檢查繼承環境中會改變憑證來源的變數：**只回報變數名稱、不回報值**，有任何一項即阻擋受管啟動，不靜默剔除。Windows 環境變數名稱以不分大小寫比對。

`accountProfileId` 在 session 建立時固定；切換帳號須開新 session。這是產品層規則，本 Issue 只提供資料與驗證函式，未實作 session 儲存。

## 3. 隔離機制與實測

以下「已實測」皆為在 macOS 上對空的暫存設定目錄執行，未使用任何真實的第二個帳號。

### 3.1 Claude Code

官方文件說明：設定 `CLAUDE_CONFIG_DIR` 後，`.credentials.json` 位於該目錄之下，macOS Keychain 項目也以該目錄為鍵，因此不同目錄讀取不同項目。官方同時說明限制：**不建立 API key 的 Console 登入存放在設定目錄之外**，兩個這類登入無法靠設定目錄分開，且該登入流程會登出機器上的 claude.ai 登入。

| 情境（`claude auth status --json`） | 結果 |
| --- | --- |
| 預設設定 | `loggedIn: true`，`authMethod: claude.ai`，回報 email／org／plan 欄位 |
| 空的 `CLAUDE_CONFIG_DIR`（兩個不同目錄） | 兩者皆 `loggedIn: false`，`authMethod: none`；`configDirectory` 回報該目錄；不含 email／org 欄位 |
| 空目錄 + 假的 `ANTHROPIC_API_KEY` | `loggedIn: true`，`authMethod: api_key`，`apiKeySource: ANTHROPIC_API_KEY`，**無** email／org 欄位 |
| 空目錄 + 假的 `ANTHROPIC_AUTH_TOKEN` | `loggedIn: true`，`authMethod: oauth_token` |
| 空目錄 + 假的 `CLAUDE_CODE_OAUTH_TOKEN` | `loggedIn: true`，`authMethod: oauth_token` |
| 空目錄 + `CLAUDE_CODE_USE_BEDROCK`／`VERTEX`／`FOUNDRY` | `loggedIn: true`，`authMethod: third_party`，`apiProvider` 依序為 `bedrock`／`vertex`／`foundry` |
| 空目錄 + `ANTHROPIC_PROFILE`（指向不存在的 profile）、`ANTHROPIC_BASE_URL` | 狀態無變化；真實 profile 的影響**未實測**，依官方優先序仍列為阻擋 |

得到的設計約束：

1. `loggedIn: true` 不代表身份已核實。假的 API key 也會顯示已登入，且狀態指令沒有驗證該 key。只有 `authMethod: claude.ai` 且帶有 email 時才可視為「服務確認的主體」，其餘一律為「未知」。
2. `configDirectory` 可用來核對實際生效的設定目錄是否為 profile 指定的目錄。CLI 沒有回報（舊版本）或兩側目錄無法解析時，結果是**未知**（`null`），不是相符；未知的設定目錄不能判定為就緒。
3. 官方憑證優先序中，雲端供應商變數、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY`、`apiKeyHelper`、`CLAUDE_CODE_OAUTH_TOKEN`、`ANTHROPIC_PROFILE`／federation 變數都排在訂閱登入之前。`apiKeyHelper` 是設定檔項目而非環境變數，**目前的檢查看不到它**，列入未驗證項目。

### 3.2 Codex CLI

| 情境 | 結果 |
| --- | --- |
| `codex login status`，預設設定 | `Logged in using ChatGPT`，離開碼 0（只輸出文字，無身份欄位） |
| `codex login status`，空的 `CODEX_HOME`（兩個不同目錄） | `Not logged in`，離開碼 1 |
| 空目錄 + 假的 `OPENAI_API_KEY` 或 `CODEX_API_KEY` | `login status` 與 `account/read` 皆**不變**（仍為未登入） |
| `codex app-server --stdio` 的 `initialize` | 結果含 `codexHome`，可核對生效目錄 |
| `account/read`（空目錄） | `account: null`，`requiresOpenaiAuth: true` |
| `account/rateLimits/read`（空目錄） | 回傳「需要登入」錯誤，對應為額度未知 |

得到的設計約束：

1. `login status` 只有文字，不足以核實身份；身份須走 App Server 的 `account/read`（`chatgpt` 類型含 email 與 `planType`，`apiKey`、`amazonBedrock` 類型不含身份）。
2. 假的 API key 不會出現在 `login status` 或 `account/read`，因此**無法用 CLI 自己的狀態發現這類覆寫**；它們是否在實際請求時被採用未驗證。受管啟動先以變數名稱檢查並阻擋，維持 fail-closed。
3. 預設設定目錄使用檔案式 `auth.json` 存放登入，因此隨 `CODEX_HOME` 分開。若使用者設定為作業系統憑證庫，憑證庫項目是否也依 `CODEX_HOME` 分開，**未驗證**。
4. App Server 協定標示為實驗性（experimental），欄位名稱與方法可能隨版本變動；本實驗以該版本產生的 JSON Schema 為準。

## 4. 欄位來源與語意

每個觀測值使用同一結構（`src/accounts/observation.js`）：`field`、`value`、`unit`、`scope`、`source`、`observedAt`、`confidence`（`actual`／`estimated`／`unknown`），有時效的值另有 `validForMs`；未知值帶 `reason`。服務沒提供的欄位一律為 `unknown`，不由本機 token 推算。

| 欄位 | 來源 | 範圍／單位 | 缺席或失敗時 |
| --- | --- | --- | --- |
| Claude 主體、方案 | `claude auth status --json` | 僅 `authMethod: claude.ai` 且有 email 時為 `actual` | `unknown`，`reason` 為 `not-logged-in` 或 `auth-method:<值>` |
| Claude 5 小時／7 天用量 | status line 的 `rate_limits.five_hour`、`rate_limits.seven_day` 的 `used_percentage`（0–100）與 `resets_at`（epoch 秒） | 服務回報的視窗；百分比 | `rate_limits` 只出現在訂閱帳號且需第一次 API 回應之後；各視窗可獨立缺席；`resets_at` 已過的視窗標為 `unknown`（`window-reset-passed`） |
| Codex 主體、方案 | App Server `account/read` | 僅 `chatgpt` 類型為 `actual` | `unknown` |
| Codex 額度 | App Server `account/rateLimits/read`，依 `limitId` 分桶，各桶 `primary`／`secondary` 的 `usedPercent`、`windowDurationMins`、`resetsAt` | 服務回報的視窗；百分比 | 未登入時方法回錯誤 → `unknown` |

注意事項：

- **Claude status line 不含帳號身份**（欄位只有模型、成本、context、`session_id`、`rate_limits` 等）。額度只能經「該 session 啟動時使用的 profile 設定目錄」綁到帳號；綁定的可信度取決於該 profile 的 `auth status` 是否已核實主體。
- **Claude 額度只存在於執行中的 session**，沒有獨立查詢指令；P3 需要 status line hook 或 session 側的取得方式，本 Issue 未實作。
- **Codex `resetsAt` 的單位在協定 schema 中未說明**（只標 int64）。實作以原值保存並標示 `epoch-unit-unspecified`；為了讓讀值不跨越重置，另以量級判斷（小於 1e11 視為秒，否則為毫秒）推得重置時刻，**只用來縮短有效期限、不用來延長**，單位仍須以真實回應確認。
- Codex 回應註明 `ordinaryUsageAllowed` 為 null 時「不得由百分比或重置時間推斷已恢復」，實作遵循此原則，未使用該欄位推導。
- 數值皆為整數或小數百分比，不是「剩餘 token」；不同帳號、不同視窗不得相加。

### 閘門資格

只有同時符合以下條件的值才能作為「停止分派新任務」的硬性門檻（`isGateEligible`）：

- `confidence` 為 `actual`，值不是 `null`。
- 單位為百分比時，值必須是有限數字且在 0–100 之間；字串、`NaN`、無限大、範圍外的值在建立觀測時就成為 `unknown`（`invalid-value`），並且閘門再檢查一次。
- `validForMs` 是有限的正數，`observedAt` 與目前時間都可解析，且 `observedAt` **不晚於**目前時間（未來樣本不可作閘門）。
- 目前時間**早於** `observedAt + validForMs`；剛好到期即失效。

估算值與不符合上述條件的值只能提示。

**有效期限不得跨越已知重置。** 配額讀值的 `validForMs` 為 `min(QUOTA_TTL_MS, 重置時刻 − 讀取時刻)`；重置當下與之後即失效，舊的額度不會阻擋或放行新工作。重置值存在但無效（非數字、非正數）時整個視窗為 `unknown`（`invalid-reset`）；重置已過的視窗為 `unknown`（`window-reset-passed`）。重置值缺席時只受 TTL 約束。

預設上限 `QUOTA_TTL_MS` 為 10 分鐘，是可調整的**讀取 TTL 上限**（PM 已確認作為原型預設）。

### 重複帳號

兩個 profile 若確認為同一真實帳號，額度不得算兩份。`groupBySubject` 以不透明的比較鍵（由供應商與主體識別欄位雜湊而得，只存在記憶體，不輸出）分組，回報重複組與「無法核實主體、因此不合併也不視為相同」的 profile。

## 5. 重現方式

前置：兩個 CLI 皆已安裝；為每個 profile 準備**repo 外**的空資料夾。

```text
node scripts/p0/check-account-isolation.js --repo <repo 路徑> \
  --profile claude=<資料夾 A> --profile claude=<資料夾 B> \
  --profile codex=<資料夾 C>  --profile codex=<資料夾 D>
```

流程：

1. 第一次執行，應全部為 `loggedIn: false`、`configDirMatches: true`、`ready: false`（`readyReasons` 為 `not-logged-in`、`subject-unverified`）。
2. 在 terminal 以對應的環境變數啟動 CLI 並完成原生登入，例如 `CLAUDE_CONFIG_DIR=<資料夾 A> claude`、`CODEX_HOME=<資料夾 C> codex`；兩個同 provider 的帳號可同時開著。
3. 再次執行腳本；兩個同 provider 的 profile 應各自 `subject: actual`，且 `duplicateAccounts` 為空。若兩者實為同一帳號，會列入 `duplicateAccounts`。
4. 在 shell 先設定 `ANTHROPIC_API_KEY` 或 `CLAUDE_CODE_USE_BEDROCK` 等再執行，應看到 `launchBlockers` 與 `credential-from-environment`。

`ready` 只在**所有**項目都已確定時為 `true`：目錄驗證通過、無繼承覆寫、已登入、主體已核實、實際生效目錄**確定相符**（回報缺席或無法解析為未知，原因 `config-dir-unverified`）、無異常、無目錄衝突、無重複帳號。每個 profile 的 `readyReasons` 列出未就緒的原因代碼。

輸出已遮罩：不含 email、組織、token 與目錄路徑；profile 只以 `claude#1` 這類序號標示。腳本以引數陣列呼叫 CLI、不經過 shell 字串拼接（Windows 上為相容 `.cmd` 捷徑使用 shell，引數皆為常數，設定目錄只經環境變數傳遞）。

單元測試：`node --test "test/**/*.test.js"`（53 項，全部使用合成資料；其中 6 項使用真實主機平台與暫存檔案系統，其餘注入平台與模擬的檔案系統）。`.github/workflows/account-isolation.yml` 在 GitHub 託管的 `macos-latest` 與 `windows-latest` 各執行一次。

## 6. 平台支援矩陣

| 項目 | macOS | 原生 Windows |
| --- | --- | --- |
| 設定目錄隔離（空目錄對預設登入） | 已實測 | **未驗證**（runner 未安裝也未登入 CLI） |
| 路徑與環境變數規則（目錄連結、尾端分隔符、空白、Unicode、環境變數名稱大小寫） | 已實測（本機與 CI） | 已在 CI 的 `windows-latest` runner 通過（見 PR 的最新 CI 結果）；此為 GitHub 託管環境，**不是**正式支援版本矩陣內的實機，也沒有 PowerShell／Git Bash 互動驗收 |
| 檢查腳本與 CLI 啟動（`.cmd` 捷徑、PowerShell、Git Bash） | 已實測（macOS） | **未驗證**（CI 只做語法檢查，未執行腳本） |
| 憑證存放位置 | Keychain 項目以目錄為鍵（官方文件） | 官方文件稱位於設定目錄下的 `.credentials.json`；**未實測** |
| 兩個真實帳號並行 | **未驗證** | **未驗證** |

## 7. 尚未驗證項目與阻礙

| 項目 | 阻礙 |
| --- | --- |
| 兩個真實 Claude 訂閱帳號並行、重啟後仍各自登入 | 需要第二個可用的 Claude 測試帳號與使用者本人完成登入 |
| 兩個真實 Codex 帳號並行、重啟後行為 | 需要第二個可用的 Codex 測試帳號與使用者本人完成登入 |
| 兩個不建立 API key 的 Console 登入是否互相覆蓋 | 需要 Console 測試帳號；官方文件已說明不隔離，暫標為**不支援** |
| Codex 憑證庫儲存模式是否依 `CODEX_HOME` 分開 | 需要真實登入並切換儲存設定 |
| Codex API key 變數在實際請求時是否被採用 | 需要實際發出請求；不使用真實 key 測試 |
| Claude `apiKeyHelper` 設定導致的覆寫偵測 | 屬設定檔而非環境變數，尚無檢查 |
| 真實 `rate_limits` 與 `rateLimits` 數值與各 CLI 原生顯示對照 | 需要真實登入與實際用量 |
| Codex `resetsAt` 單位 | 需要真實回應 |
| 原生 Windows 上的 CLI 登入隔離、憑證存放、PowerShell／Git Bash、雙帳號 | 本機沒有 Windows 設備；CI runner 未安裝也未登入 CLI。僅路徑與環境變數邏輯已在 runner 通過 |
| 帳號設定頁、session 儲存、額度閘門與 UI | 不在本 Issue 範圍（P1、P3） |

## 8. PM 決策紀錄

以下為 PM 在 review 中確認的決策（#7 的 review，2026-10-14）：

1. 受管 profile **維持拒絕** provider 預設目錄（`~/.claude`、`~/.codex`）。
2. 繼承到憑證覆寫變數時**維持阻擋啟動**，不在子行程中剔除。
3. 10 分鐘為可調整的讀取 TTL **上限**，且不得跨越已知重置（第 4 節）。
4. 不建立 API key 的 Console 登入**暫列不支援**。
5. #3 保留開放，直到真實雙帳號與 Windows 驗收完成。

注意：目前 GitHub 上的發布與 review 使用同一個 actor，上述 review 是獨立程式檢查的 review 留言，不代表 GitHub 正式 `APPROVE`／`REQUEST_CHANGES` 流程已驗證。
