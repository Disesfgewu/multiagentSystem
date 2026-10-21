# 身份組模型與有效規則預覽

對應 Issue #14（本文件隨 PR 以 `Refs #14` 交付，Issue 保持開放）與 `docs/IMPLEMENTATION_PLAN.md` 的 R04／身份組規則順序。實作位於 `src/roles/`，規則合成沿用 `src/memory/rules.js` 的 `resolveRules`，沒有另寫一套。

這是**本機、純函式**的核心：不讀寫任何檔案、不啟動任何行程、不連網。所有輸入與輸出（身份組名稱、規則文字、預覽）都是私人本機資料，不得貼到 GitHub、commit 或記錄檔。

## 1. 狀態

| 項目 | 狀態 |
| --- | --- |
| 身份組模型與結構驗證（未知欄位拒絕） | 完成，有測試 |
| 平台→使用者→專案→身份組→任務的合成與有效規則預覽（來源層級與版本、被擋下的衝突、覆寫、各工具的有效權限） | 完成，有測試 |
| PM 與 worker 兩個身份組的繼承、覆寫、衝突案例 | 完成，有測試 |
| 身份組記錄的持久化 | **未做**：等 #35（`PrivateStore`）合併後再接 |
| 對真實 Claude Code／Codex 的注入 | **未做、未驗證**：本模組只產出 `renderContext` 可直接使用的資料；實際注入屬 #5，其互動式與 `--resume` 效果仍是 #5 的未驗證項目 |
| 工具權限的**強制** | 預覽模組本身**不強制**任何權限（預覽的每個工具仍標示「未強制」）。**啟動時**才把權限轉成 CLI 自己的設定（Claude Code 的 `permissions` 規則；Codex 只有「不能寫檔」會變成唯讀沙箱），強度逐項標示：見「4a」（#310） |
| 身份組編輯畫面、PM／worker 模板、個別 agent 覆寫預設帳號 | 未做（後續 P2 功能） |

## 2. 身份組欄位

`validateRoleGroup(input)` 回傳 `{ ok, problems }`，成功時另有乾淨且完整的 `group` 複本。問題只含代碼與欄位路徑，**不含錯誤的值**；不像設定名稱的未知欄位名稱（例如被拿來當鍵的資料）一律以 `field` 取代，不回顯。

| 欄位 | 規則 |
| --- | --- |
| `id` | 必填；英數、底線、連字號，最長 64 |
| `name` | 必填；1–80 字元、單行；拒絕控制字元（含 C1）、雙向覆寫與隔離字元、零寬與其他不可見字元（零寬空格、字詞連接符、位元組順序標記、軟連字號、行／段分隔符、阿拉伯字母標記等）。零寬非連接符與連接符（U+200C、U+200D）允許，因為波斯文、印度系文字需要它們 |
| `role` | 必填；小寫英數與連字號，最長 32（例如 `pm`、`worker`；目前只是標籤，發布權限仍由 `src/publish-policy.js` 決定） |
| `provider` | 必填；`claude` 或 `codex` |
| `version` | 必填；正整數；每條衍生規則與預覽都帶這個版本 |
| `defaultAccountProfileId` | 選填；帳號設定的本機 ID 或 `null`（建立 agent 時再選）。只放 ID，不放標籤或 email |
| `allowedScope.repositories` | 必填；`owner/name` 清單，不分大小寫去重。**空清單代表不允許任何 repo**，不是「全部」 |
| `allowedScope.paths` | 必填；repo 內相對路徑前綴，以 `/` 分隔且已是最簡形式（`.` 代表整個 repo）。**空清單代表不允許任何路徑**。這份資料日後由 broker／隔離去執行，所以不留解讀空間，一律拒絕而不是修正：絕對路徑、`~`、`..`、`./`、`//`、結尾斜線；看起來像 glob 或 Windows 保留的字元 `* ? < > | " :` 與反斜線（`src/*` 若被當成 glob 會比字面前綴寬）；Unicode 控制與格式字元（`\p{Cc}`、`\p{Cf}`，含雙向覆寫與零寬字元，它們會讓預覽顯示的路徑與實際不同）；不是 NFC 的寫法（一個名稱只有一種拼法）；任何 `.git` 片段（不分大小寫，含 Windows 短名 `GIT~1`；其中的 hooks 是會被執行的程式）；Windows 裝置名稱（`CON`、`NUL`、`COM1` 等，含副檔名）；以點或空白結尾的片段。以 NFC 加小寫比對重複 |
| `toolPermissions` | 選填；`shell`、`fileWrite`、`network`、`githubRead`、`githubWrite`、`merge`，以及較細的 `gitCommit`、`gitPush`、`prCreate`、`prReview`、`comment`、`mcp`，各為 `deny`／`ask`／`allow`。**沒寫的工具視為 `deny`**；未知工具名稱拒絕。**例外（相容）**：在較細的工具出現之前存下來的身份組沒有那幾項時，`gitCommit`／`gitPush`／`prCreate`／`prReview`／`comment` 沿用該身份組自己寫的 `githubWrite`（原本要問的還是要問，原本禁止的還是禁止），`mcp` 維持 `deny`；明寫的值不會被取代 |
| `memoryScope` | 選填；`{ mode: 'role-group' }` 或 `{ mode: 'off' }`；沒寫視為 `off`。跨 repo、跨身份組分享需要明確設計，這裡不接受 |
| `rules` | 選填；身份組自己的規則，最多 200 條 |

規則（任何一層）可有 `id`（僅 ASCII）、`type`（`forbid`／`require`／`instruction`）、`key`（forbid／require）或 `text`（instruction，最長 2000 字元，同樣拒絕控制、雙向與不可見字元，但允許換行與 Tab）、`version`、`replaces`。其他欄位拒絕；forbid／require 不得帶 `text`，instruction 不得帶 `key`。`rg:` 開頭的 id 保留給由工具權限產生的規則，手寫的不能使用。

## 3. 層級語意

順序（強到弱）：`platform` → `user` → `project` → `roleGroup` → `task`。這是 `src/memory/rules.js` 既有的語意，本模組沒有改變：

- **較弱的層級只能增加限制，不能放寬或取代較強的層級。** 身份組比專案**弱**，所以身份組規則不能覆寫專案或平台規則；反過來，較強的層級可以用 `replaces` 取代較弱層級的規則。
- 同一個 key 上，較強層級的 `require` 會擋下較弱層級的 `forbid`，反之亦然；同層級衝突時 `forbid` 勝出。
- **層級由規則來自哪一份清單決定，不由規則自己宣稱**：規則若寫了與所屬清單不同的 `layer` 就拒絕整份預覽（專案檔案不能假裝成平台規則）。呼叫端不能傳入 `roleGroup` 層，這一層只來自身份組本身。
- **id 全域唯一**：兩個層級重複使用同一個 id 是錯誤，不是讓合成器默默挑一個贏家。

為了讓預覽能說明「為什麼」，本 PR 對 `resolveRules` 只做了**增加**：回傳多一個 `replaced`（哪條規則取代了哪條）。既有欄位與行為不變，原有測試未修改。

## 4. 工具權限

身份組的 `toolPermissions` 先轉成身份組層級的規則，再由同一個合成器處理：

- `deny` → `forbid`，key 為 `tool:<名稱>`（會出現在注入文字的 "Do not:"）。
- `ask` → 一條 `instruction`：「Ask the user before using <名稱>.」。
- `allow` → **不產生任何規則**。`allow` 永遠不能放寬較強層級的 `forbid`：預覽的 `effective` 在任何已生效的 forbid 存在時一律是 `deny`，並在 `limitedBy` 列出來源層級與版本。若被**較強**層級擋下，另外在衝突清單加上 `permission-relaxation-blocked`；較弱層級（任務）新增限制則只列入 `limitedBy`。

**預覽本身沒有強制任何權限。** 預覽項目都帶 `enforced: false`、`by: 'broker-or-isolation'`；真正交給 CLI 的設定是**啟動時**才產生的（見下一節），預覽另外列出「啟動時會給 CLI 什麼、各項多牢」，但預覽本身什麼都不傳。

## 4a. 啟動時給 CLI 的權限（#310）

`src/roles/tool-permissions.js` 是唯一決定轉換的地方。每個工具的有效等級（較強層級的禁止已套用）轉成：

- **等級語意**：`deny` → deny 規則；`ask` → ask 規則（CLI 即使在自動模式也會問，因為使用者選的就是「要問」）；`allow` → **不產生任何規則**：它不會放寬 CLI 自己的權限模式，也不會推翻使用者的自動模式設定（#296）。永遠不寫 `allow`，也不碰 `permissions.defaultMode`、不用 `bypassPermissions`。
- **Claude Code**（官方文件：[permissions](https://code.claude.com/docs/en/permissions)、[settings](https://code.claude.com/docs/en/settings)，2026-10-22 查閱）：規則寫進該 session 的設定檔，經 `--settings <路徑>` 帶入，**與署名設定（#293）是同一個檔案**（每個 session 一個，放在擴充套件私人儲存區、權限 0600，session 結束或啟動失敗時刪除；寫不出來就不啟動）。官方文件說明：規則依 deny → ask → allow 評估、deny 優先；用裸工具名稱（`Bash`、`Edit`、`Write`、`NotebookEdit`、`MultiEdit`、`WebFetch`、`WebSearch`、`mcp__*`）作 deny 規則會把該工具從 CLI 的脈絡中**移除**；`--settings` 在使用者與專案設定檔之上、managed 設定之下，**清單類設定（如 `permissions.deny`）跨檔案是合併而不是覆蓋**，所以使用者自己的規則仍然有效。
- **強度逐項標示，不誇大**：`ENFORCED`＝CLI 自己移除或擋下該工具（`shell`、`mcp`、檔案編輯工具、網路工具）；`PARTLY enforced`＝擋的是「通常的寫法」，另一種做同一件事的路徑仍在：官方文件明說 `Bash(git push *)` 這類規則**不是安全邊界**（`/usr/bin/curl`、`sh -c '…'`、`git -C . push` 不會被比對到），所以 `gitCommit`／`gitPush`／`prCreate`／`prReview`／`comment`／`merge`／`githubWrite`／`githubRead` 只有 PARTLY；`fileWrite` 與 `network` 在 shell 沒有同時被禁止時也只是 PARTLY（shell 還能 `sed -i`、`curl`）；`advice only`＝這個 CLI 沒有擴充套件能傳的設定，只是告知 agent。要真正擋住，要靠 shell 一併禁止，或沙箱／隔離（#25）。
- **Codex**（官方旗標：[CLI reference](https://developers.openai.com/codex/cli/reference) 的 `--sandbox`）：Codex 沒有逐指令的允許／拒絕旗標，所以只有 `fileWrite: deny` 會變成 `--sandbox read-only`（也因此無法經由 shell 改檔；是否同時擋網路未驗證）；從不使用 `danger-full-access`。與自動模式（#296）的 `--sandbox workspace-write` 並用時，**身份組的沙箱取代自動模式的**（較嚴格者不會被便利功能蓋過），其餘自動模式參數照舊。
- **agy、自訂 provider**：沒有已證實的設定，全部是 advice only，畫面這樣寫。
- **預設範本**：PM（不能編輯檔案、commit、push、開或合併 PR、用 MCP；可下指令、讀、review、留言、寫 Issue）；Developer／worker（可編輯、跑測試、commit、push、開 PR、留言；不能 merge、review、用 MCP；改 Issue 與用網路先問）；Researcher（沒有 shell、不能改檔、不能寫 GitHub 或用 git；可用網路與 MCP 研究工具）；Blank 全部禁止。
- **Broker 角色一致**：PM 身份組對應 Broker 的 `pm`、worker 對應 `worker`，其他角色沒有 Broker 寫入操作；PM 身份組若允許 commit／push／開 PR／改檔，或 worker 身份組若允許 review／merge，預覽會標出「DISAGREES」。Broker 本身目前仍是注入式身份（沒有真實 transport），這一版只做一致性檢查。
- **未驗證**：真實 Claude Code 是否照這些規則運作（#135）；Claude Code 對特定版本的規則語法差異；Codex 的 sandbox 對網路的行為；擴充套件**沒有**驗證 shell 啟動檔或使用者自己的設定是否放寬（使用者自己的 allow 規則不會被 deny 取代，但 deny 優先）。

## 5. 預覽

`previewEffectiveRules({ roleGroup, layers })`，`layers` 為 `{ platform, user, project, task }`，各為規則陣列（可省略）。成功時：

| 欄位 | 內容 |
| --- | --- |
| `roleGroup` | 驗證後的身份組（id、名稱、角色、provider、版本、預設帳號、範圍、記憶範圍） |
| `rules` | 與 `resolveRules` 同形：`forbids`、`requires`、`instructions`、`sources`（每條含來源層級與版本）、`conflicts`（每項含來源與被擋下對象的層級與版本）。可直接交給 `src/memory/injection.js` 的 `renderContext` |
| `replaced` | 哪條規則（層級、版本）取代了哪條 |
| `permissions` | 每個工具的宣告值、有效值、`limitedBy`、`relaxationBlocked` 與「未強制」標示 |
| `digest` | `sha256:` 開頭，涵蓋身份組、有效規則（含來源與版本）與有效權限；輸入順序與機器的系統語系都不影響結果：id 一律以 UTF-16 碼位比較，不用 `localeCompare`（它會隨語系與 ICU 版本改變順序，進而改變摘要）。用來記錄「這個 session 拿到的是哪一套設定」。內含規則文字的雜湊，同樣屬本機私人資料 |

**輸入有任何問題就不給預覽**（`{ ok: false, problems }`，沒有 `rules`）：無效的規則、層級冒充、未知的層級名稱、重複 id、超出數量上限。理由：默默丟掉一條無效的平台 `forbid` 會讓 agent 以較弱的限制啟動。合成器若與驗證對「什麼是有效規則」的看法不一致，或合成途中出現未預期的錯誤，同樣不給預覽（`resolver-rejected-rule`、`internal-error`，不含錯誤訊息）。

`formatPreview(preview)` 產生給人看的純文字（含指示文字，僅限本機顯示）；失敗時只列代碼與位置。

## 6. 注入路徑（只描述）

預覽的 `roleGroup` 與 `rules` 即 `renderContext({ roleGroup, rules, memories })` 的輸入，之後由 #5 的 `planInjection` 把內容寫入**私人目錄**的檔案，命令列只帶檔案路徑（Claude Code：`--append-system-prompt-file`）或設定檔名稱（Codex：`-p mas-<token>`）。本模組自己不寫檔，也不會在 repo 中建立 `AGENTS.md`／`CLAUDE.md`；測試以靜態檢查確認 `src/roles/` 沒有引入檔案、行程或網路模組。測試只確認資料形狀相容，**不是**對真實 CLI 的注入驗證。

## 7. 失敗行為

| 情況 | 行為 | 測試 |
| --- | --- | --- |
| 身份組有未知欄位、錯誤型別或不安全的值 | `{ ok: false }`，問題只含代碼與路徑 | 是 |
| 規則自稱不同的層級、使用保留 id、有未知欄位 | 拒絕整份預覽 | 是 |
| 兩個層級使用同一個 id | 拒絕整份預覽 | 是 |
| 較弱層級試圖取代較強層級的規則 | 該規則不生效，衝突清單列出來源與對象的層級與版本 | 是 |
| 身份組 `allow` 與較強層級的 `forbid` 衝突 | `effective: deny`，列出 `limitedBy` 與 `permission-relaxation-blocked` | 是 |
| 未寫的工具權限 | `deny` | 是 |
| 輸入順序不同 | 結果與 `digest` 完全相同 | 是 |
| 輸入物件被凍結 | 不修改輸入，結果不與輸入共用物件 | 是 |

## 8. 未驗證與限制

- 沒有任何權限被強制（見第 4 節）；是否能以 CLI 原生機制強制任何一項，屬 broker／隔離與 P0 的驗證。
- 對真實 CLI 的注入、互動式 session 與 `--resume` 的效果沒有驗證（#5）。
- 規則文字沒有做憑證形態掃描；它是使用者自己寫的私人指示，儲存時由 `PrivateStore` 拒絕憑證形態（#35），注入前的掃描屬 #23。
- `role` 目前只是標籤；與 `src/publish-policy.js` 的 `pm`／`worker` 權限如何連動，屬 #16／#17。
- 路徑範圍只驗證字串形式，不檢查它們在磁碟上是否存在、是否為連結；實際工作目錄的路徑邊界檢查屬 #37 與 worktree 服務。
- 多個身份組之間的繼承（例如以模板衍生）不在本輪範圍；本輪的「繼承」指跨層級的合成。

## 9. 驗證

```
node --test test/roles/*.test.js test/memory/rules.test.js
```

CI（`.github/workflows/role-groups.yml`）在 macOS 與 Windows、Node 20 與 24 執行；Node 20 是專案鎖定的最舊執行環境。CI runner 的結果是 GitHub 託管環境，不是正式支援矩陣內的實機驗收。
