# 指揮台（Command Center）

指令 **Open Command Center**（Overview 標題列的按鈕，或 Command Palette）在**編輯區**開啟一個 webview 分頁（不是側欄），讓使用者以專案總負責人的角色，一眼看到每個 agent 的狀態與額度。這一版是**只讀**：它顯示資料並提供「聚焦 terminal、開啟報告」等導覽；派任務、廣播、開會等動作由 #304～#308 接上。

## 畫面

- **左側固定的 PM 面板**：角色為 `pm` 的 session 卡片，加上「待決策事項」。待決策數量來自 Issues Report／PRs Report **已完整讀取**的清單；清單還沒讀過（或讀不完整）時顯示「unknown（open the report list to load it）」並提供按鈕，**不顯示猜測的數字**。
- **右側其他 agent 的卡片**（worker、researcher、沒有身份組的 session…）：身份組、provider、帳號、請求的模型（標明「requested, not confirmed」）、狀態、正在處理的 Issue／PR、額度（最多兩行）、自動模式標示、以及可展開的「Evidence and details」（Branch、CI、worktree 變更摘要等，來自 Overview 已經算好的證據行）。
- **帳號列**：每個帳號的用量行與是否被額度門檻擋住。額度接近警示／需確認／被擋時，該帳號底下的 agent 卡片會顯示提醒。
- 版面可切換**格狀／清單**；卡片可**拖曳排序**、**收合**、**釘選**（釘選的排最前）；排列方式記在 workspaceState（`commandCenter.layout`），只存模式與 session id。空間不足時，PM 面板改到上方，其餘卡片可捲動。

## 狀態怎麼來（不猜）

卡片的狀態（working／waiting／ended／unknown）只來自 CLI **自己的 hook 事件**（`SessionObservationRuntime.deliveryState`，最後一個事件持續有效到下一個事件、terminal 關閉或 12 小時）。沒有 hook 證據（Codex、agy、自訂 provider、沒有啟用 hook 橋接的 Claude）一律顯示 **state unknown** 與原因；**存在 terminal 不等於 agent 在工作**。其他欄位同樣：沒有來源就是 unknown，不顯示假資料或「0」。

## 安全

- **內容安全政策**：`default-src 'none'`，只允許帶 nonce 的一支 script 與一段 style；不載入任何外部資源、沒有 inline 事件處理、沒有 inline style 屬性、沒有 frame 或表單；每次開啟產生新的隨機 nonce。
- **頁面是靜態的**，不含資料；資料由擴充套件以訊息送入，頁面只用 `createElement`／`textContent` 繪製，所以 GitHub、agent 輸出、session 名稱或帳號標籤的內容**一律是純文字**，不會被當成 HTML（測試以含 `<img onerror>` 的內容實際執行頁面 script 驗證）。
- **訊息白名單**：頁面只能送 `ready`、`refresh`、`setLayout`、`reorder`、`toggleCollapse`、`togglePin`、`focus`、`openReport`、`openPullRequest`、`openReports`；每個訊息只能帶它自己的欄位、型別正確、id 必須是畫面上的卡片，多一個欄位或未知指令一律整筆拒絕。**頁面沒有任何方式停止、啟動、送出、發佈或執行指令**；聚焦與開報告沿用既有的 Overview 指令。
- 不寫入工作區或 repo：只有 workspaceState 的排列。

## 未驗證

- 真實 VS Code 視窗中的人工視覺檢查、拖曳在不同平台的手感，以及 webview 的實際繪製（host 測試證明分頁存在、CSP 在頁面中、卡片資料與訊息處理；頁面 script 的繪製與拖曳邏輯以 Node 的假 DOM 執行驗證）。
- 在真實 CLI 與真帳號上狀態與額度的顯示：#135。
