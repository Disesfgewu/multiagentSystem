# Multiagent System 0.0.3 Beta

這是供試用與實測的 prerelease。它沒有宣稱完整產品、真實 CLI、真實帳號或雙平台使用流程已通過。

## 取得與核對

1. 從 [GitHub Beta 3 Release](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta.3) 下載 [multiagentsystem.vsix](https://github.com/Disesfgewu/multiagentSystem/releases/download/v0.0.3-beta.3/multiagentsystem.vsix) 與 [release-candidate.json](https://github.com/Disesfgewu/multiagentSystem/releases/download/v0.0.3-beta.3/release-candidate.json)。
2. 核對 JSON 的 `version` 是 `0.0.3`、`prerelease` 是 `true`、`release` 是 `v0.0.3-beta.3`，且 `sourceCommit` 是 `0464c930be5b1eda8ffac1ae62c6d0997af1f592`。
3. 計算 VSIX 的 SHA-256，必須與 JSON 的 `artifact.sha256` 完整相同：`af1a7aaaa858c81db55cbd209874ad5a0d7089c460b83cd7940d9bcb975cf8dd`。macOS 可用 `shasum -a 256 multiagentsystem.vsix`；Windows PowerShell 可用 `Get-FileHash .\multiagentsystem.vsix -Algorithm SHA256`。

此專案沒有設定 publisher，也沒有自動上架 Marketplace。Beta 3 Release 的來源 commit 與目前 `main` 的文件更新可能不同；以上雜湊對應 Release 中的檔案。較舊的 [Beta 2](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta.2)（SHA-256 `123da5468d620e25fcaaee787df593f5b8eb699625cc5b540a481e201bd76374`）與[第一版 Beta](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta) 保留供回溯；第一版未包含報告頁的完整留言與檔案入口。

## 此版更新（相對 Beta 2）

- Agent 總覽每列顯示該 worktree 的未提交變更，以及相對上游領先／落後幾個 commit；讀不到時顯示未知。
- 多個 worktree 改到同一檔案時提醒：路徑完全相同標為「確定」，只差大小寫或 Unicode 寫法標為「可能」；變更檔案以整合分支為基準。
- 同一真實帳號的多個 profile 共用額度與並行上限；本帳號讀數缺席、過期或未知時一律擋下。
- 安全：讀取他人 repo 的唯讀 Git 呼叫不再執行 repo 設定的內容篩選器；GitHub 上的文字不能偽造報告標題、跳轉連結、檔案項目或「Pass」判定；觀測橋接暫存檔改用不可預測名稱且只能新建。
- 修正：指示檔無法移除時不再讓 terminal 關不掉、session 狀態錯誤或錯誤訊息洩漏路徑。

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

- Release tag `v0.0.3-beta.3` 指向上述來源 commit，並標為 prerelease。
- 來源 commit 的 Build、Terminal session model、GitHub read adapter、Git worktrees 四個 GitHub Actions workflow 全部成功；封裝檢查通過，含 177 個檔案。
- `release-candidate.json` 的來源 commit、版本、檔名、大小（642376 bytes）與 SHA-256 已比對；Release 說明列出未驗證事項。
