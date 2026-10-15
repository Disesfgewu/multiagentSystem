# Issue 領取與工作狀態轉移

對應 Issue #16 的本輪切片（本文件隨 PR 以 `Refs #16` 交付，Issue 保持開放）與 `docs/IMPLEMENTATION_PLAN.md` 第 3.6 節。實作位於 `src/work/`，是**純決策核心**：不讀寫磁碟、不連網、不寫入 GitHub。讀取、寫入與本機記錄都由呼叫端以介面注入（`reader`、`writer`、`store`）。

## 1. 狀態與角色

`ready → claimed → in_progress → pr_open → review_pending → changes_requested ⇄ worker_updates → review_pending → pm_passed → ready_to_merge → merged`；`blocked` 可從執行中進入，只有 PM 能解除，解除後回到 `ready`；`closed` 由 PM 或人工結束。`merged`／`closed` 是終點，不接受任何事件，也不留本機記錄。

| 事件 | 從 | 到 | 誰可以 |
| --- | --- | --- | --- |
| `claim` | `ready` | `claimed` | worker、PM |
| `start` | `claimed` | `in_progress` | worker |
| `release` | `claimed`、`in_progress` | `ready` | worker（只限自己的）、PM、人工 |
| `block` | `claimed`、`in_progress`、`pr_open`、`changes_requested`、`worker_updates` | `blocked` | worker、PM |
| `unblock` | `blocked` | `ready` | PM |
| `open_pr` | `in_progress` | `pr_open` | worker（需 PR 編號與 head SHA） |
| `request_review` | `pr_open` | `review_pending` | worker |
| `request_changes` | `review_pending` | `changes_requested` | PM（需 `CHANGES_REQUESTED` 的 review 證據） |
| `worker_update` | `changes_requested` | `worker_updates` | worker |
| `resubmit` | `worker_updates` | `review_pending` | worker（需**新的** head SHA） |
| `pm_pass` | `review_pending` | `pm_passed` | PM（需對**目前 head** 的正式核准） |
| `head_changed` | 有 PR 的各狀態 | `pm_passed`／`ready_to_merge` 回到 `review_pending`，其餘不變 | 系統（需不同的 head SHA） |
| `mark_ready_to_merge` | `pm_passed` | `ready_to_merge` | 系統（需下面所有條件成立） |
| `conditions_failed` | `ready_to_merge` | `pm_passed` | 系統（條件確實不再成立時） |
| `merge` | `ready_to_merge` | `merged` | 人工；PM 只在儲存庫設為 PM merge 時 |
| `close` | 任何非終點狀態 | `closed` | PM、人工 |

沒有列出的組合一律 `illegal-transition`；角色不符 `role-forbidden`；未知的狀態、事件或角色都拒絕，不猜測。**worker 不能定義或改寫需求、審核、核准、merge 或結束 issue**：事件表裡沒有任何建立或修改 Issue 內容的操作，測試以全部「狀態×事件×角色」的組合確認，靜態測試確認 writer 介面只有 `claim` 與 `setLabel`。

## 2. 以證據為準

審查與 CI 的結論只來自注入的證據（形狀同唯讀 adapter 的 PR 快照），**沒有證據、證據過期或值是「未知」一律不放行**：

- `pm_pass` 需要對**目前 head** 的 `approved`；對舊 head 的核准是 `evidence-stale`。新的 commit（`head_changed`）會讓 `pm_passed`／`ready_to_merge` 回到 `review_pending`，並忘記舊的審查種類，所以舊 SHA 的通過不會沿用。
- `ready_to_merge` 需要**全部**成立：head 與記錄一致、快照一致、（正式審查時）核准仍對目前 head、CI 與必要檢查都 `passing`（沒有檢查時 `none`／`not_required` 可以，**未知、進行中、失敗都不行**）、未解決對話為已知的 `0`、沒有合併衝突且可合併性已知。每個失敗各有原因代碼（例如 `checks-unknown`、`threads-unresolved`、`merge-conflict`、`mergeability-unknown`）。
- **GitHub 身份限制（需 PM 決定）**：PM 與 worker 若共用同一個 GitHub 帳號，PM 的 review 不能成為正式核准（作者不能核准自己的 PR）。預設只接受正式核准。設定 `allowInformalPass: true` 時，PM 才可用「對目前 commit 的技術 review 留言」通過，且記錄會標為 `informal`，**不得**宣稱已達成 GitHub 正式 reviewer passed；是否允許由 PM 決定。

## 3. 領取

`claimIssue({ reader, writer, store, repo, issueNumber, role, sessionId, worktree?, branch? })`：

1. 角色只有 worker 或 PM；不符時**連 Issue 都不讀**。
2. 先查本機：同一個 issue 已有記錄（`already-claimed-locally`，或未決的 `needs-reconcile`）、同一個 session 已有別的 issue（`session-busy`，一個 agent 一個當前 issue）。同一行程內同時進行的兩個領取只放行一個（`claim-in-progress`）。
3. **重讀遠端**（強制重新整理）。issue 必須明確是自由的：開啟、不是 PR、沒有 `blocked` 與 `in-progress` 標籤、沒有 assignee、有 `ready` 標籤、有可比對的版本（`updatedAt`）。**讀不到（找不到、無權限、限流、暫時失敗、離線、無效）、回應不完整、欄位缺漏都不當成可領取**。「不完整」的條件在領取與重啟恢復中**完全相同**（一份共用的讀取）：`state` 不是 `open`／`closed`，或 `labels`、`assignees` 不是字串陣列。標籤名稱以**不分大小寫**的同一個正規化比對（GitHub 的標籤不分大小寫，`Blocked`、`In-Progress`、`READY` 與小寫相同）。
4. 寫入前先記下「意圖」（`sync: claiming`），再呼叫 writer，帶上讀到的版本；writer 必須在 issue 已變更時回 `conflict`。
5. `conflict`：撤回意圖、**重新讀取再決定**（已被別人領取就拒絕），最多重試 `maxSyncRetries` 次（預設 2），用完回 `conflict` 與 `syncRequired: true`，**絕不無限重試**。
6. 結果**未知**（逾時、斷線、writer 丟出例外）：**不重試**，意圖留在記錄中（`outcome-unknown`），由 `reconcile` 查明。
7. 寫入成功後**再讀一次**確認：標籤已是領取狀態、沒有 blocked、assignee 不超過一個、版本沒有倒退；否則記為 `conflict` 並停止分派（`conflict-detected`）。讀不回來記為 `unverified`（`claim-unverified`）。

寫給 GitHub 的內容只有：repo、issue 編號、**一個中性狀態標籤**與讀到的版本。**session、worktree、branch 與任何路徑都不會出現**（測試掃描所有寫入與讀取的內容；靜態測試確認 payload 只由一個函式組出）。標籤名稱預設 `ready`／`in-progress`／`blocked`，可設定但只接受簡短的小寫狀態用字（不接受路徑、位址、`@`、識別字）。

## 4. 重啟恢復

本機 `repo + issue → session + worktree + branch` 對應只存本機（`store`，介面為 `list`／`get`／`save`／`remove`；本模組附一個記憶體實作供測試）。`reconcile` 只**讀** GitHub、只改本機記錄，不寫入：

| 本機記錄 | 遠端 | 結果 |
| --- | --- | --- |
| 意圖（`claiming`） | 沒有領取 | `claim-did-not-happen`：清除意圖 |
| 意圖（`claiming`） | 顯示已被領取 | `needs-confirmation`：**不假設是自己的**（同一個 GitHub 帳號無法分辨），等人確認，期間不能再領取 |
| 已確認 | 仍顯示領取 | `confirmed` |
| 已確認 | 不再顯示領取（被 PM 交還） | `claim-lost`：移除記錄，之後可重新領取 |
| 已確認 | 被設為 blocked | `remote-blocked`：記錄轉為 `blocked` |
| 任何 | issue 已關閉 | `closed-remotely`：移除記錄 |
| 任何 | 多於一個 assignee | `conflict-detected`：標記衝突，**不會因為再看一次而自動解除** |
| 任何 | 讀不到，或回報 ok 但缺少判斷所需的欄位 | `could-not-read`：保留記錄並標為 `unverified`（意圖維持 `claiming`），什麼都不假設；**缺漏的欄位不會被補成空值**，所以不會被當成「已關閉」或「已被交還」而刪掉唯一的本機對應 |

`advance` 推進狀態：用狀態機檢查，狀態改變會改變對外的中性標籤時**先寫遠端、成功後才改本機**，所以不會出現本機說「已釋放」而 GitHub 仍顯示「已領取」；寫入被拒絕，本機維持原狀；結果未知，記錄標為 `unverified`。只有持有該 issue 的 worker 能推進它（`not-owner`）；記錄不是 `confirmed` 時，只有 PM 或人工能用 `release`／`close` 處理。

## 5. 未驗證與限制（不宣稱通過）

- **角色只是呼叫端傳入的參數，這個核心不驗證「呼叫者真的是 worker 或 PM」。** 事件表限制了某個角色能做什麼，但沒有任何機制確認傳進來的 `role` 是真的；要強制必須靠 #14（身份組與工具權限）與 #24（broker 只對對的身份放行寫入）。不要把這裡的「角色不符就拒絕」讀成已經強制。
- **同一個 GitHub 帳號重新領取偵測不到。** 本機記錄為 `confirmed` 的領取，如果在遠端被交還後，又被**別的客戶端以同一個 GitHub 帳號**重新領取，而兩次 `reconcile` 之間沒有觀察到釋放，本機仍會顯示 `confirmed`（遠端的標籤與 assignee 看起來完全一樣）。這是同帳號固有的限制，不是這個核心能解決的，屬於 #4 的未驗證範圍。

- **跨客戶端互斥沒有被證明。** 這個核心用版本檢查與寫入後讀取來偵測**看得見**的衝突並停止分派；兩個客戶端若同時寫入同樣的標籤與 assignee，從 GitHub 看不出差別，**偵測不到**。真實 GitHub 上的雙客戶端領取競態（#4）**未驗證**，不得宣稱已防住。writer（#24 的 broker）必須提供「issue 自讀取後已變更就拒絕」的語意；本模組只依賴它，沒有驗證任何真實 writer。
- 沒有任何對 GitHub 的寫入實作，也沒有持久化的 `store`（只有記憶體實作）；真實儲存與 `sessions` 之外是否新增集合，留給整合時決定。
- 擁有權只以 `sessionId` 相等判斷；session 在重啟後是否保持同一個 id，屬 #11 的整合。
- 沒有畫面；也沒有決定「誰」呼叫這些函式（編輯器入口屬後續整合）。
- 證據的形狀是依 adapter 的 PR 快照假設的，尚未與真實 GitHub 的各種回應對照。
- Windows 只由 CI（GitHub 託管環境）驗證，不是正式支援矩陣內的實機驗收。

## 6. 驗證

```
node --test test/work/*.test.js
```

CI（`.github/workflows/work-state.yml`）在 macOS 與 Windows、Node 20 與 24 執行。
