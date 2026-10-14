# 私人資料儲存核心

對應 Issue #9，以及 `docs/IMPLEMENTATION_PLAN.md` 第 5 節（資料模型與儲存）與 R08。

狀態：**儲存核心已實作並以合成資料測試；與 VS Code storage／SecretStorage 的整合尚未做、也尚未驗證**。#9 要求的「功能整合依賴：#8」在 #8 合併前無法完成，本 PR 依 Issue 的說明先交付明確介面與合成資料測試，不把它們當成整合驗收。

測試環境：macOS（Darwin 25.6）、Node.js 24 與 20.20.2（VS Code 1.95 的 extension host 使用 Node 20，是專案鎖定的最舊執行環境），實測日期 2026-10-14。全部使用合成資料。

## 1. 範圍與檔案

| 檔案 | 內容 |
| --- | --- |
| `src/storage/private-store.js` | `PrivateStore`：集合式儲存、交易、遷移、清除、遮罩匯出 |
| `src/storage/paths.js` | 資料目錄必須在 repo 之外；連結解析與 fail-closed（含磁碟根目錄與「既有祖先必須是目錄」） |
| `src/storage/lock.js` | 單一寫入者鎖：持有者資訊、不依時間自動搶鎖、明確的復原路徑 |
| `src/storage/sensitive.js` | 拒絕把憑證存進檔案：欄位名稱與值的形態偵測（只回報代碼與欄位路徑） |
| `src/storage/secrets.js` | `SecretVault`：憑證放在宿主的秘密儲存，記錄只保存不透明的 `secretRef`；`fromExtensionContext` 綁定擴充套件的 `globalStorageUri` 與 `secrets` |
| `scripts/p0/check-private-storage.js` | 可在任何機器重現的檢查（臨時目錄、合成資料、不需憑證或網路） |
| `test/storage/` | 73 項測試，含 4 個行程的並行寫入、跨行程的鎖持有與崩潰、真實 git repo |

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
| 一路 `ENOENT` 走到磁碟根目錄（例如沒有掛載的 `Z:\`、不存在的 UNC 主機） | 拒絕：沒有任何東西被驗證，不是「尚未建立」；repo 根目錄同理（`repo-root-unresolvable`） | 是（模擬 Windows 檔案系統） |
| 最近的既有祖先是一般檔案（Windows 對檔案之下的路徑回報 `ENOENT`，macOS 回報 `ENOTDIR`） | 拒絕；兩個平台行為一致 | 是（模擬與真實檔案系統） |
| 資料目錄（POSIX）不屬於目前使用者，或不是目錄 | 寫入與清除都拒絕（`directory-rejected`） | 是 |
| 資料目錄的上層在建構之後被換成指向 repo 的連結，而目錄尚不存在 | **建立任何目錄之前**就檢查並拒絕：repo 內不會出現新目錄 | 是 |
| 取鎖或清除時的 I/O 錯誤（目錄不可寫、被檔案佔用、磁碟滿） | 回傳 `lock-failed`／`directory-rejected`／`clear-failed` 與錯誤碼，不以例外洩漏；讀取仍可使用 | 是（目錄不可寫的案例在 Windows 與 root 下跳過） |
| 寫入中途失敗（磁碟滿、rename 失敗） | 舊檔不變、暫存檔移除，回傳 `write-failed` 與錯誤碼 | 是（注入失敗） |
| Windows 上 rename 暫時被拒（`EPERM`／`EBUSY`／`EACCES`） | 重試最多 10 次 | 是（注入） |
| 檔案損壞、截斷、空檔、格式或結構不符、未知集合、不合法 id | 原檔逐位元組保留；讀取回傳 `store-unavailable`；所有寫入被拒；不當成空庫 | 是（7 種） |
| 檔案版本比程式新 | 拒絕，不降級、不改檔 | 是 |
| `store.json` 是符號連結或不是一般檔案 | 不跟隨、不寫入（`unsafe-path`） | 是 |
| 遷移函式丟出例外、回傳無效結構、加入憑證 | 原檔不變、不建立不完整的備份、回報步驟（不含例外文字）、寫入被拒 | 是（8 種） |
| 備份建立失敗，或備份後的寫入失敗 | 原檔不變；已建立的備份保留；重試可成功 | 是 |
| `backups` 是連結／junction（例如指向 repo）、一般檔案或屬於他人 | 遷移與寫入回報 `backup-failed`（`backup-dir-rejected`），**寫入前**就拒絕：repo 內連暫時性的檔案都不會出現；`clear` 在刪除任何東西之前就拒絕 | 是（以 `io.writeFile` 確認沒有任何寫入嘗試） |
| `backups` 裡有名稱像備份、但不是本儲存庫產生的檔案（例如使用者的 `store.v1.user-document.json`，甚至完全符合產生格式的名稱） | **不刪除**：只有清單（manifest）列出、本人擁有、內容與記錄完全一致的備份才會被刪；其餘保留並以原因計數回報（`kept.unrecognized` 等） | 是（含 PM 的重現） |
| 清單列出的備份被改過內容、換成連結、或清單本身損壞／格式不符／含路徑穿越的名稱 | 該備份保留並回報（`modified`、`not-regular`、`manifest-unverified`）；損壞的清單不會被覆寫，之後的備份會把它改名保留並另起新清單 | 是 |
| 兩個實例／行程同時寫入 | 目錄鎖加鎖內重新讀取，無遺失更新 | 是（4 個行程各 5 筆；拿掉鎖後該測試失敗） |
| 鎖被仍在執行的行程持有（即使超過過期時間） | **不會被取走**：回傳 `locked`、`detail: owner-alive`；持有者釋放後寫入恢復 | 是（獨立行程持有、超過過期時間） |
| 鎖的持有者已崩潰 | 回傳 `locked`、`detail: owner-dead`，**不自動清除**；`recoverLock({ confirm })` 清除 | 是（真實的崩潰行程） |
| 交易中途出錯 | 全部不寫入；呼叫端自己的例外在釋放鎖後原樣拋出 | 是 |
| 記錄含憑證（欄位名稱或值的形態） | 拒絕，只回報代碼與欄位路徑 | 是 |
| 私人檔案與 git | 資料目錄在 repo 外，`git status --ignored` 前後相同 | 是（真實 git repo） |

**憑證不進檔案。** `apiKey`、`accessToken`、`access_token`、`password`、`Authorization`、`privateKey` 等欄位名稱（含駝峰、底線、連字號寫法）若帶有文字內容會被拒絕；數值（例如 `tokensUsed: 120`）不受影響。值的形態（常見 API key、GitHub／Slack token、JWT、Bearer、私密金鑰區塊）也被拒絕。記錄只能用 `secretRef` 指向 `SecretVault`。這是形態偵測，**不是**完整的秘密掃描：改寫過、拆開或編碼過的憑證偵測不到。

**不讀取或複製 CLI 登入 token。** 本模組沒有任何讀取其他檔案的 API，只處理自己的 `store.json`、備份與鎖檔；測試以靜態檢查確認 `src/storage/` 不出現 `.credentials.json`、`auth.json`、`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、Keychain 相關字串或 `child_process`。這證明本模組沒有這條路徑，不證明呼叫端不會自行讀取。

## 3. Schema 遷移

- 建構時宣告 `schemaVersion` 與 `migrations`（`{ from: n, to: n+1, up(data) }`）。鏈必須完整且為單步，否則建構時拋出 `TypeError`（程式錯誤）。
- **讀取**舊版資料時在記憶體中套用遷移，不寫入、不備份。
- **第一次寫入**（或明確呼叫 `migrate()`）才會：先把原檔原樣備份到 `backups/store.v<版本>.<yyyymmddThhmmssmmmZ>[-序號].json`（排他建立、`0600`，同一時刻名稱衝突時加序號，不覆蓋），再以原子替換寫入遷移結果。**備份的來源紀錄**：建立備份**之前**先把名稱、SHA-256、大小、原版本與時間寫進 `backups/manifest.json`（原子替換、`0600`），再建立檔案；建立失敗就把剛寫的項目還原。這個順序讓「崩潰在兩步之間」只會留下沒有檔案的項目（無害），不會留下無人能證明是自己產生的備份。
- 每一步的輸出都會驗證結構、集合名稱、id、記錄大小，並檢查是否含憑證；任何一步失敗就整個放棄。
- 遷移函式拿到的是資料的複本，失敗時不影響原資料。
- 備份**不會自動刪除**（由 `clear` 或使用者處理）；備份含原始的私人資料，與主檔同等對待。`clear` 只會刪除清單證明是本儲存庫產生且內容未變的備份。

## 4. 並行與跨行程限制

`PrivateStore` 的鎖是目錄內的鎖檔（`store.lock`，排他建立；內容為持有者的行程代號、主機名稱、時間與一個隨機 token），寫入前取得、在鎖內重新讀取、寫完只釋放自己持有的那一把。

**單一寫入者不變量以 fail closed 維持：鎖不會因為「看起來太久」而被取走。**

| 鎖的狀況 | `transact`／`put`／`clear` | `recoverLock({ confirm: 'recover-stale-lock' })` |
| --- | --- | --- |
| 持有者行程仍存在（`owner-alive`） | `locked`，絕不取走，不論多久 | 拒絕（`owner-not-confirmed-gone`）；`force: true` 且鎖已超過過期時間才可清除，由人判斷，例如重新開機後行程代號被別的程序重用 |
| 持有者行程確定已不存在（`owner-dead`，同一主機） | `locked`，不自動清除 | 清除 |
| 持有者在另一台主機（`owner-other-host`）或鎖檔無法解析（`owner-unreadable`，例如持有者在寫入內容前崩潰） | `locked` | 拒絕；`force: true` 且已超過過期時間才可清除 |
| 沒有鎖 | 取得 | 無動作 |

`inspectLock()` 回報持有狀況（`held`、`detail`、`ageMs`、`stale`），不含行程代號與主機名稱，供介面決定要不要提供「復原」。清除時會再讀一次鎖檔，確認仍是剛才檢查的那一把才刪除。過期時間（預設 30 秒）現在只用於「`force` 的前提」與暫存檔清理，**不再用於自動搶鎖**。

已知限制：

- **建議性鎖**：只保護遵守它的行程；不防止直接編輯檔案或使用其他程式寫入。
- **只作用於同一個目錄**，且依賴本機檔案系統的排他建立語意；**不支援網路檔案系統**（NFS／SMB）或雲端同步資料夾，這些環境下可能遺失更新。
- 崩潰後需要一次明確的復原才能再寫入（`owner-dead` 時 `recoverLock` 不需要 `force`）。代價是少了自動復原；好處是不會破壞單一寫入者。
- **行程代號重用**（重新開機後別的程序拿到相同代號）會讓死掉的持有者被誤認為仍存在：結果是 fail closed（`locked`），需要人工 `force` 復原，不會寫入。
- 取不到鎖時最多等約 2 秒（`retries × waitMs`，可調）後回傳 `locked`。交易函式必須是**同步**的，並在持鎖期間執行。
- 讀取不取鎖：寫入者以 rename 原子替換，讀者看到的是完整的舊版或新版。
- 崩潰（行程在寫完暫存檔、rename 之前被終止）會留下 `.store.*.tmp`；舊檔不受影響，超過過期時間的暫存檔在下一次寫入時清掉。**以實際終止行程測試「寫到一半」這一點尚未做**；目前以注入的失敗、真實的崩潰行程（持鎖後離開）與過期檔案模擬。
- **檢查與使用之間有時間差**：資料目錄與備份目錄在使用前驗證（不是連結、屬於本人、解析後在 repo 之外），備份寫入後會再驗證一次並移除自己剛建立的檔案；但無法排除驗證與寫入之間被替換的極短時間窗，因此資料目錄應只有使用者本人可寫（建立時 `0700`，POSIX 檢查擁有者）。
- 不處理跨機器同步或多個使用者共用同一資料目錄。

## 5. 清除與匯出

- `clear({ confirm: 'delete-private-data' })`：沒有確認字串一律拒絕。先驗證所有要碰的路徑（備份目錄必須是本人擁有、不是連結、解析後在資料目錄內且在 repo 之外），**驗證失敗就不刪除任何東西**。之後：
  - 移除 `store.json` 與本模組的暫存檔（`.store.<pid>.<隨機>.tmp`，一般檔案且本人擁有）。
  - **備份只依來源紀錄刪除**：`backups/manifest.json` 列出、是本人擁有的一般檔案（不是連結）、大小與 SHA-256 都與記錄一致，才會刪除。**名稱相符不算數**：使用者放在 `backups/` 的檔案，即使名稱是 `store.v1.…json` 的完整產生格式，只要不在清單內，一律保留。
  - 無法證明的項目保留並計數回報：`unrecognized`（不在清單內）、`modified`（內容或大小與記錄不同）、`not-regular`（被換成連結或非一般檔案）、`not-owned`、`manifest-unverified`（清單損壞、格式不符、含路徑穿越或重複的名稱，此時**整個備份目錄原封不動**）。回報只有原因與數量，不含路徑。
  - 清單的項目若沒有對應檔案（崩潰在兩步之間）會被忽略；全部處理完後，沒有保留項目就移除清單，有保留的就把清單改寫成只剩它們（之後可再次判斷），目錄空了才移除。
  - 可用 `includeBackups: false` 完全不碰備份。損壞或版本不符的儲存庫也可以清除，這是無法使用時的復原路徑；代價是：清單損壞時舊備份無法被證明、不會被刪，需使用者自行處理。
- `exportMasked()`：給診斷用，不是備份。id 換成 `集合#序號` 別名；每個值換成型別佔位（`<string>`、`<number>`、`<boolean>`、`<array:n>`、`<object:n>`），**只有**欄位有固定的公開值清單，而且值**完全等於**清單中的某一項時才保留（預設只有 `provider`：`claude`／`codex`，與 `status`：`preparing`／`running`／`waiting`／`completed`／`failed`／`unknown`；可用 `publicValues` 依集合增加，且必須是精確字串清單）。**符合某種字元形態不算數**：`alice-private` 這類看起來像列舉的帳戶或代理標籤會被遮罩；巢狀物件只留下鍵的數量；不安全的欄位名稱以 `field#n` 取代。測試確認匯出中不含 email、路徑、id、label、`secretRef`、資料目錄與 repo 路徑，並通過憑證形態掃描。

## 6. 重現方式

```text
node --test "test/storage/*.test.js"
node scripts/p0/check-private-storage.js --repo <repo 路徑>
```

檢查腳本在臨時資料夾（含空白與 Unicode）內以合成資料驗證 12 項：repo 內目錄被拒、讀寫、拒絕憑證、遷移中途失敗不動原檔、遷移與備份、損壞檔案保留、清除復原、`clear` 不刪名稱相似的無關檔案、匯出不含值、`git status` 不變。結束後移除臨時資料夾。repo 路徑不是 git 工作樹時，最後一項標為跳過。

## 7. 平台矩陣

| 項目 | macOS | 原生 Windows |
| --- | --- | --- |
| 單元測試、檢查腳本（真實檔案系統、含空白與 Unicode 路徑、junction、鎖、rename 重試、4 行程並行、真實 git repo） | 本機與 CI 通過；Node 20 與 24 都測 | CI 的 `windows-latest` runner 通過（41 項中 40 項通過、1 項跳過：目錄不可寫的 POSIX 專用案例；檢查腳本 10 項通過）；GitHub 託管環境，**不是**正式支援矩陣內的實機驗收 |
| 檔案權限（檔案 `0600`、目錄 `0700`） | 已測試 | **未驗證**：Windows 沒有同樣的權限位元，ACL 的實際效果未檢查，只能依賴使用者設定檔目錄的預設權限 |
| 資料目錄擁有者檢查 | 每次取鎖時檢查目錄存在、是目錄且屬於目前使用者（`not-owned` 則拒絕）；已有測試 | 不適用（沒有 uid）；ACL 未驗證 |
| fsync 的實際耐久性 | 呼叫但未驗證斷電情境 | 同左；目錄 fsync 在 Windows 上被略過 |

## 8. 尚未驗證／尚未實作

| 項目 | 原因 |
| --- | --- |
| 與 VS Code `globalStorageUri`／`SecretStorage` 的整合 | 需要 #8 合併後在 Extension Host 驗證；`fromExtensionContext` 只以假物件測試，介面與 VS Code 的 `SecretStorage` 形狀一致，**未**在真實 Extension Host 執行 |
| SecretStorage 的實際後端（macOS Keychain、Windows 憑證管理員）行為與錯誤 | 同上 |
| Windows 實機與 ACL | 沒有設備 |
| 以終止行程測試「寫到一半」的崩潰復原 | 尚未做（持鎖後崩潰已有真實行程的測試） |
| 網路檔案系統、雲端同步資料夾 | 明確不支援，未測 |
| 具體記錄結構（profile、身份組、session、政策版本）與其遷移 | 屬 #12、#14、#11 等後續功能；本 PR 只提供容器 |
| 設定頁的「清除」與「匯出」入口 | UI 屬後續功能 |
| 與 #7（`src/accounts/profile.js`）、#30（`src/memory/paths.js`、`store.js`）重複的路徑檢查與寫入邏輯 | 三個 PR 刻意各自獨立以便任意順序合併；合併後應統一，**#30 的記憶庫之後可改建在本儲存核心上** |

## 9. 需要 PM 決策

1. **三處重複的路徑檢查、鎖與原子寫入**：是否在三個 PR 合併後安排一個整理 Issue，統一成共用模組，並讓 #30 的 `MemoryStore` 改用 `PrivateStore`。
2. **備份保留策略**：目前不自動刪除（PM 已同意暫不刪除，但必須留在已驗證的私人路徑）。是否要設保留份數或天數。
3. **單一檔案 vs 每集合一檔**：目前單檔，以便跨集合的交易保持原子；代價是整體大小上限 8 MiB 與每次寫入重寫整個檔案。記憶庫（#21）資料量大時是否另用獨立的儲存。
4. **崩潰後的自動復原**：目前一律需要明確呼叫 `recoverLock`（持有者已死亡時不需 `force`）。介面是否在偵測到 `owner-dead` 時直接提示一鍵復原，或由使用者在設定頁操作。
5. **鎖等待上限**：預設約 2 秒；過期時間（30 秒）現在只是 `force` 的前提。是否需要調整。
