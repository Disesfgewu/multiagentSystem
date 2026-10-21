# 額度門檻與分派政策

`src/accounts/quota-policy.js` 決定「一個新任務是否可以在某個帳號上開始」。它不會把執行中的 agent 換到另一個帳號，也不會自己挑選帳號。這是純模組：輸入是注入的政策、該帳號的觀測（`src/accounts/observation.js` 的輸出）與目前時間，不讀檔、不執行 CLI、不連網。

## 政策（每個帳號設定一份）

| 欄位 | 說明 |
| --- | --- |
| `warnAtPercent` | 任一有可信資料的時間窗已用百分比達此值時警示（仍可分派）。 |
| `blockAtPercent` | 達此值時暫停新任務；使用者可明確覆寫（`approval: 'override'`）。須不小於 `warnAtPercent`。 |
| `maxConcurrent` | 給定帳號 key 的同時運行上限（1–64）。達上限即阻擋，**覆寫不能解除**。核心目標為實際帳號；目前畫面以同視窗的帳號設定檔為 key，實際帳號去重尚未接線。 |
| `unknownQuota` | 沒有任何可信額度資料時：`require-confirmation`（預設，需明確確認）或 `block`（禁止新任務，使用者可明確覆寫）。 |

沒有設定的欄位代表沒有該限制。政策存在私人儲存的 `policies` 集合，一個帳號一筆（`savePolicy`／`loadPolicy`）；儲存中的資料無效時回報錯誤，不會退回預設。

## 什麼資料能成為硬性門檻

只有「服務端回報、仍在有效期限內、不是未來時間」的讀數（`isGateEligible`）。估算值、已過期（含已過重置時間）、缺漏或超出範圍的讀數只能提示（`window-unverified`、`unverified-reading-over-warning`），不能阻擋，也不能因此判定額度充足。所有時間窗都沒有可信資料時，額度為未知，依 `unknownQuota` 處理。尚無已驗證用量來源的 provider（目前如 `agy`，見 [Provider 登錄](PROVIDERS.md)）因此一律走「額度未知」，不做估算。

## 並行分派

`QuotaDispatcher.reserve` 在同一個同步步驟內判斷並佔用名額，兩個同時要最後一個名額的請求不會都成功；`release` 可重複呼叫，重複釋放不影響結果。名額以呼叫端給的 `accountKey`（實際帳號）計算，指向同一實際帳號的多個設定檔應使用同一個 key，不得重複計算額度；`externalRunning` 讓呼叫端加上不在這個 dispatcher 內的執行中 agent。

## 限制（請勿過度宣稱）

- 服務端額度會在兩次讀取之間變動，這個政策**不能保證阻止所有超額請求**。
- 已有純邏輯與 Extension Host 正式命令／原生 terminal 測試；真實額度來源、真帳號與人工操作仍未驗證。
- 名額只存在單一 Extension Host 記憶體；重啟後恢復的 session 都是 unknown，沒有重新附著舊 terminal，不能宣稱已計入其他視窗或舊進程。
- 帳號清單／詳情與確認 UI 已接線，數值額度仍為未知。同一實際帳號的多個設定檔尚未去重，跨視窗／跨機器並行亦未整合，因此 #20 維持未完成。

## 畫面與啟動前的閘門

- **設定**：帳號清單的 ⚙「Set Account Limits」（或命令列）依序詢問警示％、暫停新任務％、同時運行上限與額度未知時的處理（預設「先問我」），經 `PrivateStore` 儲存；欄位驗證不通過會用白話說明。設定只影響之後啟動的 agent，不改變已在運行的。
- **顯示**：帳號 tooltip 與詳情顯示目前的門檻（沒有設定就是「沒有限制，新 agent 永遠不被擋」）與各時間窗的用量（來源、讀取時間、可信度、重置時間）。**目前沒有任何已驗證的用量來源接上，所以一律顯示「用量未知」與原因，不顯示百分比。**
- **啟動前**：所有以帳號啟動的路徑（啟動帳號、從身份組啟動、啟動命令）都會先過 `gateAccountLaunch`：沒有設定門檻的帳號不受影響；達到暫停門檻、額度未知（依設定）時說明原因，使用者可明確選「Start Anyway」／「Override and Start」；**同時運行上限不能覆寫**；無法詢問的呼叫者（非互動）一律被拒絕；已存的門檻無法讀取時停止啟動（fail closed）。
- 同一視窗內，每個受管帳號 session 都保留追蹤名額，包含尚未設 limits 的啟動及 shell-only terminal；之後才設定上限、清除再設定，都不會漏算既有 session。名額也包含已核准而尚未完成啟動的請求；失敗、取消、停止或 terminal 關閉會釋放，避免兩個請求都拿到最後名額。
- 所有帳號 start／role launch／reopen 均走同一 gate。確認後重新讀取政策、觀測與時間；政策已變更時拒絕舊確認並要求重試。不修改現有任務或暗中切換帳號。
- terminal 在 snapshot 保存完成前關閉時，啟動結果顯示當下已關閉狀態，未移交的名額由 finally 釋放，不留下失效 reservation。
- 帳號清單顯示目前阻擋／待確認狀態與原因，可使用 Set Account Limits 調整。跨視窗、跨機器與未受管 CLI 不在目前計數內。

## 帳號的額度列與 Token 用量紀錄（#294）

- **額度列**：Accounts and Sessions 的每個帳號可以展開，內容是這個帳號的額度：使用者設定的上限（警示、阻擋、並行上限、額度未知時的處理）、目前讀數（已用、剩餘、時間窗與重設時間、讀取時間、來源與可信度，真實、估算或未知）、目前會不會被擋，最後一列「Token usage log」點擊後開啟該帳號的用量紀錄。讀不到時寫明原因，**不顯示 0**。
- **Token 用量紀錄**：每次 provider 真正回報 token 用量（目前只有 Claude Code 經 status line，`docs/ACCOUNT_PROFILES.md`），就把一筆追加到擴充套件**私人儲存區**中該帳號的紀錄（`usageLog` 集合，每個帳號一筆記錄）：時間、session、provider、模型（有回報才記）、輸入／輸出／快取讀／快取寫 token、費用（有回報才記）、`actual` 或 `estimate` 標記、來源代碼。**不記錄 prompt、檔案路徑或憑證。**同一個 session 同一時間的讀數只記一次；每個帳號最多保留最近 150 筆且不超過 30 天，超過就輪替。紀錄無法讀取時顯示錯誤，不當成空的。
- **沒有真實來源的 provider**（目前 agy；Codex 見下節）：讀數是未知，**不寫入**（不寫 0、不用估算冒充）；紀錄畫面說明這一點（Codex 的額度與最後一次請求的 token 見「Codex 的真實額度來源」，只在 Codex 的本機 session 紀錄有資料時才記）。本機估算的數字（例如 Claude 的費用估算）會標為「ESTIMATE」。
- **指令**：**Show Token Usage Log**（唯讀文件，可選全部帳號或單一帳號）與 **Export Token Usage Log (masked)**（在未命名的編輯器開啟 CSV 或 JSON，帳號與 session 都被遮罩成 `account-1`、`s-xxxxxx`，不含標籤、id 或路徑；CSV 中會被試算表當成公式的儲存格以 `'` 開頭保持為文字；擴充套件不會自己寫檔，要不要儲存由使用者決定）。
- **未驗證**：Claude Code 的 status line 讀數在真實帳號上是否持續回報、費用估算與真實帳單的差距、重啟後的紀錄行為都未經真機驗證（#135）。紀錄只涵蓋這個擴充套件啟動、而且有讀數來源的 session，不涵蓋使用者自己在別處開的 CLI。

## Codex 的真實額度來源：本機 session 紀錄（#302）

**來源**：Codex CLI 把每個 session 寫成 `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`；其中 `type: "event_msg"`、`payload.type: "token_count"` 的事件帶有 `payload.rate_limits`（`primary`／`secondary` 各有 `used_percent`、`window_minutes`、`resets_at`（epoch 秒））、`plan_type`，以及 `payload.info.last_token_usage`。這是**本機的唯讀檔案**，不連網、不需要憑證；每個 Codex 帳號用自己的 `CODEX_HOME`（帳號設定檔的資料夾），所以逐帳號讀取（`src/accounts/codex-rate-limits.js`）。macOS 與 Windows 的格式相同（查證是在 macOS 上做的，Windows 沒有實跑）。

**怎麼讀（唯讀、有上限）**：只開 `sessions` 底下符合 `rollout-*.jsonl` 的檔案，**絕不開 `auth.json`** 或帳號資料夾裡的其他檔案（測試記錄實際被開啟的路徑）；每一層都用 `lstat` 檢查，連結與非一般檔案不跟隨、不讀；只看最新的幾個檔案、從檔尾往回最多讀 256 KB、超過 64 KB 的單行略過；只保留上面那幾個數字與短代碼（方案名稱要符合短代碼格式），**不保留 prompt、輸出文字、路徑或其他欄位**。

**視窗怎麼命名**：依 `window_minutes`：300 是 5 小時窗（顯示為 `five_hour`）、10080 是一週窗（`seven_day`）；其他長度**不猜**，整筆視為「格式未認得」。與 Claude 共用同一套門檻判斷：`resets_at` 已過的視窗不能用來擋人、也不能判定額度充足；缺少或無效的 `resets_at`、超出 0–100 的百分比、型別錯誤、事件時間在未來，一律是未知，**不寫 0**；來源標為 `actual`、代碼 `codex session log rate_limits`。

**時效**：這是「最後一次有活動時的快照」，不是現在的即時額度。讀數沿用一般的有效期限（10 分鐘，且不超過重設時間），之後畫面顯示「out of date (not used to block)」而不是當成目前的數字；Codex 沒有在跑時它就會是過期的，這是設計，不是壞掉。

**畫面與用量紀錄**：Accounts 的額度列展開後顯示兩個視窗、重設時間、方案（`Plan: plus (reported by the Codex session log)`）與來源；讀不到時說明原因（`no Codex session log yet`、`no usage in the Codex log yet`、`Codex log format not recognized`、`last Codex reading is out of date`、檔案不可讀或不安全…）。每次讀取同時把**最後一次請求**的 `last_token_usage`（輸入、快取讀取＝`cached_input_tokens`、快取寫入、輸出；`reasoning_output_tokens` 已含在輸出內不另算）以 `actual` 追加到 token 用量紀錄，同一個事件只記一次；只涵蓋讀取當下的最後一個事件，中間的請求不會逐一補記。

**限制（請勿過度宣稱）**：這個格式**不是 OpenAI 公開承諾的 API**，Codex 改版時可能改變，屆時欄位對不上就 fail closed 成未知，不會猜。真實帳號上的讀數是否與 Codex 自己顯示的額度一致、Windows 路徑，都未經驗證（#135）。
