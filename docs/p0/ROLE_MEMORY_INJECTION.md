# P0：身份組規則與私人記憶注入

對應 Issue #5，以及 `docs/IMPLEMENTATION_PLAN.md` 的 R04、R05、R08。

狀態：**部分驗證**。macOS 上完成了兩個 CLI 的注入路徑實測、角色範圍隔離、候選／採納流程與發布前檢查的單元與實驗驗證；單元測試另在 CI 的 macOS 與 Windows runner 通過。原生 Windows 上的 CLI 行為、互動式 session 的實際效果與記憶的 A/B 成本量測尚未完成，見第 9 節。

測試環境：macOS（Darwin 25.6）、Node.js 24、Claude Code 2.1.299、Codex CLI 0.162.1，實測日期 2026-10-14。全部使用合成資料；本文不含真實規則、記憶、帳號或 session 資訊。

## 1. 結論摘要

| 項目 | 結果 |
| --- | --- |
| Claude Code：以私人檔案注入角色規則與記憶 | **可行**：`--append-system-prompt-file <私人檔案>`，內容不進命令列（`-p` 模式已用真實請求驗證） |
| Claude Code：依任務挑選片段的動態注入 | **可行**：SessionStart hook 的 `additionalContext`，經 `--settings <檔案>` 載入（`-p` 模式已驗證；上限 10,000 字元） |
| Codex：以私人檔案注入角色規則與記憶 | **可行**：`$CODEX_HOME/<名稱>.config.toml` 的 `developer_instructions`，以 `-p <名稱>` 載入，命令列只有名稱（已用 `codex debug prompt-input` 驗證模型可見輸入，未呼叫模型） |
| 必須避免的路徑 | `--append-system-prompt "<文字>"`、`-c developer_instructions="<文字>"`（內容進命令列）、repo 內的 `CLAUDE.md`／`CLAUDE.local.md`／`AGENTS.md`（在工作樹內） |
| 記憶範圍邊界 | 以 `(repoId, roleGroupId, privacyDomain)` 完全相符檢索；其他身份組取不到（單元測試與兩個 CLI 實驗皆驗證） |
| 發布內容不含私人片段 | 可偵測逐字或輕度改寫的重用與常見密鑰形態；**無法**偵測語意改寫，發布前仍需人類審核 |
| 是否能宣稱節省 token | **尚不能**。本 Issue 只提出量測方案（第 8 節），未做成本實驗 |

## 2. 最小資料關係與優先順序

實作位於 `src/memory/`，資料全部存放在 repo 之外。

| 實體 | 關鍵欄位 | 說明 |
| --- | --- | --- |
| 身份組 `RoleGroup` | `id`、`name`、`role` | 規則與記憶的歸屬單位。 |
| 規則 `Rule` | `id`、`layer`、`type`（`forbid`／`require`／`instruction`）、`key` 或 `text`、`version`、`replaces?` | 由五個層級組成。 |
| 記憶 `MemoryItem` | `repoId`、`roleGroupId`、`privacyDomain`、`content`、`source{kind,ref,digest}`、`createdAt`、`verifiedAt`、`ttlMs`、`status`、`approvedBy`、`version` | 檢索的範圍鍵是 `(repoId, roleGroupId, privacyDomain)`。 |
| 注入計畫 `InjectionPlan` | `provider`、`method`、`files`、`argv`、`root`、`repoRoot`、`exclusiveDir`、`created` | 內容只在 `files`；`argv` 只含檔案路徑或 profile 名稱；`created` 記錄 `writePlan` 實際建立的項目，清理只處理這些。 |

**規則層級（由強到弱）**：平台 → 使用者 → 專案 → 身份組 → 任務。

- 弱層級只能**新增**限制與指示，不能取代或移除強層級的規則；嘗試取代時該規則被忽略並記錄衝突（`cannot-replace-stronger-layer`）。
- 強層級可以用 `replaces` 取代同層或較弱層級的規則。取代由強到弱依序套用，**只有仍然有效的規則能取代別人**：被取代或被忽略的規則不會再移除任何東西。
- **規則 ID 必須唯一。** 多條規則共用同一個 ID 時，保留最強層級者（同層級依 `forbid` ＞ `require` ＞ `instruction`，再以內容決定），其餘記錄為 `duplicate-id`；結果與輸入順序無關，因此較弱規則不能靠重用平台規則的 ID 來移除限制。
- 同一個 `key` 的 `forbid` 與 `require` 衝突時，強層級勝出；同層級時**禁止優先**（fail-closed）。
- 解析結果包含套用規則的來源與版本，作為「有效設定」預覽的資料來源。

這與計劃書第 3.3 節的順序一致；介面預覽與規則編輯不在本 Issue 範圍。

## 3. 注入路徑調查

「命令列」欄指內容文字是否會出現在行程引數或 shell 歷史中；「repo」欄指檔案是否位於 Git 工作樹內。

### 3.1 Claude Code 2.1.299

| 路徑 | 命令列 | repo | 依角色區分 | 驗證 | 備註 |
| --- | --- | --- | --- | --- | --- |
| `--append-system-prompt-file <檔案>` | 只有路徑 | 否 | 是（每次啟動可不同） | **已驗證**（`-p`，真實請求） | 官方文件稱互動與非互動模式皆可用；互動模式未實測 |
| SessionStart hook `additionalContext`，經 `--settings <檔案>` | 只有路徑 | 否 | 是 | **已驗證**（`-p`） | 官方文件：超過 10,000 字元會改存檔案並只給 2,000 字元預覽；適合挑選過的少量片段 |
| `--append-system-prompt "<文字>"` | **含內容** | 否 | 是 | 文件確認存在；不採用 | 行程引數可被同使用者的其他行程讀到，也進入 shell 歷史 |
| `<設定目錄>/CLAUDE.md`（官方文件寫為 `~/.claude/CLAUDE.md`） | 無 | 否 | **否**（依帳號） | **未驗證**（需要已登入的設定目錄） | 與帳號 profile 綁定，不適合角色層級 |
| repo 的 `CLAUDE.md`、`.claude/CLAUDE.md`、`AGENTS.md` | 無 | **是（被追蹤）** | 否 | 除錯日誌確認會被載入 | 不得放私人內容 |
| `CLAUDE.local.md` | 無 | **是（工作樹內，需自行 gitignore）** | 否 | 文件確認 | 違反「私人內容不在 repo」的規則，且只存在於單一 worktree |
| `--system-prompt-file` | 只有路徑 | 否 | 是 | 文件確認 | **取代**預設提示詞，會丟失工具與安全指引，不採用 |
| `--bare` | — | — | — | 文件確認 | 跳過 CLAUDE.md 並且不讀取 keychain，與訂閱登入不相容，不採用 |

另有三項實測／文件上的限制：

- `claude --help` **沒有**列出 `--append-system-prompt-file`（官方文件也說 help 不完整），但旗標可用。能力偵測因此以「對不存在的檔案使用旗標，看是否被參數解析器回報 `unknown option`」進行，不呼叫模型。
- 提示詞在對話第一次請求時被記錄；之後以 `--resume`／`--continue` 傳入不同的規則文字，**要等到壓縮或新對話才生效**（`--system-prompt-snapshot off` 可改為每次重建）。更新身份組規則後，既有 session 不會立即套用。
- 注入內容屬於「上下文」而非強制設定；官方文件指出要強制阻擋行為須使用 PreToolUse hook 等機制。本產品的強制規則仍須由執行環境或 broker 執行，不能因為提示詞寫了「必須」就宣稱已強制。

### 3.2 Codex CLI 0.162.1

以下結果由 `codex debug prompt-input`（輸出模型可見的輸入清單，不呼叫模型）取得。

| 路徑 | 命令列 | repo | 依角色區分 | 驗證 | 備註 |
| --- | --- | --- | --- | --- | --- |
| `$CODEX_HOME/<名稱>.config.toml` 的 `developer_instructions`，以 `-p <名稱>` 載入 | 只有名稱 | 否 | 是（每個 session 一個名稱） | **已驗證** | 內容出現在 `developer` 角色訊息；檔案位於該帳號的 `CODEX_HOME`，須在 session 結束後清除 |
| `$CODEX_HOME/AGENTS.md`（全域） | 無 | 否 | **否**（依帳號） | **已驗證** | 與 repo 的 `AGENTS.md` 同時出現；`AGENTS.override.md` 存在時**取代**全域 `AGENTS.md` |
| `-c developer_instructions="<文字>"` | **含內容** | 否 | 是 | **已驗證可用**；不採用 | 與 Claude 的內嵌文字同樣有命令列曝光 |
| repo 的 `AGENTS.md` | 無 | **是（被追蹤）** | 否 | **已驗證** | 對所有身份組可見；不得放私人內容 |
| `model_instructions_file` | 只有路徑 | 否 | 是 | 文件確認 | **取代**內建指示，不採用 |

補充：

- 另一個 `CODEX_HOME` 看不到上述全域檔案與 profile，但仍會看到 repo 的 `AGENTS.md`。這同時說明 repo 檔案對所有人可見。
- Codex 另有內建的記憶功能（`memories.use_memories`，依官方設定參考）。本產品的記憶與 CLI 內建記憶可能重複，A/B 量測必須兩組固定相同的內建設定。
- `prompt-input` 只證明「模型可見的輸入」，不證明模型行為；互動式 TUI session 未實測。

### 3.3 共通限制

- 命令列曝光是作業系統行程模型的一般性質，**本實驗未針對各平台逐一驗證**；設計上直接避開，不依賴它。
- **寫入在實際檔案層級檢查**（`writePlan`）：自私人根目錄逐層往下，不存在的目錄由本次呼叫逐一建立並記錄；已存在的目錄若是符號連結／junction、不是目錄或（POSIX）不屬於目前使用者就拒絕；最終解析後的位置必須在 repo 之外且仍在私人根目錄之內。因此頂層在 repo 外、但 `sessions` 是指向 repo 的連結時，不會寫進 repo。
- **排他建立**：session 目錄必須是新建立的，檔案以 `wx` 建立，不覆寫既有檔案，也不信任既有檔案的權限；重複的 session token 會被拒絕，且不影響原本的內容。檔案 `0600`、目錄 `0700` 在 POSIX 已有測試；**Windows 的存取控制與擁有權檢查未驗證**，目前只能依賴使用者設定檔目錄的預設權限。
- **清理只處理本次建立、而且仍是同一個物件的項目**（`cleanupPlan`）：建立時記錄每個檔案與目錄的身分（裝置與 inode；POSIX 與 Windows 皆以 bigint 取得），檔案另記錄大小與內容雜湊。清理時只有**身分相同、而且檔案內容與寫入時完全一致**的檔案才會刪除；目錄身分相同才會移除，而且只用 `rmdir`（非空就不動），不做遞迴刪除。名稱相同但已被換成別人的檔案或目錄（不同身分、內容被改、換成連結、目錄裡多了別人的檔案）一律保留，回報 `{ removed, skipped: [{ kind, reason }] }`，原因為 `replaced`、`content-changed`、`replaced-by-link`、`not-empty`、`identity-unavailable`，**不含路徑**。檔案系統不提供可用的身分（inode 為 0）時不刪除（fail closed）。已知限制：身分相同且內容相同的替換物（例如 inode 被立刻重用、內容又一樣）無法與原物區分，刪除它不會造成資料損失。CLI 非預期結束時是否殘留，需要 P1 的 session 管理處理，本 Issue 未實作。
- 路徑解析只把 `ENOENT` 視為「尚未建立」；權限錯誤、迴圈、`ENOTDIR` 與無錯誤碼的失敗一律拒絕（`private-root-unresolvable`），不會通過檢查。**一路 `ENOENT` 走到磁碟根目錄**（例如沒有掛載的 `Z:\`）同樣拒絕，因為沒有任何一層被驗證；**最近的既有祖先必須是目錄**（Windows 對檔案之下的路徑回報 `ENOENT`，macOS 回報 `ENOTDIR`，兩者一致拒絕）。
- 無法使用上述路徑的 CLI 或版本，退回**手動方案**：產品把內容寫到私人檔案，由使用者開啟後貼入 terminal。不會產生任何可被 Git 追蹤的檔案。

## 4. 記憶候選與採納流程

```text
任務／agent 產出候選 → 形態掃描 → 去重 → candidate → 具名核可者採納 → adopted
                                  ↓                       ↓
                               拒絕並回報原因      來源改變 → stale；到期 → 不再檢索
```

- **掃描**：符合密鑰、token、email、本機家目錄路徑、UUID 形態的內容在 `propose` 就被拒絕，回報的只有代碼，不回傳也不儲存原文。
- **採納**：`adopt` 需要具名核可者（`human` 或 `rule` 加上識別碼）；單純的布林值不被接受。候選未採納前不會被檢索。
- **範圍**：檢索要求 `repoId`、`roleGroupId`、`privacyDomain` 三者完全相符；回傳結果不含其他範圍是否存在記憶的任何資訊。跨身份組或跨專案共享需另行設定（本 Issue 未實作）。
- **新鮮度**：來源檔案的摘要改變或消失時 `revalidate` 把記憶標為 `stale`；超過 `ttlMs`（預設 30 天，暫定值）後不再檢索。
- **預算與相關性**：只取與任務文字有詞彙重疊的項目，依分數排序並受字元預算限制；中文以雙字詞比對。這是基線方法，沒有向量檢索（符合計劃書）。
- **長度**：攤平（去掉空白與標點）後少於 6 個字元的項目在 `propose` 就被拒絕（`too-short`），因為無法在外送文字中可靠比對。
- **儲存與路徑**：JSON 檔案，`0600`。目錄在建構時檢查（在 repo 內或包含 repo 就拒絕），並且**每次讀取與寫入都重新檢查**：目錄被換成指向 repo 的連結、位置被檔案佔用、不屬於目前使用者（POSIX）、`memory.json` 是連結或不是一般檔案，都回報 `directory-rejected`／`unsafe-path` 並且不寫入、不讀取；取鎖與建立目錄**之前**就先檢查，因此上層被換成連結時不會在 repo 內建立任何目錄。檢查與使用之間有無法排除的極短時間窗，目錄應只有使用者本人可寫。
- **並行**：每次寫入先取得目錄內的鎖檔（排他建立），**在鎖內重新讀取**檔案再套用變更，最後以暫存檔加 rename 原子替換，所以兩個實例或行程不會互相覆蓋對方的更新（4 個行程各 5 筆的測試全數保留，拿掉鎖後該測試穩定失敗）。**鎖不會因為「看起來太久」而被取走**：鎖內容記錄持有者的行程代號、主機與 token；持有者行程仍存在（即使超過過期時間）就回傳 `locked`（`owner-alive`）；持有者已崩潰回傳 `locked`（`owner-dead`），**不自動清除**，由 `recoverLock({ confirm: 'recover-stale-lock' })` 清除；另一台主機或無法解析的鎖、以及仍存在的持有者，需要 `force: true` 並且鎖已超過過期時間（由人判斷，例如行程代號被重用）。釋放時只刪除自己持有的鎖。代價是崩潰後需要一次明確的復原。鎖是建議性的、只作用於同一目錄、不支援網路檔案系統。
- **損壞與版本不符**：JSON 無法解析、`schemaVersion` 不符或結構不對時，儲存庫回報 `corrupt`／`unsupported-schema`，所有寫入回傳 `store-unavailable`，**原檔一位元組都不改**；讀取回傳空結果並在 `select` 的 `unavailable` 欄位說明原因，讓呼叫端分得出「沒有記憶」與「讀不到」。

## 5. 發布前私人片段檢查

`findPrivateFragments` 對外送文字（Issue、PR、留言、commit 訊息）做兩種檢查：

1. 與已採納記憶及私人規則的**逐字或輕度改寫**重疊（忽略大小寫、空白與標點）。依私人文字攤平後的長度：
   - 20 個字元以上：任一連續 20 個字元出現在外送文字即命中。
   - 6 到 19 個字元：整段出現在外送文字即命中（例如已知的短暗號）。
   - 少於 6 個字元：無法在不誤判一般詞彙的情況下比對，列在回傳的 `unmatchable`，**不會被靜默忽略**；記憶庫本身不收這麼短的項目。
2. 常見密鑰與身份形態（同第 4 節的掃描）。

限制（需寫入任何對外宣稱）：

- 語意改寫、翻譯、摘要**偵測不到**；計劃書第 3.5 節已說明，外部發布仍需人類審核。
- 6 到 19 個字元的短片段以整段比對，常見詞彙形態的短項目可能造成誤判（fail-closed），需人工處理。
- UUID 與 email 形態採 fail-closed，可能誤判公開內容，需人工處理。
- 這是**偵測器**，不是權限邊界；直接 `git`、`gh` 或 HTTP 寫入不經過它，仍屬 #4 的範圍。

## 6. 可重現實驗

```text
node scripts/p0/check-memory-injection.js [--repo <路徑>] [--live-claude [--model <別名>]]
```

預設不呼叫任何模型。`--live-claude` 會以目前登入的帳號送出 3 次極小請求（對照組＋兩個身份組），只問「暗號是什麼」，不會回述任何私人記憶。

流程使用隨機的合成暗號，建立兩個身份組各一條已採納記憶，並檢查：

| 檢查 | macOS 結果 |
| --- | --- |
| 私人目錄在 repo 之外 | 通過 |
| 身份組 A／B 只檢索到自己的記憶，第三個身份組檢索不到 | 通過 |
| Codex：命令列只有 profile 名稱；模型可見輸入含自己的暗號、不含另一個身份組的暗號；不帶 profile 時兩者皆無 | 通過 |
| Claude：命令列只有檔案路徑；（`--live-claude`）對照組回報不知道暗號，A／B 各回報自己的暗號 | 通過 |
| 發布檢查：含記憶片段的 PR 本文被擋，一般公開文字通過 | 通過 |

含 `--live-claude` 的完整執行共 20 項檢查：20 項通過、0 項跳過、0 項失敗；不加旗標時 Claude 的即時請求檢查標為跳過。

單元測試：`node --test "test/memory/*.test.js"`（71 項，合成資料；涵蓋規則優先順序與重複 ID、記憶庫的並行、損壞處理、目錄被換成連結、鎖的持有與崩潰、注入計畫的連結／排他建立／依身分清理、路徑規則、密鑰形態與發布檢查，其中包含 4 個行程的並行寫入與獨立行程持鎖、崩潰的測試）。

## 7. 資料來源：可用的用量欄位

為了讓第 8 節的量測可行，另外以各一次極小請求確認兩個 CLI 回報的欄位名稱：

| CLI | 取得方式 | 欄位 |
| --- | --- | --- |
| Claude Code | `claude -p --output-format json` | `usage.input_tokens`、`usage.output_tokens`、`usage.cache_creation_input_tokens`、`usage.cache_read_input_tokens`；另有 `total_cost_usd`（用戶端估算）、`duration_ms`、`num_turns`、`modelUsage` |
| Codex CLI | `codex exec --json` 的 `turn.completed` 事件 | `usage.input_tokens`、`usage.cached_input_tokens`、`usage.cache_write_input_tokens`、`usage.output_tokens`、`usage.reasoning_output_tokens` |

兩者的計量範圍與計價方式不同，**不得相加或換算成單一數字**。

## 8. 節省 token 的 A/B 量測方案

目標：只有在**總成本下降且品質不退步**時，才能宣稱「節省」。單次輸入縮短量不算成效。

**設計**

- 兩組：記憶關閉（對照）與記憶開啟（本產品的精選記憶）。兩組固定相同的 CLI 版本、模型、推理強度、帳號類型，以及 CLI 內建記憶設定（Claude 的 auto memory、Codex 的 `memories.use_memories`）。
- 任務集：預先固定、與 repo 實際工作相近，且每題有可自動判定的驗收測試。每題每組至少重複 3 次，順序隨機，每次使用乾淨的 worktree。
- 同一 provider 內比較；不同 provider 分開報告。

**每次執行記錄**

| 類別 | 欄位 |
| --- | --- |
| 供應商回報的用量 | 第 7 節的輸入、輸出、快取讀寫、推理 token；Claude 的 `total_cost_usd` 另列並標示為估算 |
| 記憶成本 | 檢索與注入的字元數與估算 token（標示為估算）；建立候選與審核所花的請求用量，依其服務的任務數攤提 |
| 時間與過程 | 牆鐘時間、回合數、重試與返工次數 |
| 品質 | 驗收測試是否通過、審查者依固定評分表的結論、PR 被要求修改的次數 |

**判讀規則**

- 總量 ＝ 供應商回報的各類 token ＋ 記憶成本；各類別也分別呈現，不合併成單一「剩餘百分比」。
- 以成對差異與信賴區間報告；樣本不足時只報告趨勢，不下結論。
- 無法取得供應商實際用量的項目標為「未知」，不以字元數換算後當作節省結論。
- 注入內容在 Claude 以固定順序輸出以利快取；是否真的提高快取命中須以 `cache_read_input_tokens` 實測，不能假設。

這個方案需要真實任務集與重複執行，**本 Issue 沒有執行**，因此不提出任何節省數字。

## 9. 平台矩陣與尚未驗證項目

| 項目 | macOS | 原生 Windows |
| --- | --- | --- |
| 單元測試（規則、記憶庫、注入計畫、路徑、發布檢查） | 本機與 CI 通過 | CI 的 `windows-latest` runner 通過（見 PR 的最新 CI 結果，含真實檔案系統的寫入、rename、鎖與清除）；GitHub 託管環境，僅邏輯層，不含 CLI，**不是**正式支援矩陣內的實機驗收 |
| Codex profile／全域指示注入 | 已驗證（`prompt-input`） | **未驗證**（無設備） |
| Claude 檔案注入、SessionStart hook | 已驗證（`-p`） | **未驗證**（無設備） |
| 私人檔案權限 | `0600` 已測試 | **未驗證**（需確認 ACL） |
| 引數引用（含空白與 Unicode 路徑、`.cmd` 捷徑） | — | **未驗證**；實驗腳本的 Windows 路徑為最佳努力 |

其他尚未驗證：

| 項目 | 阻礙 |
| --- | --- |
| 互動式 TUI session 中兩個 CLI 的實際注入效果與 `--resume` 行為 | 需要互動式 terminal 的人工實測 |
| `<設定目錄>/CLAUDE.md` 在 `CLAUDE_CONFIG_DIR` 下是否載入 | 需要已登入的獨立設定目錄（見 #3 的第二帳號阻礙） |
| Codex 模型實際回答是否遵循注入內容 | 本次只驗證模型可見輸入，未呼叫模型 |
| SessionStart hook 在互動模式與 `--settings` 的行為 | 官方文件對 `--settings` 是否可定義 hook 未明載；僅 `-p` 實測 |
| 記憶 A/B 成本與品質 | 需要任務集與重複執行（第 8 節） |
| 身份組／記憶的編輯介面、有效設定預覽、與 session 儲存的整合 | 不在本 Issue 範圍（P2、P3） |

## 10. PM 決策紀錄

以下為 PM 在 review 中確認的決策（#30 的 review，2026-10-14）：

1. 30 天 TTL 為可調整的原型預設。
2. 維持拒絕含身份或秘密形態的候選。
3. Codex 的暫存 profile 必須有 session 擁有權與安全清理（本版以排他建立、逐項記錄身分與內容、只清理仍是同一個物件的項目實作；session 結束與崩潰後的回收仍屬 P1 的 session 管理）。
4. 第一版先採已確認能力的檔案注入（`--append-system-prompt-file`、Codex profile 檔案）；SessionStart hook 保留研究，不覆寫使用者的設定。
5. #5 保留開放，直到兩平台的互動模式與 `--resume` 注入驗收完成；總成本 A/B 由 #22 接續。
6. 目前 GitHub 發布與 review 使用同一個 actor，上述 review 是獨立程式檢查的 review 留言，不代表 GitHub 正式 `APPROVE`／`REQUEST_CHANGES` 流程已驗證。

另外，在第二次 review 後補上（#30，2026-10-14）：

7. 記憶庫的目錄在每次讀寫時重新檢查；清理依檔案身分與內容核對；鎖不再依時間自動取走仍在執行的寫入者，崩潰後以明確的 `recoverLock` 復原。鎖已與私人儲存共用同一個模組（`src/shared/lock.js`，#37）；與 #7、#35 重複的路徑檢查仍各自獨立，留給 #37 之後的 PR。
