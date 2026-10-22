# Multiagent System 0.0.3 Beta

這是供試用與實測的 prerelease。它沒有宣稱完整產品、真實 CLI、真實帳號或雙平台使用流程已通過。

## 取得與核對

1. 從 [GitHub Beta 6 Release](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta.6) 下載 [multiagentsystem.vsix](https://github.com/Disesfgewu/multiagentSystem/releases/download/v0.0.3-beta.6/multiagentsystem.vsix) 與 [release-candidate.json](https://github.com/Disesfgewu/multiagentSystem/releases/download/v0.0.3-beta.6/release-candidate.json)。
2. 核對 JSON：`version` 是 `0.0.3`，`prerelease` 是 `true`，`release` 是 `v0.0.3-beta.6`，`sourceCommit` 是 `db8ceb11a39f021fcf7de3a77de19107ac9edaa5`。
3. 計算 VSIX 的 SHA-256，必須與 JSON 的 `artifact.sha256` 完全相同：`aa869fe0fbdde7da886770b7ce7128cfbc33a990288ac66956324f3bd69cd144`。macOS 可用 `shasum -a 256 multiagentsystem.vsix`；Windows PowerShell 可用 `Get-FileHash .\multiagentsystem.vsix -Algorithm SHA256`。

此專案沒有設定 publisher，也不會自動上架 Marketplace。Beta 6 Release 的來源 commit 可能和目前 `main` 上的文件版本不同，以上雜湊對應 Release 中的檔案。較舊的版本保留供回復：[Beta 5](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta.5)（SHA-256 `fd938e107e6770b3f39f4b775d04402b54f9d262f7774aba518e12a871bb1509`）、[Beta 4](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta.4)（SHA-256 `36f77104830dc339fa2e57ac0f4f5c4f6ac74f594ee4ebfd3c2adf72df090cb3`）、[Beta 3](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta.3)（SHA-256 `af1a7aaaa858c81db55cbd209874ad5a0d7089c460b83cd7940d9bcb975cf8dd`）、[Beta 2](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta.2)（SHA-256 `123da5468d620e25fcaaee787df593f5b8eb699625cc5b540a481e201bd76374`），以及[第一版 Beta](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta)。第一版不含報告頁的完整留言與檔案入口。

## 此版更新（相對 Beta 5）

補齊 Beta 4 試用回饋（[#311](https://github.com/Disesfgewu/multiagentSystem/issues/311)）中剩下的總負責人工作台功能：

- **沒有執行中的 agent 也能指派任務**：把 Issue 指派給某個身份組時，若沒有可用的 session，會經過確認後建立 worktree、啟動該身份組，等 CLI 回報可以輸入後才送出任務。任何一步失敗都不會送出。
- **團隊共同規則**：可以編輯一份所有 agent 都要遵守的規則，啟動時排在身份組規則之前一起交給 CLI，預覽中看得到。
- **Shared Memory 面板**：依身份組和隱私域列出共享筆記，可以新增、修改、關閉、刪除，也可以審核建議記憶；只有已採納的筆記才會交給之後啟動的 agent。
- **從 PR 報告跳到程式碼**：點變更檔案或行內審查留言會跳到那一行；本機 Git 有該 PR 的 head 與 base 時開啟並排 diff，否則改開 agent 資料夾裡的版本或 GitHub 的 patch。
- **Discuss with PM Agent**：在編輯器選取程式碼後按右鍵，輸入問題，確認後送給 PM agent。
- **Start Meeting**：把同一個主題同時送給多個 agent，回覆由你從剪貼簿貼入並整理成會議紀錄；沒貼的標示為沒有回覆，不代為編寫。
- **自動模式首次確認**：第一次以自動模式啟動 CLI 時會先詢問，之後記住你的選擇。
- **用量與額度**：token 用量紀錄可以依 session 篩選、相同讀數不重複記錄；Codex 額度的時間窗已重設時顯示為未知，Codex session 更新時也會記錄最後一次請求的 token 數（同一事件只記一次、依帳號節流）。
- **修正**：匯出 Markdown 時，GitHub 文字中的網址不再被自動轉成連結。

尚未在實機上走過：#311 列的總負責人流程（指揮台、指派、同時下任務、團隊規則、跳到程式碼與討論、開會、匯出、PM 不能 commit）。各 CLI 是否真的讀到規則、記憶、任務與會議內容，屬於實機項目（#135）。身份組的工具權限並非完全強制，各 CLI 的強制程度說明同 Beta 5。

尚未包含：agent 自己提出建議記憶的收集（#333，審查中）。

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

## 發行核對結果（依 Release 說明）

- Release tag `v0.0.3-beta.6` 指向上述來源 commit，並標為 prerelease。
- 來源 commit 的 CI 22 項全部成功，含 macOS 與 Windows 的單元測試、Extension Host smoke 與 VSIX 打包；在隔離 worktree 對來源 commit 執行 `npm ci`、`tsc`、`npm test`：2170 項，2162 通過、0 失敗。
- VSIX 由來源 commit 以 `npm run vsix:package` 產生，`verify-vsix` 確認共 233 個檔案（863638 bytes）；唯一打包的第三方套件是 fflate 0.8.3（MIT）。
- 雜湊以本頁與 `release-candidate.json` 為準。
- **尚未在實機上走過**：#311 列的總負責人流程；各 CLI 是否真的讀到規則、記憶、任務與會議內容屬於實機項目（#135）。
