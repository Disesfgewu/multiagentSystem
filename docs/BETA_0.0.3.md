# Multiagent System 0.0.3 Beta 候選

這是供審查與實測的 prerelease 候選。它沒有宣稱完整產品、真實 CLI、真實帳號或雙平台使用流程已通過。

## 取得與核對

1. 在來源 commit 的 **Build / Package and inspect VSIX** job 下載與作業系統相符的 `multiagentsystem-0.0.3-beta-*` artifact。
2. 解開 CI artifact；`multiagentsystem.vsix` 與 `release-candidate.json` 必須來自同一包。
3. 核對 JSON 的 `version` 是 `0.0.3`、`prerelease` 是 `true`，且 `sourceCommit` 等於受審查的完整 commit。
4. 計算 `multiagentsystem.vsix` 的 SHA-256，必須與 JSON 的 `artifact.sha256` 完整相同。macOS 可用 `shasum -a 256 multiagentsystem.vsix`；Windows PowerShell 可用 `Get-FileHash .\multiagentsystem.vsix -Algorithm SHA256`。
5. GitHub Release 只能由人類管理者在上述證據與所需 CI 通過後建立，並勾選 **Set as a pre-release**。上傳同一份 VSIX 與 JSON，Release 說明附來源 commit、SHA-256、本文件的已知限制及回復方式。

CI artifact 是短期審查材料，不是公開發行。此專案沒有設定 publisher，也沒有自動上架 Marketplace。

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
- 發行候選不包含任何登入憑證、帳號資料、工作區內容、terminal transcript 或本機 session 資料。封裝掃描仍無法證明不存在未知格式或編碼的秘密，發布前需要人工檢查。

## 人工發行門檻

- PR 已由 PM Pass 並由人類合併；候選由預定發布的 main commit 重建。
- Node 20 與 24、macOS 與 Windows 的必要 CI 全綠；VSIX verifier 與 publication scan 通過。
- `release-candidate.json` 的來源 commit、版本、檔名、大小與 SHA-256 已人工比對。
- Release 標為 prerelease／Beta，說明未宣稱實機、真 CLI、真帳號或完整產品驗收通過。
- 發布動作由人類管理者執行；失敗時保留證據與原始 VSIX，不以重新壓縮的檔案沿用舊雜湊。
