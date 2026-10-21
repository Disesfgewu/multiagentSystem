# Multiagent System 0.0.3 Beta

這是供試用與實測的 prerelease。它沒有宣稱完整產品、真實 CLI、真實帳號或雙平台使用流程已通過。

## 取得與核對

1. 從 [GitHub Beta 4 Release](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta.4) 下載 [multiagentsystem.vsix](https://github.com/Disesfgewu/multiagentSystem/releases/download/v0.0.3-beta.4/multiagentsystem.vsix) 與 [release-candidate.json](https://github.com/Disesfgewu/multiagentSystem/releases/download/v0.0.3-beta.4/release-candidate.json)。
2. 核對 JSON：`version` 是 `0.0.3`，`prerelease` 是 `true`，`release` 是 `v0.0.3-beta.4`，`sourceCommit` 是 `3b6d614349d539d88c12d1578beda4c88c4ba058`。
3. 計算 VSIX 的 SHA-256，必須與 JSON 的 `artifact.sha256` 完全相同：`36f77104830dc339fa2e57ac0f4f5c4f6ac74f594ee4ebfd3c2adf72df090cb3`。macOS 可用 `shasum -a 256 multiagentsystem.vsix`；Windows PowerShell 可用 `Get-FileHash .\multiagentsystem.vsix -Algorithm SHA256`。

此專案沒有設定 publisher，也不會自動上架 Marketplace。Beta 4 Release 的來源 commit 可能和目前 `main` 上的文件版本不同，以上雜湊對應 Release 中的檔案。較舊的版本保留供回復：[Beta 3](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta.3)（SHA-256 `af1a7aaaa858c81db55cbd209874ad5a0d7089c460b83cd7940d9bcb975cf8dd`）、[Beta 2](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta.2)（SHA-256 `123da5468d620e25fcaaee787df593f5b8eb699625cc5b540a481e201bd76374`），以及[第一版 Beta](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta)。第一版不含報告頁的完整留言與檔案入口。

## 此版更新（相對 Beta 3）

- **受管隔離（macOS，需使用者明確選用）**：在使用者設定把 `multiagentSystem.isolation.mode` 設為 `enforced`，並填入 `isolation.allowedDomains` 後，session 的啟動與重新開啟會先在本機實測九項檢查（七個旁路通道，加上兩項確認 CLI 仍可互動與登入）。每一項都有對照組證據並通過時，才會在 Seatbelt 沙箱中啟動 CLI。
  - 沙箱拒絕讀取已知的憑證位置、拒絕寫入 `.git`，並封鎖鑰匙圈的 SecurityServer 服務；符合規則的 GitHub 憑證環境變數會被移除。其他位置的憑證、其他鑰匙圈存取方式、以其他名稱匯出的 token，都不在範圍內或尚未驗證。
  - 網路只能經過依主機名稱過濾的本機代理；GitHub 相關網域即使列入也不會放行。
  - 任何證據不足、代理失敗或發生錯誤時，都不啟動，也不會退回無隔離的啟動。
  - 預設的 advisory 行為不變。
- **Windows**：受限權杖與驗證 harness 已在 CI 的 Windows runner（管理員權限）上執行，但權杖擋不了網路，所以 Windows 只有 advisory，選 enforced 時會直接拒絕並說明原因。
- **自訂 CLI provider**：在使用者設定 `multiagentSystem.providers.custom` 列出自己的 CLI，用 **Start Custom Provider Terminal** 在原生 terminal 啟動。
  - 程式會解析成絕對路徑；工作區內的同名程式不會被使用，經過 symlink 或 junction 也一樣。
  - 第一次啟動要確認；未信任的工作區不啟動；enforced 時拒絕啟動。
- **研究工具（基礎工作）**：目前 **Prepare Consented Research MCP Tool** 還沒有選擇工具的步驟，從介面無法完成下載，以下流程只有自動化測試。
  - 新增 **Research: Search Papers**。
  - 研究用 MCP 有允許清單，以及受控的啟用、停止、撤銷。
  - github-mcp-server 使用固定版本並驗證雜湊，啟動前一律重新核對。
  - 每個工具有自己的私人資料夾與暫存目錄，撤銷時清除。
  - researcher 角色不能經由套件的寫入路徑寫 GitHub。
- **報告**：可以從 Issue 報告關閉 Issue，合併後可以從 PR 報告刪除 head 分支。
- **帳號與 session**：
  - Claude hook 橋接讓總覽顯示 working／waiting／ended。
  - 用量未知時顯示具體原因。
  - session 可以改名。
  - 刪除帳號設定時，一併處理以它為預設帳號的身份組。
  - 額度租約更嚴格。
  - 遇到無法安全加引號的 shell 時不會送出指令。

## 安裝與升級

在 VS Code 的 Extensions 選單選擇 **Install from VSIX…**，選取核對過的檔案並依提示重新載入視窗。從 0.0.2 升級時使用相同步驟；安裝前先保留目前 VSIX，並完成重要專案與本機設定的備份。

安裝後開啟 Multiagent 活動列，依 [首次使用指南](GETTING_STARTED.md) 檢查 Tools Setup、帳號、身份組與 agent session。VSIX 不含 Git、`gh`、Claude Code、Codex CLI 或 agy 二進位檔。

## 回復與移除

- 回復至 0.0.2：先停掉受管 session，解除安裝 0.0.3，再以 **Install from VSIX…** 安裝先前保留且已核對來源的 0.0.2 VSIX。
- 移除：先依需要使用 **Clear Private Storage Data**；此動作需要明確確認且不可復原。接著從 Extensions 選單解除安裝擴充套件。
- 若需要保留帳號、身份組或 session 紀錄，不要先清除私人儲存。降版不保證能讀取較新 schema；遇到資料無法讀取時應保留原資料，不要反覆覆寫。

## 已知限制

- macOS 與 Windows CI 只證明建置、內容檢查與合成 Extension Host 測試；乾淨實機安裝、升級、移除、terminal 輸入、中斷與重開仍待 Beta 後驗收。
- 真實 Claude Code、Codex CLI、agy、GitHub 帳號與多帳號隔離未完成端到端實測。畫面中的未知值不得解讀為成功。
- agy 沒有可核實的固定官方獨立資產與再散布依據，因此只提供手動安裝指引，不會自動部署。
- Claude 額度需要使用者啟用 status line bridge；Codex／agy 缺少已接通的官方額度來源時維持未知。
- 角色規則是否真正注入、帳號身份與 provider 能力只在有相應證據時顯示已核實；不同 CLI 的強制力仍有未驗證項目。
- 此 VSIX 的封裝檢查未發現登入憑證、帳號資料、工作區內容、terminal transcript 或本機 session 資料；掃描仍無法證明不存在未知格式或編碼的秘密。

## 發行核對結果

- Release tag `v0.0.3-beta.4` 指向上述來源 commit，並標為 prerelease。
- 來源 commit 的 Build、Terminal session model、GitHub read adapter 三個 GitHub Actions workflow 全部成功，含 macOS／Windows 封裝與 Extension Host 冒煙測試。本機 typecheck 通過，1892 項測試通過、0 失敗。
- 封裝檢查通過，含 203 個檔案；唯一打包的第三方套件是 fflate 0.8.3（MIT）。
- 從 Release 下載回來的 VSIX 已重新計算 SHA-256，與 `release-candidate.json` 的來源 commit、版本、檔名、大小（741430 bytes）與 SHA-256 都相符。Release 說明列出了未驗證事項。
