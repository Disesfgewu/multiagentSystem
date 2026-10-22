# 指揮台（Command Center）

指令 **Open Command Center**（Overview 標題列的按鈕，或 Command Palette）在**編輯區**開啟一個 webview 分頁（不是側欄），讓使用者以專案總負責人的角色，一眼看到每個 agent 的狀態與額度。這一版以**顯示**為主：它顯示資料、提供「聚焦 terminal、開啟報告」等導覽，以及**帳號面板上的帳號操作**（見下，每一項都是既有的帳號指令），以及派送任務（Assign Issue to Agents、Send Task to Agents，#316）與匯出 Markdown 報告（#318）。開會與和 PM 討論還沒有做（#308）。

## 畫面

- **左側固定的 PM 面板**：角色為 `pm` 的 session 卡片，加上「待決策事項」。待決策數量來自 Issues Report／PRs Report **已完整讀取**的清單；清單還沒讀過（或讀不完整）時顯示「unknown（open the report list to load it）」並提供按鈕，**不顯示猜測的數字**。
- **每張卡片（含 PM）都有兩段固定的內容**：**Worktree** 一行（Git 當下讀到的變更與領先／落後，讀不到就是 unknown），以及 **Latest report**：這個 agent 的 pull request 的最新報告摘要——PM 報告的狀態（current／STALE／尚無結構化 PM 報告／unknown）與它寫的「User can」「Next」、最新 head 上的正式核准、CI 與未解決的討論串數量。摘要與完整報告用同一套檢查（`summarizePullRequest`），**不會比完整報告多說**；沒有連結的 PR 就是「none」，還沒讀到是「not loaded yet」，讀不到是「unknown」。讀取由報告模組做並**快取一分鐘**（每次最多 12 個 PR），不會因為畫面常更新就一直讀 GitHub。
- **右側其他 agent 的卡片**（worker、researcher、沒有身份組的 session…）：身份組、provider、帳號、請求的模型（標明「requested, not confirmed」）、狀態、正在處理的 Issue／PR、額度（最多兩行）、自動模式標示、以及可展開的「Evidence and details」（Branch、CI、worktree 變更摘要等，來自 Overview 已經算好的證據行）。
- **帳號與額度面板（#304）**：每個帳號一列：provider 與標籤、登入狀態（`sign-in checked`／`needs attention`／`not checked in this window`）與**核實的身分**（只顯示指紋，來源是 CLI 自己的回報，未核對就是 unknown 並寫原因）、方案（Codex）、**5 小時與每週視窗**各自的已用百分比、可信度（verified and current／estimate／out of date／unknown）、重設時間（「resets in 2h 5m」，已過就說已過）、讀取時間與來源、你設定的上限、以及**目前指派給哪些 agent**。**讀不到時不顯示 0**，而是寫原因（沿用額度表的說法，例如「usage bridge not enabled」「no Codex session log yet」）、一句下一步提示，以及能點的下一步按鈕（例如「Enable the Claude status line bridge」）。額度接近警示／需確認／被擋時，該帳號列、PM 面板的「Quota alerts」與該帳號底下的 agent 卡片都會提醒。
- **帳號操作**（`accountAction`，只有這幾個）：**Add account**、**Sign in**、**Check sign-in**、**Set limits**、**Token usage log**、下一步按鈕（Configure status line bridge／account details）。每一項都是**既有的帳號指令**，只帶這個帳號的 id，所以各自保留原本的確認視窗（登入要確認、設定上限的對話框…）；**沒有任何操作能移除帳號、改憑證或送出東西**；新增帳號不帶 id，其他操作的 id 必須是畫面上的帳號。
- 版面可切換**格狀／清單**；卡片可**拖曳排序**、**收合**、**釘選**（釘選的排最前）；排列方式記在 workspaceState（`commandCenter.layout`），只存模式與 session id。空間不足時，PM 面板改到上方，其餘卡片可捲動。

## 狀態怎麼來（不猜）

卡片的狀態（working／waiting／ended／unknown）只來自 CLI **自己的 hook 事件**（`SessionObservationRuntime.deliveryState`，最後一個事件持續有效到下一個事件、terminal 關閉或 12 小時）。沒有 hook 證據（Codex、agy、自訂 provider、沒有啟用 hook 橋接的 Claude）一律顯示 **state unknown** 與原因；**存在 terminal 不等於 agent 在工作**。其他欄位同樣：沒有來源就是 unknown，不顯示假資料或「0」。

## 安全

- **內容安全政策**：`default-src 'none'`，只允許帶 nonce 的一支 script 與一段 style；不載入任何外部資源、沒有 inline 事件處理、沒有 inline style 屬性、沒有 frame 或表單；每次開啟產生新的隨機 nonce。
- **頁面是靜態的**，不含資料；資料由擴充套件以訊息送入，頁面只用 `createElement`／`textContent` 繪製，所以 GitHub、agent 輸出、session 名稱或帳號標籤的內容**一律是純文字**，不會被當成 HTML（測試以含 `<img onerror>` 的內容實際執行頁面 script 驗證）。
- **訊息白名單**：頁面只能送 `ready`、`refresh`、`setLayout`、`reorder`、`toggleCollapse`、`togglePin`、`focus`、`openReport`、`openPullRequest`、`openReports`、`accountAction`；每個訊息只能帶它自己的欄位、型別正確、id 必須是畫面上的卡片，多一個欄位或未知指令一律整筆拒絕。**頁面沒有任何方式停止、啟動、送出、發佈或執行任意指令**；聚焦、開報告與帳號操作都沿用既有指令，各自的確認不受影響。
- 不寫入工作區或 repo：只有 workspaceState 的排列。

## 未驗證

- 真實 VS Code 視窗中的人工視覺檢查、拖曳在不同平台的手感，以及 webview 的實際繪製（host 測試證明分頁存在、CSP 在頁面中、卡片資料與訊息處理；頁面 script 的繪製與拖曳邏輯以 Node 的假 DOM 執行驗證）。
- 在真實 CLI 與真帳號上狀態與額度的顯示：#135。
