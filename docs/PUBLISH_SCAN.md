# 對外內容掃描核心

對應 Issue #23 的第一個切片。狀態：**掃描核心已實作並以合成資料測試；尚未接上 commit hook、broker 或任何發布流程，也沒有對真實 GitHub 內容驗證。**

`src/publish/` 在內容發布到 GitHub **之前**檢查它是否含私人資料。它是「形態與逐字比對」偵測器，**不是**權限邊界：直接 `git`、`gh` 或 HTTP 寫入不經過它（屬 #24 與 P4 的隔離工作）。

```js
const { scanPublication } = require('../src/publish/scan');
const result = scanPublication(
  [{ kind: 'pr-body', text }, { kind: 'diff', text: stagedDiff }],
  { memories, rules, knownValues }   // 私人清單由呼叫端注入，掃描器不儲存、不回顯
);
// result.status: 'clear' | 'blocked' | 'incomplete' | 'error'；result.blocked 在 clear 以外都是 true
```

## 掃描單位

`commit-message`、`issue-title`、`issue-body`、`pr-title`、`pr-body`、`review`、`comment`、`branch-name`、`broker-payload`（純文字），以及 `diff`（unified diff）。diff 只看**新增的內容**：新增行（附新檔案中的行號與欄位）與新增／改名後的檔案路徑；刪除行與上下文行已在歷史中，不是這次要發布的內容。無法以把握讀懂的 diff 會退回「整份文字都掃」（包含刪除行），不信任部分解析：hunk 之外凡是不屬於 git 已知擴充標頭（`index`、`old|new mode`、`(dis)similarity index`、`rename|copy from|to`、`new|deleted file mode`、`Binary files`、`GIT binary patch`）的非空行、hunk 計數之外的 `+`／`-` 行、第一個檔案標頭之前的內容（例如 `format-patch` 的郵件前言）、檔案之間的文字、合併式（`@@@`／`diff --cc`）標頭，一律視為無法讀懂。二進位補丁的酬載行視為二進位內容（列為 `unscanned`），不逐行讀。

## 偵測

| 類別 | 代碼 | 來源 |
| --- | --- | --- |
| credential | `private-key-block`、`anthropic-key`、`api-key`、`github-token`、`cloud-access-key`、`slack-token`、`jwt`、`bearer-token`、`credential-assignment` | **重用** `src/memory/sensitive.js` 的同一份 `PATTERNS`（新增 `locateSensitive`，只回傳位置，不新增任何規則；沒有第三份憑證形態清單） |
| identifier | `email-address`、`uuid`（可能是 session id） | 同上 |
| local-path | `home-path`、`local-absolute-path` | 同上，加上 `/Users` `/home` `/root` `/Volumes` `/private/var|tmp` `/var/folders`、Windows 磁碟與 UNC 路徑；repo 相對路徑、URL 與 `#!/usr/bin/env` 不算 |
| private-fragment | `memory-fragment`、`rule-fragment` | **沿用** `findPrivateFragments`（逐字或輕度改寫）；清單由呼叫端注入。命中會定位到單獨就含 20 字元連續片段的行，只在整段文字才成立時回報「整份文字」（`line: null`） |
| known-value | `known-value` | 呼叫端登錄的已知私人值（帳號標籤、session id、系統指令片段），不分大小寫；回報的是呼叫端給的 id |
| file-name | `sensitive-file-name` | 新增或改名的檔案：`.env`（`.example`／`.sample`／`.template` 不算）、`.npmrc`、SSH 私鑰、`*.pem`／`*.key`／`*.p12`、`credentials.json`、`auth.json`、`.claude/`、`.codex/`、`CLAUDE.local.md`、`AGENTS.override.md` |

偵測器是可替換的介面：`{ name, detect(text) -> [{ code, category, index, id? }] }`（只回傳代碼與位置，不回傳命中的文字）；`options.detectors` 會取代預設組合，丟出例外的偵測器使掃描 fail closed。

**程式碼檔案的調整**：在新增行屬於程式碼檔案（`.js .ts .py .go .rs .java .cs .c .cpp` 等）時，共用的 `credential-assignment` 只在被指派的值是**引號字串字面值**時才算（`password = "hunter2hunter2"` 與 JS／TS 的樣板字串 `` `hunter2hunter2` `` 會擋，只有插值的 `` `${process.env.X}` `` 不算；`const token = crypto.randomBytes(8)`、`token = this.#lock()`、含 `secret:` 的正規表示式則不會）。這是縮小既有規則的適用範圍，不是新規則，目的是讓正常程式碼通過；代價是程式碼檔案中未加引號的指派不會被這條規則抓到。shell、PowerShell、設定檔、資料檔與純文字維持嚴格。對本倉庫的檔案實測：README、計劃書與 `src/agents.ts` 通過；先前 `src/` 中 6 個檔案被誤判，全是這類程式碼用法。測試檔中刻意放的合成憑證仍會被標記，這是預期的（需要人工確認）。

## 輸出：位置與類別，不回顯

每個 finding 只有 `unit`、`kind`、`code`、`category`、`line`、`column`（1 起算，diff 為新檔案中的行號）、`fileIndex`、呼叫端的 `id`、固定的修正提示 `hint`；**永遠不含命中的文字**（測試確認結果、錯誤與 `knownValues` 的值都不會出現在輸出中）。同一位置被兩個偵測器回報的本機路徑只算一次；最多 200 筆，超過時 `truncated: true` 且仍然阻擋；偵測器自己的上限（每個代碼最多定位 20 處，剛好達到 20 也視為可能還有）達到時也回報 `truncated: true`，偵測器可在回傳的陣列上設 `truncated` 屬性。

## Fail closed

| 情況 | 結果 |
| --- | --- |
| 輸入不是非空陣列、單位種類未知、`text` 不是字串 | `error`／`invalid-input`，阻擋 |
| 單位超過 2,000,000 字元、總量超過 8,000,000、單位超過 200 個 | `error`／`input-too-large`，阻擋 |
| 偵測器或私人清單出錯 | `error`／`scanner-failed`，阻擋；不含例外訊息（可能含被掃描的文字） |
| 二進位檔案（`Binary files … differ`、`GIT binary patch`），無論 diff 是否讀得懂 | `incomplete`，阻擋；列在 `unscanned`，路徑仍會被掃描 |
| 私人項目太短無法可靠比對（`findPrivateFragments` 的規則） | 列在 `unmatchable`，**不**阻擋也不靜默略過；呼叫端必須顯示 |

## 效能與一個既有缺陷

寫變異檢查時發現：`src/memory/sensitive.js` 的 email 規則對沒有 `@` 的長字串是**二次方**複雜度（20,000 字元 171 ms、80,000 字元 2.6 秒），2 MB 輸入足以讓掃描（與 `MemoryStore.propose`）卡死。已加上 lookbehind 讓規則只從連續字元的起點比對；對 20 萬組隨機字串與舊規則的結果完全一致，並用 40 萬字元的對抗輸入（長單字、`a@a@…`、`token` 加長空白、`eyJ` 加長字串…）量測所有規則皆為毫秒等級。`test/memory/sensitive.test.js` 新增了效能回歸測試（在舊規則上會失敗）。

## 限制（不得宣稱超出此範圍）

- **無法偵測**改寫、翻譯、拆開或編碼過的內容，以及不像憑證的秘密、未知格式的憑證。語意改寫後的私人資訊會通過。**人工 review 仍然需要。**
- 沒有偵測「結構欄位名稱」（如 `sessionId`、`accountProfileId`）：本產品自己的原始碼與文件大量使用這些識別字，單看名稱會讓正常程式碼無法通過。需要時以 `knownValues` 登錄實際的值，UUID 形態的 id 已由 `uuid` 抓到。
- 本機絕對路徑的規則是常見位置的清單，不是所有可能的路徑；`/tmp`、`/var` 本身與 `~/` 不算。
- 這是掃描器，不是發布閘門：沒有 commit hook、broker、攔截 `gh`／`git` 的機制；這些屬 #24 與 P4。

## 尚未完成／未驗證

- 與 commit hook、受管 broker 的整合（#24）與「受管發布被拒絕」的端對端驗收。
- 安全公開模板與本機審計紀錄（Issue 範圍中提到，PM 切片未包含）。
- 對真實 GitHub 內容、真實 staged diff 與各種 diff 工具輸出的驗證（只用合成資料與手寫 diff；`git diff` 的 rename／copy／二進位補丁等格式只涵蓋常見形式）。
- 統一三份憑證形態規則（`src/memory`、`src/storage/sensitive.js` 與 #35 之外的複本）屬 #37；本切片只重用 `src/memory` 的那一份。
- Windows：只由 CI 驗證，未在實機驗證。
