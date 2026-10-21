# 本機管理者公告

Multiagent 側欄的 **Administrator Broadcasts** 可建立、閱讀與撤回本機公告。目標可選全部、身份組、provider 或一個目前有 terminal 的受管 session；到期可選一小時、四小時、一天或直到撤回。建立與撤回均須在視窗中選擇並確認，不接受命令參數自動授權。

點選列項會以私人虛擬文件顯示全文、版本、目標、建立／到期／撤回時間、狀態讀取時間及送達未知。重新整理或撤回會更新已開啟的詳情。文件沒有專案檔案，`document.save()` 不保存；VS Code API 仍可能改變記憶體 buffer，重新整理會從私人儲存恢復原文。此機制不限制使用者自行複製文字或另存副本，不是 OS 沙箱。

生效中的公告可出現在符合身份組／provider 的有效指令預覽，屬 `user` 層，弱於 `platform`，不會授予工具權限。預覽另列公告來源、版本與到期。公告目前位於擴充套件的本機私人儲存，未增加 repository 範圍；單一 session 目標保存的是當次 session ID，重開所建立的新 session 不會自動繼承它。尚無單一 session 的有效指令預覽入口。

**送達的三種情況，各自的證據不同**：(1) 之後新啟動的 session 會在有效指令中帶入適用的公告（寫進指示檔，不重複送）；(2) 已在執行的 session，用 **Send Broadcast to Agents** 把公告當成一行 prompt 輸入到它的 terminal（見下節）；(3) 確認回條、CLI 是否讀到或遵守仍未接入。保存成功只表示本機記錄存在；「已輸入」只表示文字寫進了該 terminal，不是已收到、已套用或 CLI 會遵守。撤回及到期只影響之後讀取的本機預覽與之後的啟動，**不會撤回已輸入的 prompt 或正在運行的 CLI 內容**。

目前的確認流程不接受 agent 自我宣告 Admin 角色，也不會向 GitHub 發布公告。它不能阻止與使用者有相同 OS 權限的程式直接修改私人檔案；強制隔離仍由 #25／#26 追蹤。公告不能放寬較高層規則；真實 CLI 的接收與權限強制仍未驗證。

Host 測試使用真正指令、私人儲存、列表與文件，加上合成的對話框答案，驗證四種目標、取消不保存、全文閱讀、Save 不寫檔、重新整理及撤回。人工視覺與雙平台實機仍待驗收。#92／#106 保持開啟，下一階段須交付實際啟動接線及逐 session 的準備／送達證據。

## Send Broadcast to Agents（#295）

指令 **Send Broadcast to Agents**（Administrator Broadcasts 標題列）把一則**生效中**的公告輸入到它所針對、正在執行的 agent CLI。和建立、撤回一樣，它**不接受任何命令參數**：公告從畫面上的清單選擇，收件者由公告自己的目標（全部、身份組、provider、單一 session）與各 session 的證據推算，每次都要在視窗中確認「完整 prompt」與名單，不能被參數跳過；也**不是**一般的 VS Code session 指令，只有擴充套件自己的程式能呼叫輸入功能。廣播權限邊界不變：只有使用者在本機互動操作能建立、撤回或送出，agent、PM、MCP 結果或任何 agent 可設定的值都不能。

- **誰會收到，依 CLI 自己的證據分三類**（`src/observations/runtime.js` 的 `deliveryState`，只讀 hook 記錄，不讀 terminal 文字）：
  - **等待輸入 → 預設送**：terminal 開著、CLI 記錄為執行中，**且** Claude Code 的 hook 最後一個事件是 `Stop` 或 `Notification`。這個「等待」**不會 30 秒就過期**（閒置的 agent 不會再送事件）：維持有效，直到下一個 hook（`UserPromptSubmit`／`PreToolUse`／`PostToolUse` 變成工作中，`SessionEnd` 變成已結束）、terminal 關閉、或達到上限 **12 小時**；其他畫面的 30 秒顯示時效不變。
  - **狀態未知 → 預設不送**：沒有 hook 或沒有證據的 session（Codex、agy、自訂 provider、沒有啟用 hook 橋接的 Claude、hook 記錄綁到別的 CLI session、超過 12 小時）。確認視窗把它們**另外列出**，只有使用者另外按**明確的按鈕**（`Also Send to Unknown`，沒有等待中的 session 時是 `Send to Unknown Anyway`；同樣是 modal，不能用參數跳過）才會一併輸入，紀錄標為 `sent-unknown-state`。
  - **一律不送**：terminal 已關閉、CLI 沒在執行（只有 shell 提示字元、已結束）、CLI 忙碌中、已結束。
- **各 provider 的送達條件（目前）**：Claude Code 且有 hook 橋接 → 依上述自動判斷；其他一律是「狀態未知」，需要使用者明確按鈕。實機行為（CLI 是否把輸入當成使用者輸入）仍是 #135。
- **prompt 長什麼樣**：一行，以 `[Administrator broadcast, created <時間>] <內容>` 開頭（第一個字元是 `[`，不會被當成 slash 指令、shell 逃逸或記憶備註）。公告文字本來就是單行、已移除控制字元；輸入前再檢查一次，含換行、escape 序列、零寬或雙向字元、過長的一律拒絕，不經 shell 字串拼接。多行輸入各 CLI 的接受方式未驗證（#135），所以只送單行。
- **確認之後才輸入，且再確認一次**：送出前重新從儲存區讀取這則廣播（對話框開著時被撤銷或改過就**不送**），並重新判斷每個 session 的狀態；只送給「名單上看過、使用者按的按鈕允許、且狀態仍符合」的 session，其餘記為略過。
- **記錄**：每次送出在私人儲存區新增一筆不可改寫的紀錄（只含 session id、provider、已送出／略過與原因，沒有名稱、路徑或帳號），顯示在 Administrator Broadcasts 的列與全文文件（「typed into N sessions, not sent to M」）。

**驗證與未驗證**：host 測試（POSIX）用真正的 VS Code terminal，其「CLI」是把收到的每一行寫進檔案的 `/bin/sh` 迴圈：證明 prompt 以單行進到 terminal 的輸入、確認之前不輸入、狀態未知需要明確按鈕、對話框開著時被撤銷的廣播不輸入、每次送出都有記錄。hook 證據在 host 測試裡由測試提供（沒有真的 hook 橋接在跑）。**未驗證**：真實 Claude Code／Codex 是否把這行當成使用者輸入並開始處理、多行輸入的接受方式、真實 hook 橋接在實機上的事件順序（#135）。
