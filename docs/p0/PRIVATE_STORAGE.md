# 私人資料儲存核心

對應 Issue #9，以及 `docs/IMPLEMENTATION_PLAN.md` 第 5 節（資料模型與儲存）與 R08。

狀態：**儲存核心已實作並以合成資料測試；與 VS Code storage／SecretStorage 的整合尚未做、也尚未驗證**。#9 要求的「功能整合依賴：#8」在 #8 合併前無法完成，本 PR 依 Issue 的說明先交付明確介面與合成資料測試，不把它們當成整合驗收。

測試環境：macOS（Darwin 25.6）、Node.js 24，實測日期 2026-10-14。全部使用合成資料。

## 1. 範圍與檔案

| 檔案 | 內容 |
| --- | --- |
| `src/storage/private-store.js` | `PrivateStore`：集合式儲存、交易、遷移、清除、遮罩匯出 |
| `src/storage/paths.js` | 資料目錄必須在 repo 之外；連結解析與 fail-closed |
| `src/storage/sensitive.js` | 拒絕把憑證存進檔案：欄位名稱與值的形態偵測（只回報代碼與欄位路徑） |
| `src/storage/secrets.js` | `SecretVault`：憑證放在宿主的秘密儲存，記錄只保存不透明的 `secretRef`；`fromExtensionContext` 綁定擴充套件的 `globalStorageUri` 與 `secrets` |
| `scripts/p0/check-private-storage.js` | 可在任何機器重現的檢查（臨時目錄、合成資料、不需憑證或網路） |
| `test/storage/` | 41 項測試，含 4 個行程的並行寫入與真實 git repo |

儲存的集合由呼叫端宣告（預期為 `profiles`、`roleGroups`、`sessions`、`policies`），單一 JSON 檔 `store.json`：

```text
{ "format": "multiagent-private-store", "schemaVersion": N, "updatedAt": "...",
  "collections": { "<集合>": { "<id>": { ...記錄 } } } }
```

記錄的結構由使用者功能（#12、#14 等）定義；本模組只要求：id 符合 `^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$` 且不是保留字、記錄是普通物件、單筆不超過 64 KiB、整個檔案不超過 8 MiB。

## 2. 保證與失敗時的行為

| 情況 | 行為 | 測試 |
| --- | --- | --- |
| 資料目錄在 repo 內、包含 repo、不是絕對路徑（含 Windows 無磁碟機的路徑） | 建構時拒絕，不建立任何東西 | 是 |
| 目錄路徑經由連結／junction 指回 repo | 拒絕（解析最近的既有上層目錄） | 是（連結不可建立時跳過並標示） |
| 路徑解析出現 `EACCES`、`ELOOP`、`ENOTDIR` 等 | 拒絕（`private-root-unresolvable`）；只有 `ENOENT` 視為尚未建立 | 是 |
| 資料目錄（POSIX）不屬於目前使用者，或不是目錄 | 寫入與清除都拒絕（`directory-rejected`） | 是 |
| 取鎖或清除時的 I/O 錯誤（目錄不可寫、被檔案佔用、磁碟滿） | 回傳 `lock-failed`／`directory-rejected`／`clear-failed` 與錯誤碼，不以例外洩漏；讀取仍可使用 | 是（目錄不可寫的案例在 Windows 與 root 下跳過） |
| 寫入中途失敗（磁碟滿、rename 失敗） | 舊檔不變、暫存檔移除，回傳 `write-failed` 與錯誤碼 | 是（注入失敗） |
| Windows 上 rename 暫時被拒（`EPERM`／`EBUSY`／`EACCES`） | 重試最多 10 次 | 是（注入） |
| 檔案損壞、截斷、空檔、格式或結構不符、未知集合、不合法 id | 原檔逐位元組保留；讀取回傳 `store-unavailable`；所有寫入被拒；不當成空庫 | 是（7 種） |
| 檔案版本比程式新 | 拒絕，不降級、不改檔 | 是 |
| `store.json` 是符號連結或不是一般檔案 | 不跟隨、不寫入（`unsafe-path`） | 是 |
| 遷移函式丟出例外、回傳無效結構、加入憑證 | 原檔不變、不建立不完整的備份、回報步驟（不含例外文字）、寫入被拒 | 是（8 種） |
| 備份建立失敗，或備份後的寫入失敗 | 原檔不變；已建立的備份保留；重試可成功 | 是 |
| 兩個實例／行程同時寫入 | 目錄鎖加鎖內重新讀取，無遺失更新 | 是（4 個行程各 5 筆；拿掉鎖後該測試失敗） |
| 交易中途出錯 | 全部不寫入；呼叫端自己的例外在釋放鎖後原樣拋出 | 是 |
| 記錄含憑證（欄位名稱或值的形態） | 拒絕，只回報代碼與欄位路徑 | 是 |
| 私人檔案與 git | 資料目錄在 repo 外，`git status --ignored` 前後相同 | 是（真實 git repo） |

**憑證不進檔案。** `apiKey`、`accessToken`、`access_token`、`password`、`Authorization`、`privateKey` 等欄位名稱（含駝峰、底線、連字號寫法）若帶有文字內容會被拒絕；數值（例如 `tokensUsed: 120`）不受影響。值的形態（常見 API key、GitHub／Slack token、JWT、Bearer、私密金鑰區塊）也被拒絕。記錄只能用 `secretRef` 指向 `SecretVault`。這是形態偵測，**不是**完整的秘密掃描：改寫過、拆開或編碼過的憑證偵測不到。

**不讀取或複製 CLI 登入 token。** 本模組沒有任何讀取其他檔案的 API，只處理自己的 `store.json`、備份與鎖檔；測試以靜態檢查確認 `src/storage/` 不出現 `.credentials.json`、`auth.json`、`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、Keychain 相關字串或 `child_process`。這證明本模組沒有這條路徑，不證明呼叫端不會自行讀取。

## 3. Schema 遷移

- 建構時宣告 `schemaVersion` 與 `migrations`（`{ from: n, to: n+1, up(data) }`）。鏈必須完整且為單步，否則建構時拋出 `TypeError`（程式錯誤）。
- **讀取**舊版資料時在記憶體中套用遷移，不寫入、不備份。
- **第一次寫入**（或明確呼叫 `migrate()`）才會：先把原檔原樣備份到 `backups/store.v<版本>.<時間>.json`（排他建立、`0600`，同一時刻名稱衝突時加序號，不覆蓋），再以原子替換寫入遷移結果。
- 每一步的輸出都會驗證結構、集合名稱、id、記錄大小，並檢查是否含憑證；任何一步失敗就整個放棄。
- 遷移函式拿到的是資料的複本，失敗時不影響原資料。
- 備份**不會自動刪除**（由 `clear` 或使用者處理）；備份含原始的私人資料，與主檔同等對待。

## 4. 並行與跨行程限制

`PrivateStore` 的鎖是目錄內的鎖檔（`store.lock`，排他建立），寫入前取得、在鎖內重新讀取、寫完釋放。已知限制：

- **建議性鎖**：只保護遵守它的行程；不防止直接編輯檔案或使用其他程式寫入。
- **只作用於同一個目錄**，且依賴本機檔案系統的排他建立語意；**不支援網路檔案系統**（NFS／SMB）或雲端同步資料夾，這些環境下可能遺失更新。
- 超過 30 秒未更新的鎖視為過期並回收（比對 mtime 與 inode 後移除）。**回收不是無競爭的**：若持有者停滯超過 30 秒，另一個寫入者可能取走鎖，造成其中一次更新遺失；釋放時只會刪除自己持有的鎖。
- 交易函式必須是**同步**的，並在持鎖期間執行；取不到鎖時最多等約 2 秒後回傳 `locked`（可調）。
- 讀取不取鎖：寫入者以 rename 原子替換，讀者看到的是完整的舊版或新版。
- 崩潰（行程在寫完暫存檔、rename 之前被終止）會留下 `.store.*.tmp`；舊檔不受影響，超過過期時間的暫存檔在下一次寫入時清掉。**以實際終止行程的方式測試這一點尚未做**；目前只以注入的失敗與過期檔案模擬。
- 不處理跨機器同步或多個 VS Code 視窗之外的多使用者情境。

## 5. 清除與匯出

- `clear({ confirm: 'delete-private-data' })`：沒有確認字串一律拒絕。只移除本模組擁有的檔案（`store.json`、符合命名的備份與暫存檔），不碰目錄內其他檔案；可用 `includeBackups: false` 保留備份。損壞或版本不符的儲存庫也可以清除，這是無法使用時的復原路徑。
- `exportMasked()`：給診斷用，不是備份。id 換成 `集合#序號` 別名；每個值換成型別佔位（`<string>`、`<number>`、`<boolean>`、`<array:n>`、`<object:n>`），**只有**欄位在公開白名單（預設 `provider`、`role`、`kind`、`status`、`layer`、`type`、`method`，可依集合調整）且值是短的小寫列舉字串時才保留；巢狀物件只留下鍵的數量；不安全的欄位名稱以 `field#n` 取代。測試確認匯出中不含 email、路徑、id、label、`secretRef`、資料目錄與 repo 路徑，並通過憑證形態掃描。

## 6. 重現方式

```text
node --test "test/storage/*.test.js"
node scripts/p0/check-private-storage.js --repo <repo 路徑>
```

檢查腳本在臨時資料夾（含空白與 Unicode）內以合成資料驗證 10 項：repo 內目錄被拒、讀寫、拒絕憑證、遷移中途失敗不動原檔、遷移與備份、損壞檔案保留、清除復原、匯出不含值、`git status` 不變。結束後移除臨時資料夾。repo 路徑不是 git 工作樹時，最後一項標為跳過。

## 7. 平台矩陣

| 項目 | macOS | 原生 Windows |
| --- | --- | --- |
| 單元測試、檢查腳本（真實檔案系統、含空白與 Unicode 路徑、junction、鎖、rename 重試、4 行程並行、真實 git repo） | 本機與 CI 通過（41 項、0 跳過） | CI 的 `windows-latest` runner 通過（41 項中 40 項通過、1 項跳過：目錄不可寫的 POSIX 專用案例；檢查腳本 10 項通過）；GitHub 託管環境，**不是**正式支援矩陣內的實機驗收 |
| 檔案權限（檔案 `0600`、目錄 `0700`） | 已測試 | **未驗證**：Windows 沒有同樣的權限位元，ACL 的實際效果未檢查，只能依賴使用者設定檔目錄的預設權限 |
| 資料目錄擁有者檢查 | 每次取鎖時檢查目錄存在、是目錄且屬於目前使用者（`not-owned` 則拒絕）；已有測試 | 不適用（沒有 uid）；ACL 未驗證 |
| fsync 的實際耐久性 | 呼叫但未驗證斷電情境 | 同左；目錄 fsync 在 Windows 上被略過 |

## 8. 尚未驗證／尚未實作

| 項目 | 原因 |
| --- | --- |
| 與 VS Code `globalStorageUri`／`SecretStorage` 的整合 | 需要 #8 合併後在 Extension Host 驗證；`fromExtensionContext` 只以假物件測試，介面與 VS Code 的 `SecretStorage` 形狀一致，**未**在真實 Extension Host 執行 |
| SecretStorage 的實際後端（macOS Keychain、Windows 憑證管理員）行為與錯誤 | 同上 |
| Windows 實機與 ACL | 沒有設備 |
| 以終止行程測試崩潰復原 | 尚未做 |
| 網路檔案系統、雲端同步資料夾 | 明確不支援，未測 |
| 具體記錄結構（profile、身份組、session、政策版本）與其遷移 | 屬 #12、#14、#11 等後續功能；本 PR 只提供容器 |
| 設定頁的「清除」與「匯出」入口 | UI 屬後續功能 |
| 與 #7（`src/accounts/profile.js`）、#30（`src/memory/paths.js`、`store.js`）重複的路徑檢查與寫入邏輯 | 三個 PR 刻意各自獨立以便任意順序合併；合併後應統一，**#30 的記憶庫之後可改建在本儲存核心上** |

## 9. 需要 PM 決策

1. **三處重複的路徑檢查與原子寫入**：是否在三個 PR 合併後安排一個整理 Issue，統一成共用模組，並讓 #30 的 `MemoryStore` 改用 `PrivateStore`。
2. **備份保留策略**：目前不自動刪除。是否要設保留份數或天數（備份含私人資料）。
3. **單一檔案 vs 每集合一檔**：目前單檔，以便跨集合的交易保持原子；代價是整體大小上限 8 MiB 與每次寫入重寫整個檔案。記憶庫（#21）資料量大時是否另用獨立的儲存。
4. **鎖等待上限**：預設約 2 秒、30 秒過期；是否需要依實際使用調整。
