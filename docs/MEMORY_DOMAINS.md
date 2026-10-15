# 記憶的隱私域、生命週期與預算

對應 Issue #21 的本輪切片（本文件隨 PR 以 `Refs #21` 交付，Issue 保持開放）。實作**擴充**既有的 `src/memory/store.js`（候選→採納、敏感掃描、TTL、來源變更），沒有另寫記憶庫；新增 `src/memory/domains.js`。沒有新增任何套件，沒有修改 `paths.js`、鎖（`src/shared/lock.js`）或 `sensitive.js`。記憶全部只存本機，不進 repo、不進 GitHub。

## 1. 隱私域：預設各自一域，跨域分享要明確授權

記憶以 `repoId + roleGroupId + privacyDomain` 分區。讀取時 repo 與身份組**完全相符**；隱私域預設也完全相符，只有被明確授權的域例外。

- **預設每個帳號各自一域**：`defaultDomainFor(accountProfileId)` 回傳 `account:<id>`（id 不分大小寫），兩個帳號預設不共享。
- **同一信任邊界內的帳號可以歸在同一域**：`accountDomains: { '<accountProfileId>': '<domain>' }`，是明確的設定，沒設定的帳號維持自己的域。
- **跨域分享是授權（grant）**：`grants: [{ reader: 'b', source: 'a' }]` 讓域 `b` 讀取域 `a` 的記憶，**僅此而已**。它**有方向**（`a` 不能讀 `b`）、**不傳遞**（`c` 讀 `b` 並不會讀到 `a`）、**預設不存在**。授權只來自建構 `MemoryStore` 時給的政策（`createDomainPolicy`），**不能經由 `select` 的參數**，所以呼叫端無法自己擴大讀取範圍。授權**不涵蓋** repo 與身份組：跨 repo、跨身份組的分享需要另外設計（#22 之後），目前一律拒絕。
- **設定寫錯就沒有政策**：`createDomainPolicy` 對無法理解的設定（未知欄位、非法的域名、重複或指向自己的授權、超過 100 條授權或 200 個帳號指派）丟出 `TypeError`（只說欄位，不重複值），不會退化成「分享更多」。政策建好後凍結，之後改動原本的設定物件不影響它。
- **域名是簡短的小寫標籤**：`[a-z0-9][a-z0-9._:-]{0,63}`，不能是 email、路徑、萬用字元或帳號名稱；寫入與讀取都檢查。
- **政策出錯或回答不對時只剩自己的域**：政策丟例外、不是陣列、第一項不是讀取者自己的域、含非法域名，一律只回傳讀取者自己的域。
- **被分享的記憶會標示**（`sharedFrom: <域>`）；自己域的記憶沒有這個欄位。
- 一個限制要明說：儲存庫**不知道呼叫者是誰**——`propose` 寫入哪個域由呼叫端決定，這裡不驗證呼叫端有沒有權寫入那個域；帳號與域的對應由呼叫端（身份組／帳號服務）負責。

## 2. 什麼可以被讀取

只有**已採納、沒有停用、沒有過期**的記憶可以被讀取。候選、被拒絕、待複核（`stale`）、被隔離（`quarantined`）、停用、過期的，包含來自被分享的域的，一律不可讀。

- **過期 fail closed**：驗證時間或存活時間缺漏、型別不對（`null`、文字、`NaN`、無限大）、無法解析，都視為過期，不會「永遠有效」。（發現於測試：JavaScript 會把 `null` 的存活時間當成 0，在驗證的同一瞬間仍判定為未過期，這是既有程式的缺陷，已修正並有測試。）
- **來源變更後待複核**：`revalidate(digests)` 把來源摘要不同（或來源消失）的已採納記憶標為 `stale`，不可讀。**新增 `reverify(id, approvedBy, { digest })`**：待複核的記憶只能由**具名**的人或規則、帶著來源**目前的摘要**重新採納，並從現在重新開始計算存活時間；非 `stale` 的拒絕（`not-stale`）。先前 `stale` 沒有任何出口。

## 3. 刪除、停用、重建、遮罩匯出

- **刪除**：`remove(id)`（既有）；新增 `removeScope(scope, { confirm: 'delete-memory-scope' })`：要**三個部分都給**（不能是萬用字元）加上明確確認，只刪那個範圍；被拒絕的請求不改動檔案。
- **停用／啟用**：`disable(id)`／`enable(id)`。停用的記憶保留但不被讀取，啟用後原樣恢復（只有版本號增加）；停用與採納互不影響。
- **重建**：`rebuild()` 以**今天的規則**重新檢查所有儲存的記憶，例如敏感內容的樣式變寬之後。不再通過的被**隔離**：內容清空、狀態 `quarantined`、永不讀取（理由只記代碼，例如 `sensitive:github-token`、`transcript-like`、`invalid-record`、`too-short`、`invalid-length`）；同一範圍內的重複優先保留目前可讀的一筆，同狀態時保留最早建立者（其餘 `rejected`，記下 `duplicateOf`），避免較早但停用或待複核的副本讓整則記憶變得不可讀；不是記錄的項目被丟棄。**重建不會改變保留項目的狀態，也不會讓原本不可讀的記憶進入使用**；沒有發現問題時不寫檔。
- **遮罩匯出**：`exportMasked()` 給診斷用，不是備份：依狀態（`ready`／`candidate`／`stale`／`expired`／`disabled`／`rejected`／`quarantined`）與範圍的**計數**，範圍只以固定順序的別名（`scope#1`…）表示。**沒有內容、id、來源、也沒有 repo／身份組／域的名稱**；相同資料不論寫入順序，輸出相同。

## 4. 寫入什麼

- 沿用既有的候選→採納、敏感掃描（憑證形態、email、家目錄路徑、UUID）、去重、來源摘要與 TTL。
- **不保存完整 transcript**：內容長度仍限 2000 字元；新增 `transcript-like` 拒絕：以講者標記的對話（`User:`、`Assistant:`、`Human:`、`AI:`、`Claude:`、`Codex:`、`You:`、`Me:`，含全形冒號，達 3 行以上）或聊天標記（`<|im_start|>`、`[INST]`、`<human>`…）。兩行標示的普通筆記不受影響。這是形態偵測，不是保證：改寫過、拆開或換個格式的對話偵測不到，仍需人工審核。
- **範圍欄位要合法**：`repoId`、`roleGroupId` 為 1–200 字元且無控制字元；`privacyDomain` 為上述的簡短小寫標籤，否則 `invalid-scope`（只列出欄位名稱）。

## 5. 檢索與預算

檢索沿用既有的本機基線：Latin 以字詞、CJK 以相鄰兩字（bigram）比對重疊，依分數與 id（以 UTF-16 碼位）排序；沒有新增任何套件。

- **模型與注入入口只能使用 `select()`**：它會強制分區、生命週期與預算規則；scope 缺漏或型別不合法時回傳空結果。`list()` 會列出所有隱私域及所有狀態的內容，只供本機管理畫面使用，不得用於注入或任何送給模型的路徑。

- **預算有上限**：`budgetChars` 預設 2000，**最大 8000**；超過時照上限處理並回報 `budgetClamped: 8000`；無效的值（負數、`NaN`、文字、`null`）改用預設，不會變成無限。這是**字元**預算，是 token 的粗略替代，沒有用分詞器量測，實際 token 數屬 #22 的評測。
- **被預算省略的會說明，不是默默截斷**：`select` 在有省略時回傳 `omitted: { count, chars, reason: 'budget' }`（沒有省略時沒有這個欄位）；`renderContext`／`planInjection` 接受 `omitted`，在注入文字中加上一行 `(N more reviewed notes were left out to stay within the size limit.)`，讓模型知道清單是不完整的。

## 6. 未驗證與限制（不宣稱通過）

- **注入的真實 CLI 行為**（互動式、`--resume`、省略說明對模型行為的影響）屬 #5 的未驗證項目；本 PR 只驗證產生的文字與計畫。
- **總 token 成本與品質 A/B 評測**屬 #22；這裡沒有任何「節省 token」的宣稱。
- 全文檢索是**基線**（字詞與 bigram 重疊），沒有詞頻加權、詞幹或同義詞；對語意改寫的任務文字找不到。
- 儲存庫不驗證呼叫端有權寫入哪個域（見第 1 節）；域與帳號、帳號與身份組的對應由呼叫端負責，身份組以 ID 傳入，不依賴 #14（PR #40）。
- 記憶的持久化格式維持 schema 版本 1，新欄位（`disabled`、`quarantineReasons`、`duplicateOf`）是加法；舊檔案可直接讀取。
- Windows 只由 CI（GitHub 託管環境）驗證，不是正式支援矩陣內的實機驗收。

## 7. 驗證

```
node --test test/memory/*.test.js
```

CI（`.github/workflows/memory-injection.yml`）在 macOS 與 Windows、Node 20 與 24 執行。
