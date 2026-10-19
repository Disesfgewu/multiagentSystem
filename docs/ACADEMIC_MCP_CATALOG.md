# 候選學術與研究 MCP 工具目錄調查

擷取與核實日期：**2026-10-16**（GitHub 官方 API 與倉庫實際檢索）。
對應 Issue [#107](https://github.com/Disesfgewu/multiagentSystem/issues/107) 第 1 項與 Issue [#61](https://github.com/Disesfgewu/multiagentSystem/issues/61) 第 7 項。

本文件為使用者**明確指定之三個 MCP 來源**的調查與評估紀錄，**是純文件與候選架構依據**；不包含自動下載、不執行任何第三方程式、不登入帳號，亦不預設啟用任何伺服器。PM 與擴充套件目前**沒有安裝任何 MCP**。未實測之能力與雜湊一律標為 `unknown`／`unverified`，絕不編造示意值。

---

## 一、 調查原則與安全邊界

1. **唯一真實來源約束**：
   - 嚴格限定於使用者指定的精確倉庫（`sysprog21/zhtw-mcp`、`blazickjp/arxiv-mcp-server`、`github/github-mcp-server`），不得以同名套件、社群 fork 或推測之 npm 套件代替。
2. **拒絕動態安裝與供應鏈攻擊**：
   - 整個 `npx`／`uvx` 套件執行器類別一律拒絕作為啟動指令，不只是拒絕 `-y`／`--yes`：沒有旗標的 `npx some-package` 在執行當下仍會向登錄檢索「目前」版本，與加了 `-y` 沒有本質差異，兩者都不是鎖定建置。
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
- **官方版本與 Commit 狀態**（三筆各自獨立的證據，不得互相假設為同一次建置）：
  - Crate 版本：`0.1.0`（`Cargo.toml`）。
  - `latest` release（id `376195416`）：這是**可變動**的標籤，其 `target_commitish` 為 `0c3b70fa731f192dd8fe7be1ac5a2344cf105d81`（擷取時點 2026-10-16）。這個 release 之後若改指到其他 commit，此欄位會跟著變。
  - 另一次先前查核取得的固定 commit SHA `0485df42b26e08e7e9d00da0a5c773ca99bedbd7`（2026-10-11）：這是獨立查核得到的一個 commit，**未證實與上述 `latest` release 的 `target_commitish` 相同建置**；在沒有 immutable release provenance（例如官方對應的固定 SemVer tag）之前，兩者都只能分開記錄，不能互相取代或視為等價。
  - **版本鎖定依據**：官方尚未釋出固定 SemVer tag（如 `v0.1.0`）。若本專案要啟用，必須明確鎖定其中一個已核實的 commit SHA，而不是依賴會變動的 `latest` 標籤；哪一個 commit 才是「要鎖定的版本」仍待決策者核定，本文件不擅自選定。
- **發行資產與雜湊證據**（每筆都附資產 ID 與建立時間，供日後核對是否被置換）：
  - macOS arm64：`zhtw-mcp-aarch64-apple-darwin.tar.gz`（asset id `629384222`，官方 digest `sha256:a0b555fb47253e580eb095d438368c6af0018cf90fffa0dbb979f081e28d084a`，`created_at` `2026-10-11T00:47:28Z`，屬於上述 `latest` release）。
  - Windows x86_64: `zhtw-mcp-x86_64-pc-windows-msvc.tar.gz`（官方 digest: `sha256:5a0725835205a75d1ec57e13cf58e1b363488de9acdb250df372d7843105c71f`）。
  - Linux x86_64: `zhtw-mcp-x86_64-unknown-linux-gnu.tar.gz`（官方 digest: `sha256:d67c8426c066631e6cd570d5e6b540ea717a15160fd9691936fa394fe7f48db4`）。
  - **macOS x86_64**：尚未在本次核對中找到對應資產；維持**未驗證**，不得寫成「不存在」。
  - 這些資產全部屬於同一個 `latest` release（id `376195416`），彼此可視為同一次發布的一組建置；但這個 release 本身與上方「獨立查核取得」的 commit `0485df42...` 之間，**沒有建立起官方 immutable 對應關係前，仍視為未驗證**。
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
- **實際暴露之 Tools**（精確名稱核對自鎖定 commit `572e301` 的原始碼，不是模組名或猜測）：
  - 唯讀檢索類（候選授權對象）：
    - `search_papers`：依關鍵字或主題搜尋 arXiv 論文元資料。
    - `get_abstract`：檢索指定 arXiv 論文之官方摘要與發布資訊。
    - `search_paper_text`：在已下載的本機快取論文全文中搜尋字串。
    - `read_paper`、`get_paper_outline`、`read_paper_section`：讀取論文全文、大綱或指定段落。
  - 磁碟寫入類（**嚴格禁止授權給模型**）：
    - `download_paper`：將 PDF 下載並轉存至本地快取路徑（涉及本地檔案寫入）。
  - **工作流程缺口（必須記錄，不得略過）**：`read_paper`、`get_paper_outline`、`read_paper_section`、`search_paper_text` 都讀取本機先前由 `download_paper`建立的快取，不會即時連線抓取論文全文。只要 `download_paper`（寫入工具）未被授權給模型，研究人員身份組就**無法讀到任何尚未被下載過的新論文全文**，只能用 `search_papers`／`get_abstract` 取得元資料與摘要。這是目前候選規格下的真實限制，不是待補的細節；若要支援全文閱讀，需要另立一個經人工核准、範圍受限、寫入目標固定於私有快取目錄的下載管道，超出本 PR 範圍。
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

## 二之一、 下載層與可安裝狀態（Refs #107，核對於 2026-10-19）

下載層（`src/research/download.js`、`src/research/archive.js`）只接受三個指定倉庫的 `https://github.com/<owner>/<repo>/releases/download/<tag>/<檔名>`，轉址逐跳比對主機（https、無帳密、無埠號、最多 3 次）、有大小上限、可取消、固定 SHA-256；失敗不留暫存，也不動既有安裝。目錄項只有在 `assets` 列出「此平台」的固定資產時才可安裝；沒有就維持不可安裝（`asset-unavailable`）。

| 工具 | 可安裝 | 依據或缺口 |
| :--- | :--- | :--- |
| `github-mcp-server` v2.0.2 | macOS arm64／x64、Windows x64／arm64 | 四個資產本次實際下載並計算 SHA-256，與官方 `github-mcp-server_2.0.2_checksums.txt` 一致；壓縮檔內可執行檔為 `github-mcp-server`（Windows 為 `.exe`）。 |
| `zhtw-mcp` | 否 | 只有會原地重建的 `latest` 標籤，沒有固定版本或 tag，雜湊會變；也找不到 macOS x64 資產。`0.1.0` 是 crate 版本，不是 release tag。 |
| `arxiv-mcp-server` v0.8.2 | 否 | 官方 release 只有 macOS `.mcpb`（約 91 MB），沒有 Windows 資產，`.mcpb` 的執行方式未核實。目錄的 `integrity` 改為 GitHub 回報的 darwin-arm64 `.mcpb` digest（僅中繼資料，未下載）；先前的值是 commit SHA 加上來路不明的字元，不對應任何資產，已移除。 |

真實 MCP 的啟動與可用性、兩平台實機安裝仍由 #135 驗收；本次沒有執行任何下載的程式。

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
