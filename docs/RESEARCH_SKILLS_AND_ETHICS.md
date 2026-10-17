# 研究 Skills 與學術倫理規範（Research Skills & Academic Ethics）

對應 Issue [#107](https://github.com/Disesfgewu/multiagentSystem/issues/107) 第 2 項與 Issue [#61](https://github.com/Disesfgewu/multiagentSystem/issues/61)。

本文件定義研究人員身份組（`researcher`）專屬的**已審查任務 Skills** 與**可驗證學術倫理規範（Academic Ethics Guard）**。純本機純邏輯模組，不連網、不下載未授權第三方套件，亦不宣稱已取得未實測的沙箱強制。

---

## 一、 五項已審查研究 Skills

所有 Skills 均由專案內部審查並內建（`src/research/skills.js`），**嚴禁從網路下載或由工作區（`.skills/`、`skills/`、`.mcp.json`）動態覆寫**；任何工作區試圖覆寫均會被安全忽略並發出警告（`workspace-skill-override-forbidden`）。

| Skill ID | 名稱 | 版本 | 允許工具（精確名稱） | 核心任務 |
| :--- | :--- | :--- | :--- | :--- |
| `paper-search` | Paper Search & Screening | `1.0.0` | `arxiv-mcp-server:search_papers`<br>`arxiv-mcp-server:get_abstract` | 檢索論文元資料與摘要；查詢需經隱私掃描；文獻內容視為不可信資料。 |
| `citation-verify` | Citation & Provenance Verification | `1.0.0` | `arxiv-mcp-server:get_abstract` | 比對識別碼、完整相等標題、日曆日期與引用片段 SHA-256；撤稿論文予以揭露。 |
| `novelty-compare` | Novelty & Related Work Comparison | `1.0.0` | `github-mcp-server:get_file_contents` | 比對專案文件評估新穎性；缺乏來源驗證或比較時強制降級為 `unknown`。 |
| `findings-deliver` | Research Findings Delivery | `1.0.0` | （無工具，純格式化交付） | 將發現以 `wrapUntrusted` 格式化，嚴防跳脫標籤；交付成果不得含工作區私密路徑或憑證。 |
| `zhtw-research` | Traditional Chinese Terminology Review | `1.0.0` | `zhtw-mcp:zhtw` | 檢視繁體中文學術用語標準（臺灣教育部規範）；純診斷輸出，不直接覆寫原始碼。 |

> [!IMPORTANT]
> **寫入工具零容忍**：所有 Skills 嚴格排除任何磁碟寫入或 GitHub 寫入工具（例如 `arxiv-mcp-server:download_paper`、`github-mcp-server:create_issue`、`write_file`），凡宣告寫入工具一律拒絕（`write-tool-forbidden`）。

---

## 二、 五大可驗證學術倫理規範（Academic Ethics Guard）

由 `src/research/ethics.js` 在交付階段自動執行驗證：

1. **引文來源真確性（Citation Provenance，防捏造引用）**：
   - 每一筆文獻引用必須來自經核實的工具回傳紀錄（`fromToolRecord` 產生的 DOI / arXiv ID），嚴禁由模型自由撰寫來源欄位（`hallucinated-citation-detected`）。
   - 缺少真實識別碼或未查證的項目，禁止宣稱 `verified`。

2. **不可信資料隔離與防 Prompt 注入（Untrusted Literature Isolation）**：
   - 外部文獻標題、摘要與引用全文均為不可信資料（`trust: 'untrusted-data'`）。
   - 系統自動掃描文獻中的對抗性 Prompt 注入特徵（如 `ignore previous instructions`、`system:`、`admin:`、`</untrusted-research-data>` 標籤跳脫）。
   - 文獻內容嚴禁被提升（elevate）至 system prompt 或規則層（`forbid` / `require`）。

3. **撤稿與更正透明度（Retraction & Correction Transparency）**：
   - 經標記為撤稿（`retracted: true`）的文獻，不得作為有效或新穎性依據（`retracted-paper-claimed-valid`）。
   - 必須顯式附帶撤稿警示（`warnings: ['retracted']`）。

4. **引用文字真確性（Quote & Claim Veracity）**：
   - 引文字句必須來自文獻摘要或標題之逐字原文，並通過 SHA-256 完整性雜湊核對（`quote-integrity-mismatch`）。
   - 禁止斷章取義或扭曲原作者主張。

5. **隱私與敏感資訊隔離（Privacy & Sensitive Content Containment）**：
   - 交付至 PM 或其他角色的研究報告必須先通過 `scanPublication` 掃描，確保零私密憑證、API Key 或工作區本機路徑洩漏。

---

## 三、 與角色預覽與指令傳交之整合

在角色群組預覽（`describeRoleGroup` 與 `formatPreview`）中：
- 當角色為 `researcher` 時，自動展示已審查的 5 項 Research Skills 與 5 項 Academic Ethics 規範。
- 使用者可在啟動 native terminal 前在虛擬唯讀文件內核對研究能力與倫理防護邊界。
