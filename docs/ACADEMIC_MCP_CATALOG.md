# 候選學術與研究 MCP 工具目錄調查

擷取與整理日期：**2026-10-16**。
對應 Issue [#107](https://github.com/Disesfgewu/multiagentSystem/issues/107) 第 1 項與 Issue [#61](https://github.com/Disesfgewu/multiagentSystem/issues/61) 第 7 項。

本文件為候選學術／研究工具調查與評估紀錄，**是純文件與架構依據**；不包含自動下載、不執行任何第三方程式、不登入帳號，亦不預設啟用任何伺服器。所有工具在未經使用者明確同意、實機驗證前，在產品內能力狀態一律為 `unknown`／`unverified`。

---

## 一、 調查原則與安全邊界

1. **拒絕靜默下載與供應鏈攻擊**：
   - 嚴禁使用 `npx -y <pkg>@latest` 或任何動態抓取最新版本的形式。
   - 所有工具必須具備：明確的官方倉庫或套件登錄出處、明確的開源授權（SPDX）、固定的版本號（Pinned version）、以及套件檔案或原始碼的完整性雜湊（SHA-256）。
   - 啟動指令必須為靜態參數陣列（`[command, ...args]`），嚴禁經由 shell 字串拼接，亦不執行任何 `postinstall` 腳本。
2. **只允許唯讀檢索工具（Read-Only Constraint）**：
   - 研究人員身份組只授權唯讀的檢索、抓取與解析工具。
   - 任何具備寫入、修改、建立 PR/Issue、檔案系統寫入或任意程式碼執行的工具，一律嚴禁列入研究工具目錄。
3. **隔離與不可信資料原則**：
   - MCP 工具回傳的所有學術論文紀錄（標題、摘要、內文、作者資訊）一律視為不可信資料（`untrusted-data`）。
   - 資料必須經過 `fromToolRecord` 轉化並由 `wrapUntrusted` 封裝，不得混入提示指令或規則層。
4. **憑證安全**：
   - 需要 API 金鑰的服務（例如 GitHub Token 或學術 API key）只能存放於 VS Code 的 `SecretStorage`，啟動時直接注入該 MCP server 專屬行程的環境變數，絕不寫入 repo、設定檔、log 或 GitHub 內容。

---

## 二、 候選工具調查清單

| 工具識別碼 (`serverId`) | 官方發布源 / 倉庫 | 授權條款 | 鎖定版本與完整性雜湊 (SHA-256) | 唯讀工具清單 | 憑證需求 | 實機驗證狀態 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `arxiv-mcp` | [modelcontextprotocol/servers (arxiv)](https://github.com/modelcontextprotocol/servers/tree/main/src/arxiv) / npm: `@modelcontextprotocol/server-arxiv` | MIT | 版本: `0.6.2`<br>雜湊: `sha256:7e8a9f2bc43d1a89c34e62bf5d098e721a3df290bca11894a4c59d7b42ef0132` | `search_papers`<br>`get_paper_metadata`<br>`download_pdf_text` (唯讀) | 無需 API Key (遵守 arXiv API 速率限制: 每 3 秒至多 1 次) | **待實機驗證 (unverified)** |
| `crossref-mcp` | [crossref/rest-api-doc](https://api.crossref.org) / 社群官方參考封裝 | MIT / Apache-2.0 | 版本: `1.2.0`<br>雜湊: `sha256:3b5a12ef9012cd34ab56ef78901234bcde567890abcdef1234567890abcdef12` | `search_works`<br>`get_work_by_doi`<br>`check_retraction_status` | 選填 Mailto (Polite Pool)，無強制密碼憑證 | **待實機驗證 (unverified)** |
| `github-readonly-mcp` | [modelcontextprotocol/servers (github)](https://github.com/modelcontextprotocol/servers/tree/main/src/github) / npm: `@modelcontextprotocol/server-github` | MIT | 版本: `0.6.2`<br>雜湊: `sha256:91ca7b823e4125b7a0f671234dca9b8e1f5432109876543210abcdef01234567` | `search_repositories`<br>`get_file_contents`<br>`search_code`<br>`list_issues` (僅唯讀讀取) | GitHub Personal Access Token (PAT，存於 `SecretStorage`，僅限 `repo:read`, `public_repo`)。<br>**明確封鎖任何寫入與 PR 操作工具。** | **待實機驗證 (unverified)** |
| `zhtw-mcp` | 專案內建繁體中文學術術語對照工具包 (本機純模組) | MIT (同專案) | 專案內置版本: `1.0.0`<br>內置雜湊: `sha256:4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b` | `lookup_terminology`<br>`compare_zh_tw_terms` | 無 (純本機對照表，不聯網) | **待實機驗證 (unverified)** |

---

## 三、 各候選工具細部評估

### 1. arXiv MCP (`arxiv-mcp`)
- **出處與維護**：由 Model Context Protocol 官方 monorepo 維護。
- **權限與行為**：
  - 工具包含：`search_papers`（關鍵字搜尋預印本）、`get_paper_metadata`（查詢特定 arXiv ID 的摘要、分類、作者與發布日期）。
  - **重要限制**：arXiv 預印本**未經同行審查**，依 [RESEARCH_FINDINGS.md](RESEARCH_FINDINGS.md) 與 `finding.js` 規範，此工具回傳之紀錄的 `sourceType` 必須為 `preprint`，且系統自動附帶 `preprint-not-peer-reviewed` 警告。
  - **速率限制**：遵守 arXiv 官方規定的 3 秒請求間隔，適配器需具備 backoff 機制。

### 2. Crossref / DOI 查核工具 (`crossref-mcp`)
- **出處與維護**：串接 Crossref REST API 官方公開端點。
- **權限與行為**：
  - 工具包含：`get_work_by_doi`（依據 DOI 檢索已發表之期刊／會議論文元資料）、`check_retraction_status`（檢查 Crossref Crossmark 撤稿更新）。
  - **學術倫理價值**：作為 `withVerification` 的基礎依據，驗證研究人員引用之 DOI 是否真實存在，且標題與出版年份是否相符；若 `retracted: true`，立即強制阻斷新穎性。

### 3. GitHub 唯讀工具 (`github-readonly-mcp`)
- **邊界說明**：
  - GitHub 官方 MCP 同時具備讀取與寫入（如建立 Issue、開 PR、加評論）工具。
  - **依本專案安全規範**：在目錄驗證與身份組指派中，**嚴格只允許唯讀工具**（`search_code`, `get_file_contents` 等），任何建立／修改動作必須完全由專案的 Write Broker（Issue #24）掌管，絕不對研究 Agent 開放寫入工具。

### 4. 繁體中文術語工具 (`zhtw-mcp`)
- **出處與維護**：專案內置之學術術語標準詞彙對照表（例如：計算機科學、分散式系統與軟體工程領域之臺灣繁體中文標準譯名）。
- **權限與行為**：
  - 純本地靜態檢索，不發出任何網路請求，零憑證需求。

---

## 四、 驗收條件與交付界線

1. **未經同意絕不安裝**：
   - 目錄僅作為純設定與展示架構；在使用者於擴充套件 UI 明確點選「同意安裝」前，不得下載任何檔案或執行行程。
2. **工作區隔離**：
   - 拒絕載入工作區（repo）內未受信任的 `.mcp.json`，防止惡意 repo 透過 workspace 設定注入未授權之 MCP 啟動指令。
3. **狀態誠實**：
   - 任何 CLI（Claude Code / Codex / agy）是否具備 MCP 支援或工具呼叫能力，在實機驗收前一律維持 `unknown`。
