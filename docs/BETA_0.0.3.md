# Multiagent System 0.0.3 Beta

這是供試用與實測的 prerelease。它沒有宣稱完整產品、真實 CLI、真實帳號或雙平台使用流程已通過。

## 取得與核對

1. 從 [GitHub Beta 5 Release](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta.5) 下載 [multiagentsystem.vsix](https://github.com/Disesfgewu/multiagentSystem/releases/download/v0.0.3-beta.5/multiagentsystem.vsix) 與 [release-candidate.json](https://github.com/Disesfgewu/multiagentSystem/releases/download/v0.0.3-beta.5/release-candidate.json)。
2. 核對 JSON：`version` 是 `0.0.3`，`prerelease` 是 `true`，`release` 是 `v0.0.3-beta.5`，`sourceCommit` 是 `4beeb59f6d38bc022cdc132857c7ce9382789332`。
3. 計算 VSIX 的 SHA-256，必須與 JSON 的 `artifact.sha256` 完全相同：`fd938e107e6770b3f39f4b775d04402b54f9d262f7774aba518e12a871bb1509`。macOS 可用 `shasum -a 256 multiagentsystem.vsix`；Windows PowerShell 可用 `Get-FileHash .\multiagentsystem.vsix -Algorithm SHA256`。

此專案沒有設定 publisher，也不會自動上架 Marketplace。Beta 5 Release 的來源 commit 可能和目前 `main` 上的文件版本不同，以上雜湊對應 Release 中的檔案。較舊的版本保留供回復：[Beta 4](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta.4)（SHA-256 `36f77104830dc339fa2e57ac0f4f5c4f6ac74f594ee4ebfd3c2adf72df090cb3`）、[Beta 3](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta.3)（SHA-256 `af1a7aaaa858c81db55cbd209874ad5a0d7089c460b83cd7940d9bcb975cf8dd`）、[Beta 2](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta.2)（SHA-256 `123da5468d620e25fcaaee787df593f5b8eb699625cc5b540a481e201bd76374`），以及[第一版 Beta](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta)。第一版不含報告頁的完整留言與檔案入口。

## 此版更新（相對 Beta 4）

依使用者以 Beta 4 試用後的回饋（[#311](https://github.com/Disesfgewu/multiagentSystem/issues/311)）改版：

- **指揮台（Open Command Center）**：在編輯區開啟總負責人畫面，不再擠在側欄。
  - 左側固定 PM 面板，顯示待決策事項與額度提醒。
  - 其他 agent 以卡片顯示：狀態、正在處理的 Issue／PR、worktree 變更、最新報告摘要、額度。
  - 可以切換格狀或清單、拖曳排序、收合、釘選。
- **帳號與額度面板**：每個帳號顯示登入與核實身分、5 小時與每週用量、重設時間、來源；讀不到時寫原因並附上下一步。token 用量紀錄可以檢視與匯出。Codex 的額度改從本機 session 紀錄讀取。
- **派送任務**：
  - 可以把 Issue 指派給 agent，或一次對多個 agent 下同一段任務。
  - 廣播會直接輸入到正在等待輸入的 agent CLI。
  - 送出前都要確認；狀態未知的 agent 要另外按明確的按鈕才會送出。
- **身份組工具權限**：PM 不能編輯檔案、commit、push 或合併；worker 可以開發與開 PR；researcher 唯讀。這些權限會轉成 Claude Code 的官方 permissions 規則；Bash 的前綴比對有已知限制，標為「部分強制」。
- **CLI 預設自動模式**（可在使用者設定關閉）、**專案報告匯出成 Markdown**、**不加 co-author**。

尚未包含（開發中）：團隊共同規則、共享記憶的操作介面、從 PR 報告跳到程式碼、與 PM 討論、開會。

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

- Release tag `v0.0.3-beta.5` 指向上述來源 commit，並標為 prerelease。
- 來源 commit 的 Build、Terminal session model、GitHub read adapter、Git worktrees 四個 GitHub Actions workflow 全部成功，含 macOS／Windows 封裝與 Extension Host 冒煙測試。本機 typecheck 通過，2055 項測試通過、0 失敗。
- 封裝檢查通過，含 219 個檔案；唯一打包的第三方套件是 fflate 0.8.3（MIT）。
- 從 Release 下載回來的 VSIX 已重新計算 SHA-256，與 `release-candidate.json` 的來源 commit、版本、檔名、大小（819528 bytes）與 SHA-256 都相符。Release 說明列出了未驗證事項。
