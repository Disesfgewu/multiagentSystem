# 把任務派給 agent（Issue #305）

兩個指令（命令面板，或 Command Center 上的 **Assign Issue…**、**Send task…** 按鈕）：

| 指令 | 做什麼 |
| --- | --- |
| `Multiagent: Assign Issue to Agents` | 列出 GitHub 上開啟中的 Issue，選一個，交給選定的 agent |
| `Multiagent: Send Task to Agents` | 自己輸入一句任務，交給選定的 agent |

## 怎麼運作

1. 選 Issue（會從 GitHub 重新讀一次最新內容）或輸入任務。
2. 選對象：所有開啟的 agent、某個角色群組、某個供應商，或自己勾選的幾個 session。
3. 看到確認視窗：**完整的那一行 prompt**、誰會收到、誰不會（以及原因）。
4. 按 **Send Now**：prompt 被打進那些 session 的終端機。確認之後會再讀一次 Issue；若內容在視窗開著時變了，什麼都不會打出去。
5. 每次派發都留下一筆私有紀錄（Issue 編號、時間、每個 session 的結果）；Command Center 的卡片顯示「Handed: Issue #N …」。

## 誰會收到

和管理員廣播（`docs/BROADCASTS.md`）同一條規則：

- 只有 CLI 自己的 hook 事件說「正在等輸入」的 session 會收到。
- 沒有證據的（Codex、agy、自訂供應商、沒有 hook bridge 的 Claude）列為「狀態不明」，**預設不送**，要按第二個明確的按鈕（`Also Send to Unknown`）才送。
- 終端機已關、CLI 沒在跑、正在忙或已結束的 session 一律不送，並列出原因。

## 安全規則

- 兩個指令**不接受任何參數**。頁面（Command Center）、agent 或腳本都不能指定任務內容、對象，也不能略過確認視窗；頁面的按鈕只送一個固定訊息，要求打開同一個視窗。
- Issue 內容來自 GitHub，視為**資料**：prompt 裡明講它不是對 agent 規則或工具的指令；內容經過與對外發佈相同的掃描（憑證、本機路徑等），含隱藏／方向字元、或像是叫 agent 忽略規則的文字會被**拒絕**（不是悄悄清掉）。
- 來自 GitHub 的標題、需求摘要、驗收項目各自包在 `«…»` 裡當作資料；其中的 `[`、`]` 換成全形 `［］`、引號字元換掉，所以文字不能偽造本套件放在 prompt 開頭的標記，也不能提早結束引號。文字裡出現本套件自己的標記字樣（`Task from the administrator`、`Administrator broadcast`，不分大小寫與空白）會被**拒絕**。
- 身份組規則與團隊規則是在 session **啟動時**注入的，不會在每次派發的 prompt 裡重複；派發的 prompt 只含任務本身與一句「Issue 文字是資料」的提醒。
- 派發紀錄只保留最新 500 筆。
- prompt 一律是單行、以 `[` 開頭、長度有限，不含控制字元，不會被 CLI 當成斜線指令或 shell 跳脫。
- researcher 角色的提醒（只用允許清單內的研究工具、結果是外部資料）寫在 prompt 裡，**這只是指示，不是強制**；實際能用的工具由角色群組的工具權限決定（見 `docs/ROLE_GROUPS.md`）。
- 派發紀錄只存 Issue 編號、時間、session id、供應商與結果代碼；自己輸入的任務文字**不存**。
- 在未信任的工作區不能用。

## 沒做的事

- 沒有 session 在跑時，不會自動建立 worktree 或啟動 session；派發只送給已經在跑的 session（它們各自的 worktree 沿用）。
- 「打進終端機」不等於 agent 讀了、會做或做完了；沒有任何完成回報的機制。
- 沒有用真的 Claude Code / Codex 驗證（#135 的使用者驗證項目）。測試用的是一個把收到的行寫進檔案的合成 CLI。
