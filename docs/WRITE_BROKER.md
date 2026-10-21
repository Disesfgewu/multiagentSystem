# GitHub 寫入 broker 核心

`src/broker/broker.js` 是所有受管 GitHub 寫入的單一入口。這一版只有核心：身份、reader、內容來源、transport、審計與鎖**全部由呼叫端注入**，沒有真實 GitHub 連線。模組不儲存、不讀取、不記錄任何 GitHub 憑證；憑證只應由 transport 持有，terminal 不取得。

## 每個請求的流程

1. 請求形狀：`operation` 必須在 allowlist（`createIssue`、`editIssue`、`claimIssue`、`createPr`、`commit`、`push`、`comment`、`reviewPr`、`mergePr`），預設全部拒絕；`requestId` 為 8–64 字元；欄位逐項驗證，未知欄位拒絕；請求中不得帶 `actorId`、`role`、`token`、`credential`、`authorization`、`password`、`secret`、`headers`。
2. 身份：`identity.current()` 回傳可信的 `{ actorId, role }`，取不到或格式不符即 `identity-unverified`。角色與身份分離交由 `src/publish-policy.js`（commit、push、comment 以同角色的替代操作檢查）。
3. 冪等：同一身份與 `requestId` 的完成結果會重播（`replay: true`），不再寫入；同 ID 不同內容為 `request-id-conflict`；同時進行中為 `request-in-progress`。結果不明（transport 例外或回傳格式不明）記為 `outcome-unknown`，**不自動重試**；transport 明確拒絕則未發布，可修正後重送。
4. 內容掃描：新文字（Issue／PR 標題與內文、留言、review）掃描請求內的原文；commit、push、PR 的訊息與 diff 取自可信的 `content.getCommitContent(headSha)`（必須完整且 head 相符），不接受呼叫端自帶的 diff。掃描未通過、錯誤或過大都不寫入（每個文字欄位上限 262,144 字元，超過回 `invalid-field`）；每個會送給 transport 的文字欄位都在掃描單位內（含 `createPr` 的 `baseBranch`），測試會把合成 token 輪流放進每個操作的每個文字欄位；`scanOptions` 只能提供 `memories`、`rules`、`knownValues`，含其他鍵（如 `detectors`）的設定在建構時拒絕，也不會被傳給掃描器；沒有任何私人素材可比對時，除非明確設定 `privateReferencesChecked: true`，否則拒絕。**傳給 transport 的就是被掃描的文字。**
4a. **署名行一律拒絕**（#293）：`createIssue`／`editIssue`／`createPr`／`comment`／`reviewPr` 的文字欄位，以及 commit／push／PR 的 commit 訊息，只要有任何一行（不分大小寫、忽略行首空白與零寬字元）是 `Co-authored-by:`，或含 `Generated with Claude Code`，就回 `co-author-forbidden`，並用 `problems` 指出欄位與行號（不回傳該行文字）；**不改寫**使用者的文字。diff 內容不檢查（diff 可能合法地含有這些字，例如這條規則的測試）。`push` 與 `createPr` 另外檢查「範圍內每個 commit」：`content.getRangeMessages({ headSha, baseBranch? })` 必須回完整、head 相符、非空且每筆有 SHA 與訊息的清單，有 trailer 的 commit 以短 SHA 列出；讀不到、不完整、沒有這個方法都回 `content-unverified`（fail closed）。比對的是形狀：看起來相似的字元或拆成兩行的寫法偵測不到，仍需要人工審查與 repo 層的檢查。共用的判斷在 `src/publish/attribution.js`。
5. 前置條件：領取需取得單一寫入者鎖後重讀 Issue（開放且無人受理）；review 重讀 PR，head 必須等於 `expectedHeadSha`，並套用不得自我 review 的規則；merge 委派給 `src/delivery/merge.js`（強制重讀、綁定 head、掃描、預期 head SHA）。
6. 審計：寫入前先記一筆 `intent`，審計不可用即不寫入；寫入後記 `result`。審計項目只有操作、requestId、actorId 與內容指紋，不含內容。

## 各操作預期需要的權限（僅為預期，未對真實 GitHub 驗證）

`EXPECTED_PERMISSIONS` 列出每個操作預期需要的 GitHub App／帳號權限，供人工與實際設定核對：Issue 類 `issues:write`；建立 PR `pull_requests:write`、`contents:read`；commit／push `contents:write`；留言 `issues:write` 或 `pull_requests:write`；review `pull_requests:write`；merge `pull_requests:write`、`contents:write`。最小權限範圍尚未驗證。

## 限制（請勿過度宣稱）

- **接上任何真實 transport 之前的硬前置條件（PM 決策）**：冪等與審計紀錄必須存進 `PrivateStore`（不在 repo），讀取失敗時 fail closed（無法確認是否已送出就拒絕，不得重送），並有重啟後不重複寫入的測試。目前紀錄只在記憶體，新的實例以同一 `requestId` 重送會再寫一次。
- 領取以鎖加強制重讀實作，只在同一個進程內有效；GitHub 的最終一致性可能讓緊接著的第二次領取看不到剛寫入的指派，跨客戶端競態屬 #4 的未驗證項目。
- 輸入大小目前只有每個文字欄位的上限，沒有總量上限與掃描時間預算（掃描器的預算見 #86）。

- 這個模組不能阻止 agent 直接執行 `git`、`gh` 或 HTTP 寫入；那屬 #25／#26 與 #4 的隔離與驗證，這裡不宣稱已防外洩。
- 冪等紀錄與審計都在記憶體／注入的 sink，重啟後的恢復屬呼叫端。
- 真實 GitHub 的競態（領取、head 變化）以注入的 reader／transport 模擬，未對真實服務驗證。
- commit、push 在 `comment` 與 `commit`／`push` 的角色規則（worker／PM 皆可留言，只有 worker 可 commit、push）是本切片的設計，不在 `publish-policy.js` 原有表內，請 PM 確認。
