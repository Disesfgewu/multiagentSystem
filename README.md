# multiagentSystem

在 VS Code 裡管理同一個 GitHub 專案中的多個 CLI coding agent（Claude Code、Codex CLI、agy 與自訂 CLI）。每個 agent 都在可以直接輸入的真實 terminal 中執行；PM 與 worker 依身份組分工，以 GitHub Issues／PRs 交付，並在套件內閱讀報告、review 與合併。支援 macOS 與 Windows。

## 下載最新測試版：0.0.3 Beta 4

**[下載 VSIX 安裝檔（Beta 4）](https://github.com/Disesfgewu/multiagentSystem/releases/download/v0.0.3-beta.4/multiagentsystem.vsix)** · [GitHub Release 頁面](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta.4) · [release-candidate.json](https://github.com/Disesfgewu/multiagentSystem/releases/download/v0.0.3-beta.4/release-candidate.json) · [安裝、升級、回復與已知限制](docs/BETA_0.0.3.md)

| 項目 | 值 |
|---|---|
| 版本 | `0.0.3`（prerelease，tag `v0.0.3-beta.4`） |
| 來源 commit | `3b6d614349d539d88c12d1578beda4c88c4ba058` |
| 檔案 | `multiagentsystem.vsix`，741430 bytes，內含 203 個檔案 |
| SHA-256 | `36f77104830dc339fa2e57ac0f4f5c4f6ac74f594ee4ebfd3c2adf72df090cb3` |
| 需求 | VS Code 1.95 以上；macOS 或 Windows |

**安裝前請核對雜湊**：

```text
# macOS
shasum -a 256 multiagentsystem.vsix
# Windows PowerShell
Get-FileHash .\multiagentsystem.vsix -Algorithm SHA256
```

結果必須和上表完全相同，也必須等於 `release-candidate.json` 中的 `artifact.sha256`。核對後，在 VS Code 的 Extensions 選單選擇 **Install from VSIX…**，選取這個檔案，然後重新載入視窗。

這是供試用的 prerelease，**不代表完整產品已驗收**：真實 CLI、真實帳號，以及 macOS／原生 Windows 的實機流程，仍在 [Issue #135](https://github.com/Disesfgewu/multiagentSystem/issues/135) 進行 Beta 後驗收。較舊的版本保留供回復：[Beta 3](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta.3)、[Beta 2](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta.2)、[第一版 Beta](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta)。

### Beta 4 的新內容（相對 Beta 3）

- **受管隔離（macOS，需使用者明確選用）**：選用 enforced 後，啟動或重新開啟 agent 前，會先在本機實測九項檢查：七個旁路通道，加上兩項確認 CLI 仍可互動與登入。每一項都要有對照組證據並通過，才會在 Seatbelt 沙箱中啟動 CLI；只要有任何證據不足，就不啟動。
  - 沙箱拒絕讀取已知的憑證位置（如 `~/.git-credentials`、`~/.config/gh`、`~/.netrc`、`~/.ssh`、鑰匙圈資料夾），拒絕寫入 `.git`，並封鎖鑰匙圈的 SecurityServer 服務。其他位置的憑證與其他鑰匙圈存取方式尚未驗證。
  - 網路只能經過依主機名稱過濾的本機代理；GitHub 相關網域即使列入也不會放行。
  - Windows 目前只有 advisory。
- **自訂 CLI provider**：在使用者設定列出自己的 CLI（例如 opencode），用原生 terminal 啟動。程式會解析成絕對路徑，不使用工作區內的同名程式；第一次啟動要確認。
- **研究工具（基礎工作，尚無法從介面完成安裝）**：新增「Research: Search Papers」，以及研究用 MCP 的允許清單與啟用、停止、撤銷；github-mcp-server 使用固定版本並驗證雜湊，每個工具有自己的私人資料夾。目前 **Prepare Consented Research MCP Tool** 還沒有選擇工具的步驟，從命令面板無法完成下載，所以這些流程只有自動化測試。
- **報告**：可以從 Issue 報告關閉 Issue，PR 合併後可以刪除它的 head 分支。
- **帳號與 session**：
  - Claude hook 讓總覽顯示 working／waiting／ended。
  - 用量未知時顯示具體原因。
  - session 可以改名。
  - 額度租約更嚴格。

完整清單見 [Release 說明](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta.4)。

## 第一次使用

1. 安裝後，點左側活動列的 **Multiagent** 圖示。
2. 在 **Tools Setup** 檢查 Git、`gh`、Claude Code、Codex CLI 是否就緒。VSIX 不含這些程式；缺少的可以依畫面指引準備，套件會先驗證 SHA-256 才安裝 `gh`、Codex 與 Claude Code。agy 只提供手動安裝指引。
3. 在 **Accounts and Sessions** 建立帳號設定（同一個 provider 可以有多個帳號），並用 **Sign In to Account** 登入。
4. 在 **Role Groups and Rules** 建立身份組（例如 PM、worker），設定可用帳號與規則，再用 **Preview Effective Rules** 預覽實際會送給 CLI 的內容。
5. 用 **Start Agent with This Role Group** 或 **Start Session with Account** 啟動 agent；它會在新的原生 terminal 執行，你可以直接輸入。
6. 在 **Overview** 查看每個 agent 的狀態、worktree 與 Git 變更；在 **Issues Report**／**PRs Report** 閱讀與處理報告。

詳細步驟、診斷與故障排除見 [首次設定與診斷](docs/GETTING_STARTED.md)。

## 功能說明

### 側欄畫面

| 畫面 | 用途 |
|---|---|
| **Overview** | Agent 總覽：每個 session 的 provider、帳號、身份組、狀態、模型與用量（沒有證據時顯示未知）、worktree 的未提交變更、相對上游領先或落後幾個 commit。多個 worktree 是否改到同一檔案，要用 **Find Files Changed in More Than One Worktree** 檢查。 |
| **Issues Report**／**PRs Report** | 不必輸入編號，就能在編輯器內閱讀 Issue／PR 的需求、解法、PM 報告、reviewer 結論與它對應的 head、CI 結果、變更檔案與 diff；可以切換上一份、下一份，或回到清單與總覽。 |
| **GitHub** | 目前專案的開放 Issues／PRs 清單（唯讀），點選後在編輯器讀取內容。 |
| **Accounts and Sessions** | 帳號設定、登入、身份核對、額度與並行上限；session 的聚焦、停止、重新開啟與改名。 |
| **Role Groups and Rules** | 身份組的角色、可用帳號、system／project／task 規則，以及有效規則預覽。 |
| **Administrator Broadcasts** | 管理者廣播：建立、閱讀全文、撤銷。啟動 agent 時，只會帶入仍有效、而且適用於該角色、provider 或 session 的公告；已在執行中的 agent 不會收到新廣播（見 [#295](https://github.com/Disesfgewu/multiagentSystem/issues/295)）。 |
| **Tools Setup** | CLI 工具的準備狀態、經驗證的安裝與重試，以及一份遮罩過、可以複製的唯讀診斷文件。 |

### Agent 與 terminal

- **原生 terminal**：每個 agent 都是 VS Code 的原生 terminal，可以直接輸入、`Ctrl+C`、關閉與重新開啟。**Open Four Native Terminals** 會開啟 PM、Worker 1–3 四個 terminal，排成 2×2，可以拖曳重新排列。
- **Session**：**Start Session with Account** 會以指定帳號啟動 CLI；**Reopen Session in a New Terminal** 會建立新的 session，不會暗中切換執行中的 CLI。遇到無法安全加引號的 shell 時，不會送出指令。
- **Worktree**：每個 worker 可以有自己的 Git worktree（**Create Worktree**／**Release Worktree**）。**Find Files Changed in More Than One Worktree** 會找出多個 agent 同時改到的檔案：路徑完全相同的直接列出；只差大小寫或 Unicode 寫法的，會在選單中標為 `(possible)`。

### 帳號、額度與身份組

- 同一個 provider 可以登入多個帳號，每個 agent 指定使用哪一個。同一真實帳號的多個設定會共用額度與並行上限，不會被當成兩份額度重複派工。
- **Set Account Limits** 可以設定警示門檻、阻擋新分派、未知額度的處理方式與並行上限。目前只有 Claude 經 **Configure Claude Status Line Bridge** 取得真實的額度來源，其他 provider 顯示未知，並說明原因；本機計算的 token 數不會被當成官方額度。
- **Configure Claude Hook Bridge** 經你同意後，在 profile 設定加入 hook，讓總覽顯示 working／waiting／ended。
- 身份組的規則只有在能證明已送進 CLI 時，才會顯示「已套用」。詳見 [身份組](docs/ROLE_GROUPS.md) 與 [帳號設定](docs/ACCOUNT_PROFILES.md)。

### GitHub 報告、review 與合併

- 在報告中可以：**Save Local Feedback on Report**（只存在本機）、**Publish Feedback for Open Report**、**Submit Formal Pull Request Review**、**Merge Pull Request from Report**、**Delete Merged Pull Request Branch**、**Close Issue from Report**。
- 從報告頁送出的 GitHub 寫入會經過 Broker：送出前做發佈掃描並確認最新的 head；合併時另外確認 CI。這些按鈕以你設定的 publisher 帳號、PM 身分送出。
- **terminal 中的 agent 自己執行的 `git`／`gh` 寫入不經過 Broker**，套件無法阻擋（受管隔離的 enforced 模式除外，見下文）。
- 合併權限預設是人工：這時報告頁的合併按鈕會拒絕，請在 GitHub 上合併。經確認後，可以改為由你設定的 publisher 帳號從報告頁合併（**Configure Pull Request Merge Authority**）。
- 報告中來自 GitHub 的文字一律當作資料顯示，不能偽造標題、跳轉連結或「Pass」判定。

### 自訂 CLI provider

在**使用者設定**的 `multiagentSystem.providers.custom` 列出自己的 CLI（`id`、`label`、`executable`、可選的 `args`）。用 **Show Custom Providers** 檢查，再用 **Start Custom Provider Terminal** 啟動。

- 只讀使用者層級的設定，工作區或 repo 中的值一律忽略。
- 程式名稱會解析成絕對路徑。工作區與目前資料夾內的程式不會被使用，經過 symlink 或 junction 也一樣。Windows 只接受 `.exe`／`.com`。
- 第一次啟動時，確認視窗會顯示完整路徑與參數；路徑或參數改變後，會再次要求確認。未信任的工作區不會啟動。
- 自訂 provider 的能力一律是未知，只提供 terminal 啟動。詳見 [自訂 provider](docs/CUSTOM_PROVIDERS.md)。

### 受管隔離（advisory／enforced）

預設是 **advisory**，啟動方式和以前相同，只提供建議，不能阻止 agent 繞過。

在 macOS 上，可以在使用者設定把 `multiagentSystem.isolation.mode` 設為 `enforced`，並在 `multiagentSystem.isolation.allowedDomains` 填入 CLI 需要連線的供應商網域。啟動或重新開啟 session 時：

1. 先在本機實測九項檢查，每一項都要有對照組證明測試有效：
   - 七個旁路通道：git commit、git push、`gh`、直接 HTTP、憑證檔、憑證 helper（含鑰匙圈）、環境變數中的憑證。測試目標是本機的假 GitHub 伺服器；環境變數一項檢查的是清除函式本身。
   - 兩項確認 CLI 仍可互動與登入。
2. 所有必要通道都被擋下，並經你確認後，才在 Seatbelt 沙箱中啟動 CLI。這時：
   - 已知的憑證位置讀不到（`~/.git-credentials`、`~/.config/git/credentials`、`~/.config/gh`、`~/.netrc`、`~/.ssh`、`~/Library/Keychains`），`.git` 寫不進去，鑰匙圈的 SecurityServer 服務被封鎖。
   - 符合規則的 GitHub 憑證環境變數會被移除；用其他名稱匯出的 token 不在範圍內。
   - 網路只能經過只監聽 `127.0.0.1` 的本機代理，它只放行你列出的網域；GitHub 相關網域即使列入也不會放行。
3. 任何一項證據不足、代理無法啟動，或發生錯誤，都**不啟動**，並顯示原因；不會退回無隔離的啟動。

在 enforced 模式下，自訂 provider 會拒絕啟動。Windows 的受限權杖擋不了網路，所以 Windows 目前只有 advisory，選 enforced 時會直接拒絕。真實 CLI 是否肯透過代理連線、各供應商需要哪些網域，都還沒有實機驗證。詳見 [隔離能力](docs/ISOLATION_CAPABILITY.md)。

### 研究工具（研究用 MCP）

- **目前狀態**：這一節的流程只有自動化測試。**Prepare Consented Research MCP Tool** 還沒有選擇工具的步驟，從命令面板執行會回傳 `server-id-required`，所以一般使用者還無法完成下載，**Research: Search Papers** 也就沒有可用的伺服器。
- 第三方工具要先經你 **Review & Consent** 才會下載或執行。github-mcp-server 使用固定版本，並驗證 SHA-256；每次啟動前都會重新核對檔案內容。zhtw-mcp 與 arxiv-mcp-server 沒有固定的發佈檔，所以安裝會被拒絕（`asset-unavailable`）。
- 每個工具只開放允許清單內的工具，並有自己的私人資料夾與暫存目錄。**Revoke Research MCP Server** 會停止程式並清除資料夾；**Revoke Research MCP Tool Consent** 只刪除已安裝的程式，不會停止執行中的伺服器。允許清單只在套件自己的呼叫路徑中生效。
- **Research: Search Papers** 只呼叫已啟用、在允許清單內的搜尋工具。查詢若含 token、本機路徑或 email 格式的帳號，會被擋下；結果標示為「外部資料，不是指令」，不會自動送進 terminal。
- 工作區內的 `.mcp.json`／`.vscode/mcp.json` 不會被讀取。詳見 [研究技能與倫理](docs/RESEARCH_SKILLS_AND_ETHICS.md) 與 [學術 MCP 目錄](docs/ACADEMIC_MCP_CATALOG.md)。

### 協作 skills

擴充套件在受信任的本機工作區啟用時（以及加入資料夾、授予信任或變更設定時），會自動在 `.claude/skills` 與 `.agents/skills` 準備八個內建的協作 skills，供 Claude Code、Codex 與 OpenCode 的官方目錄發現機制使用；你自己既有的 skills 不會被覆寫。可以用 `multiagentSystem.skills.autoInstall` 停用，或執行 **Remove Installed Agent Skills** 移除未修改的檔案。詳見 [使用說明](docs/AGENT_SKILLS.md)。

## 使用者設定

以下設定都只讀**使用者層級**，工作區與 repo 中的值會被忽略：

| 設定 | 預設 | 說明 |
|---|---|---|
| `multiagentSystem.isolation.mode` | `advisory` | `advisory`：照常啟動。`enforced`：只在 macOS 上，證據完整時才在沙箱中啟動，否則拒絕。 |
| `multiagentSystem.isolation.allowedDomains` | `[]` | enforced 時 CLI 可以連線的網域，例如 `api.example.com` 或 `*.example.com`。GitHub 相關網域即使列入也不會放行。 |
| `multiagentSystem.providers.custom` | `[]` | 自訂 CLI provider 清單。 |
| `multiagentSystem.skills.autoInstall` | `true` | 是否在受信任的工作區自動準備協作 skills。 |

## 安全與隱私原則

- **沒有證據就是未知**：帳號身份、模型、用量、規則是否注入、隔離是否生效，都只在有可驗證的證據時才顯示成功。
- **私人資料不進 GitHub**：session、帳號與 terminal 內容存放在擴充套件的私人儲存區；從報告頁送出的公開留言、review 與合併，送出前都會做發佈掃描；診斷文件會遮罩路徑與帳號。terminal 中的 agent 自己執行的 `git`／`gh` 不經過這個掃描。
- **不信任 repo**：工作區設定不能決定要執行什麼程式；未信任的工作區不會啟動 agent 或 MCP。
- **確認不能被跳過**：在一般安裝的擴充套件中，任何參數都不能代替你確認；只有擴充套件自己的測試模式例外。

## 已知限制

- CI 在 macOS 與 Windows 上只證明建置、封裝檢查與合成的 Extension Host 測試；乾淨實機的安裝、升級、移除、terminal 輸入、中斷與重開，仍待 Beta 後驗收（[#135](https://github.com/Disesfgewu/multiagentSystem/issues/135)）。
- 真實的 Claude Code、Codex CLI、agy、GitHub 帳號與多帳號隔離，都還沒有完成端到端實測；畫面中的未知值不能解讀為成功。
- Codex 與 agy 沒有接上官方額度來源，所以顯示未知；Codex session 也缺少可驗證的 terminal 事件來源。
- agy 沒有可核實的官方固定資產，只提供手動安裝指引。
- 受管隔離只支援 macOS，而且只涵蓋 session 的 start 與 reopen；你在空白 shell 或四格 terminal 中自己輸入的指令不在受管範圍內。Windows 的網路封鎖見 [#289](https://github.com/Disesfgewu/multiagentSystem/issues/289)。
- 封裝檢查沒有發現憑證、帳號或工作區內容，但掃描無法證明不存在格式或編碼未知的秘密。

回復到舊版與移除的步驟見 [Beta 文件](docs/BETA_0.0.3.md#回復與移除)。

## 開發與驗證

需求：Node.js 24 以上（擴充套件主機最低支援 Node 20）與 VS Code 1.95 以上。

```text
npm ci               # 依 package-lock.json 安裝（鎖定相依版本）
npm run check        # TypeScript 型別檢查，不輸出檔案
npm run build        # 編譯到 out/
npm test             # 型別檢查 + 建置 + 單元測試
npm run test:host    # 在隔離的 Extension Host 載入建置結果並執行命令
npm run vsix:package # 打包 VSIX、做內容與發佈掃描、寫出 release-candidate.json
```

- 在 VS Code 開啟這個資料夾並按 `F5`，會先執行 `npm: build`，再啟動 Extension Development Host。建置輸出在 `out/`，不納入版本控制。
- `npm run test:host` 會下載 VS Code 到 `.vscode-test/`（預設 1.95.0，可用環境變數 `VSCODE_VERSION` 指定，例如 `stable`），使用暫存的使用者資料與工作區，不會讀取或修改你的 VS Code 設定。
- CI 在 macOS 與 Windows 上分別執行：型別檢查與單元測試、VSIX 封裝與檢查，以及 Extension Host 冒煙測試。各模組另有自己的 workflow，例如研究工具在 Node 20／24 × macOS／Windows 上執行。
- 發行第 N 個 Beta 時用 `RELEASE_TAG=v0.0.3-beta.N npm run vsix:package`，詳見 [VSIX 打包](docs/VSIX_PACKAGING.md)。

## 專案進度與文件

- 進度追蹤：[Issue #90](https://github.com/Disesfgewu/multiagentSystem/issues/90)；實機驗收清單：[Issue #135](https://github.com/Disesfgewu/multiagentSystem/issues/135)。
- 需求與驗收標準：[實作計劃書](docs/IMPLEMENTATION_PLAN.md)；PM 工作規則：[PM system prompt](docs/PM_SYSTEM_PROMPT.md)；worker 指令：[Claude Code worker prompt](docs/CLAUDE_CODE_WORKER_PROMPT.md)。
- 主題文件：[Provider 登錄](docs/PROVIDERS.md) · [身份組](docs/ROLE_GROUPS.md) · [帳號設定](docs/ACCOUNT_PROFILES.md) · [額度政策](docs/QUOTA_POLICY.md) · [寫入 Broker](docs/WRITE_BROKER.md) · [發佈掃描](docs/PUBLISH_SCAN.md) · [Worktree 服務](docs/WORKTREE_SERVICE.md) · [管理者廣播](docs/BROADCASTS.md) · [隔離能力](docs/ISOLATION_CAPABILITY.md) · [自訂 provider](docs/CUSTOM_PROVIDERS.md)。
- [舊交付台帳](docs/MASTER_PLAN.md)只供查閱歷史紀錄，不是即時狀態。
