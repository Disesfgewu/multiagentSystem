# 候選學術與研究 MCP 工具目錄調查

擷取與核實日期：**2026-10-16**（GitHub 官方 API 與倉庫實際檢索）。
對應 Issue [#107](https://github.com/Disesfgewu/multiagentSystem/issues/107) 第 1 項與 Issue [#61](https://github.com/Disesfgewu/multiagentSystem/issues/61) 第 7 項。

本文件為使用者**明確指定之三個 MCP 來源**的調查與評估紀錄，**是純文件與候選架構依據**；不包含自動下載、不執行任何第三方程式、不登入帳號，亦不預設啟用任何伺服器。PM 與擴充套件目前**沒有安裝任何 MCP**。未實測之能力與雜湊一律標為 `unknown`／`unverified`，絕不編造示意值。

---

## 一、 調查原則與安全邊界

1. **唯一真實來源約束**：
   - 嚴格限定於使用者指定的精確倉庫（`sysprog21/zhtw-mcp`、`blazickjp/arxiv-mcp-server`、`github/github-mcp-server`），不得以同名套件、社群 fork 或推測之 npm 套件代替。
2. **拒絕動態安裝與供應鏈攻擊**：
   - 嚴禁使用 `npx -y <pkg>@latest` 或任何動態抓取最新版本的形式。
   - 啟動指令必須為靜態參數陣列（`[command, ...args]`），嚴禁經由 shell 字串拼接，亦嚴禁包含 eval 標誌（如 `-e`, `-c`）或 shell 直譯器（`/bin/bash`, `cmd.exe`, `powershell`）。
3. **區分「自我宣告」與「沙箱強制」**：
   - 工具定義中的 `readOnly: true` 僅屬 schema 層級的自我宣告，**執行階段目前尚未獲得沙箱強制（`sandboxEnforced: false`）**，文件與程式碼均不得宣稱「已受系統限制」。
   - 候選清單中若包含寫入、修改或下載至磁碟的工具，必須在研究人員的身份組 allowlist 中被嚴格排除，只授權已核實的唯讀工具。
4. **憑證與環境變數嚴格隔離**：
   - 需要 API 金鑰的服務只能存於 VS Code 的 `SecretStorage`。目錄僅允許宣告 `secret: true`，嚴禁內聯任何非機密環境變數或真實金鑰值，絕不寫入 repo、log 或 GitHub 內容。

---

## 二、 三大指定工具詳細核實清單

### 1. 繁體中文語意校正工具：`zhtw-mcp`
- **精確倉庫來源**：`https://github.com/sysprog21/zhtw-mcp.git`
- **開源授權**：**MIT**（核對自倉庫根目錄 `Cargo.toml`）
- **官方版本與 Commit 狀態**：
  - Crate 版本：`0.1.0`（`Cargo.toml`）。
  - Release / Tag 狀態：官方發布 tag 為動態 `latest`，對應之固定 commit SHA 為 **`0485df42b26e08e7e9d00da0a5c773ca99bedbd7`**（2026-10-11）。
  - **版本鎖定依據**：因官方尚未釋出固定 SemVer tag（如 `v0.1.0`），本專案若啟用必須以固定 commit `0485df42b26e...` 鎖定，不得直接依賴動態 `latest` tag。
- **發行資產與雜湊證據**：
  - Windows x86_64: `zhtw-mcp-x86_64-pc-windows-msvc.tar.gz`（官方 digest: `sha256:5a0725835205a75d1ec57e13cf58e1b363488de9acdb250df372d7843105c71f`）。
  - Linux x86_64: `zhtw-mcp-x86_64-unknown-linux-gnu.tar.gz`（官方 digest: `sha256:d67c8426c066631e6cd570d5e6b540ea717a15160fd9691936fa394fe7f48db4`）。
  - **macOS (arm64/x86_64)**：官方 release 目前**無獨立預編譯二進位資產**，macOS 下二進位雜湊為 **未驗證（unverified，需本機由原始碼編譯驗收）**。
- **實際暴露之 Tools**：
  - `zhtw`：針對繁體中文（臺灣教育部標準與兩岸用語對照）的統一文字校正與檢核工具。
  - 工具性質：純文字輸入與診斷輸出，不直接修改原始碼檔案。
- **憑證需求**：無（純本機語意分析，無外部 API Key）。
- **實機驗證狀態**：**待實機驗證 (unverified)**。

---

### 2. arXiv 文獻工作伺服器：`arxiv-mcp-server`
- **精確倉庫來源**：`https://github.com/blazickjp/arxiv-mcp-server.git`
- **開源授權**：**Apache-2.0**（核對自倉庫 `pyproject.toml`）
- **官方版本與 Commit 狀態**：
  - 固定 Release Tag：**`v0.8.2`**（核對自 GitHub Tags 與 `server.json`）。
  - 對應 Commit SHA：**`572e301bb3198962c025d5ed5e14becb86868daa`**（2026-10-08）。
- **發行資產與雜湊證據**：
  - PyPI 套件識別碼：`arxiv-mcp-server==0.8.2`。
  - 套件二進位／原始碼發行檔雜湊：**待下載後核實完整性雜湊 (unverified)**，禁止預先編造虛構 SHA。
- **實際暴露之 Tools**：
  - 唯讀檢索類（允許候選）：
    - `search` / `search_papers`：依關鍵字或主題搜尋 arXiv 論文元資料。
    - `get_abstract`：檢索指定 arXiv 論文之官方摘要與發布資訊。
    - `read_paper` / `paper_outline`：讀取論文段落大綱。
  - 磁碟寫入類（**嚴格禁止授權給模型**）：
    - `download`：將 PDF 下載至本地快取路徑（涉及本地檔案寫入）。
- **憑證與環境需求**：
  - 可選環境變數：`ARXIV_STORAGE_PATH`（非必要金鑰）。遵守 arXiv API 訪問規範（每 3 秒至多 1 次）。
- **實機驗證狀態**：**待實機驗證 (unverified)**。

---

### 3. GitHub 官方工具伺服器：`github-mcp-server`
- **精確倉庫來源**：`https://github.com/github/github-mcp-server.git`
- **開源授權**：**MIT**（核對自倉庫授權文件）
- **官方版本與 Commit 狀態**：
  - 固定 Release Tag：**`v2.0.2`**。
  - 對應 Commit SHA：**`eb47a99ddb866ca2b8a162920e6bda9521f33ebb`**。
- **發行資產與官方雜湊證據**（引自官方 release 之 `github-mcp-server_2.0.2_checksums.txt`）：
  - macOS arm64: `5d9b38511bffc84d2272eb6189129eb721c8900e45784d8ea7eaf25f8d3dd835` (`github-mcp-server_Darwin_arm64.tar.gz`)
  - macOS x86_64: `7ac4d549e0bf37ad9efee7be7913cae4ad50cea8d9d5be1afa9a6dbcee9d1f2c` (`github-mcp-server_Darwin_x86_64.tar.gz`)
  - Windows x86_64: `4ae64087501650752f21c9d5af5378107a5116d94ee1cf37786b22b8c4bd99df` (`github-mcp-server_Windows_x86_64.zip`)
  - Linux x86_64: `815e27d931c796af0c97f24fd211e14f8a4607d4528377719a5ad2352086b0b0` (`github-mcp-server_Linux_x86_64.tar.gz`)
- **實際暴露之 Tools**：
  - 包含倉庫查詢、檔案讀取、Issue/PR 操作等全套 GitHub 工具。
  - **安全邊界**：研究人員身份組僅能使用其唯讀工具（如 `get_file_contents`, `search_code`, `search_repositories`）；**所有寫入類工具（建立 issue/PR/評論）一律不授權給模型**，寫入必須經由專案之 Write Broker 閘門。
- **憑證需求**：
  - `GITHUB_PERSONAL_ACCESS_TOKEN`：必須由 VS Code `SecretStorage` 注入該 server 行程環境，嚴禁寫入設定檔或 repo。
- **實機驗證狀態**：**待實機驗證 (unverified)**。

---

## 三、 候選 Schema 與執行層 Allowlist 之區隔

| 層級 | 角色 | 驗證項目 | 強制狀態 |
| :--- | :--- | :--- | :--- |
| **候選目錄 Schema** (`catalog.js`) | 規格檢核模組 | 檢查 serverId 命名、SemVer 格式、SHA-256 格式、SPDX 授權、命令陣列（攔截 shell 與 eval 標誌）、僅允許 `secret: true` 宣告。 | 僅檢驗資料結構，`sandboxEnforced: false`。 |
| **執行層 Allowlist** (後續 #59 / #61) | 權限管制中心 | 根據身份組僅開放特定 serverId 與精確工具名稱；未在清單內之工具一律攔截拒絕。 | 需依賴真 CLI 或受管代理隔離強制。 |

---

## 四、 驗收條件與界線宣告

1. **零編造事實**：所有倉庫、tag、commit、授權與雜湊均來自 GitHub 官方 API 檢索結果。未取得官方雜湊者明確標記為 `unverified`。
2. **無未授權執行**：擴充套件在使用者於 UI 介面確認同意前，不下載、不解壓、不啟動上述任何第三方程式。
3. **工作區隔離**：忽略工作區內的 `.mcp.json`，防止惡意倉庫配置注入指令。
