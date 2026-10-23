# Multiagent System 0.0.3 Beta

這是供試用與實測的 prerelease。它沒有宣稱完整產品、真實 CLI、真實帳號或雙平台使用流程已通過。

## 取得與核對

1. 從 [GitHub Beta 8 Release](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta.8) 下載 [multiagentsystem.vsix](https://github.com/Disesfgewu/multiagentSystem/releases/download/v0.0.3-beta.8/multiagentsystem.vsix) 與 [release-candidate.json](https://github.com/Disesfgewu/multiagentSystem/releases/download/v0.0.3-beta.8/release-candidate.json)。
2. 核對 JSON：`version` 是 `0.0.3`，`prerelease` 是 `true`，`release` 是 `v0.0.3-beta.8`，`sourceCommit` 是 `be622b579f199b6dace515c9d07a7d0206baa537`。
3. 計算 VSIX 的 SHA-256，必須與 JSON 的 `artifact.sha256` 完全相同：`28ba0812b7a382bfd774850d8cd818c65f4737f2c19581be0312ff247a85df84`。macOS 可用 `shasum -a 256 multiagentsystem.vsix`；Windows PowerShell 可用 `Get-FileHash .\multiagentsystem.vsix -Algorithm SHA256`。

此專案沒有設定 publisher，也不會自動上架 Marketplace。Beta 8 Release 的來源 commit 可能和目前 `main` 上的文件版本不同，以上雜湊對應 Release 中的檔案。較舊的版本保留供回復：[Beta 7](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta.7)（SHA-256 `dece6eb23727467df9a457c5f3f5d79fd2d76f583439c2efd6856ea1421ac6e5`）、[Beta 6](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta.6)（SHA-256 `aa869fe0fbdde7da886770b7ce7128cfbc33a990288ac66956324f3bd69cd144`）、[Beta 5](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta.5)（SHA-256 `fd938e107e6770b3f39f4b775d04402b54f9d262f7774aba518e12a871bb1509`）、[Beta 4](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta.4)（SHA-256 `36f77104830dc339fa2e57ac0f4f5c4f6ac74f594ee4ebfd3c2adf72df090cb3`）、[Beta 3](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta.3)（SHA-256 `af1a7aaaa858c81db55cbd209874ad5a0d7089c460b83cd7940d9bcb975cf8dd`）、[Beta 2](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta.2)（SHA-256 `123da5468d620e25fcaaee787df593f5b8eb699625cc5b540a481e201bd76374`），以及[第一版 Beta](https://github.com/Disesfgewu/multiagentSystem/releases/tag/v0.0.3-beta)。第一版不含報告頁的完整留言與檔案入口。

## 此版更新（相對 Beta 7）

這一版是**管理者第一次發行版測試**要用的版本，請照 #135 的 T311、T342、T343 逐項走查。

- **每個 agent 有自己的代號**（#344）：例如 `PM-01`、`Worker-01`、`Researcher-03`。
  - 代號依身份組分配，重新啟動後沿用；號碼不會重複，也不會重用。
  - 指揮台、總覽、session 清單與會議紀錄都會顯示代號。
  - 啟動時會告訴 agent 它的代號與署名格式。這段指示會出現在預覽裡，所以每次互動式啟動都會先確認。
  - 自訂角色名稱是 admin、owner、manager 這類時，代號改用 `Agent`。
  - 詳見 [Agent 代號與 GitHub 署名](AGENT_CODENAMES.md)。
- **agent 發到 GitHub 的內容自動署名**（#345、#348）：擴充套件在 agent 的終端機放一個 `gh` 包裝程式。
  - `gh pr|issue create|comment|edit` 與 `gh pr review`：沒有署名時，在第一行補上；冒用別人代號或冒充管理者時拒絕。比對前會先正規化全形字、相似字母、零寬字元與 Unicode 換行。
  - `gh api` 只放行唯讀呼叫；alias、extension、`auth token` 由允許清單擋下；找不到真正的 gh 時一律拒絕。
  - macOS／Linux、PowerShell、cmd 都能啟動；Windows 上不放 `gh.cmd`。
  - **限制**：只開 shell、沒有啟動 CLI 的終端機沒有包裝程式。agent 若用 curl，或直接呼叫真正的 gh，仍能繞過，所以署名屬於自稱，不是身分驗證。
- **報告頁分清作者**（#346）：
  - 你從 VS Code 發的留言或 review，GitHub 確認後會記下 ID 與內文雜湊；兩者都相符，才顯示「管理者」。
  - agent 的留言顯示「Worker-01（自稱）」。
  - 其他留言一律顯示「未署名」；這個 repo 是公開的，陌生人的留言不會被當成管理者。
  - 詳見 [GitHub 留言的作者](GITHUB_AUTHORSHIP.md)。
- **在 VS Code 透過 GitHub 留言和 PM 對話**（#347）：選一張 Issue 或 PR，開啟 **Talk to PM via GitHub**。
  - 送出的訊息會發成留言；讀回確認之後，經你確認才通知 PM。
  - 畫面開著時，每 45 秒讀一次回覆；有新留言時跳出通知。
  - GitHub 上的任何文字都不會觸發打字。
  - 尚未提供「建立會議 Issue」，請先選一張現有的 Issue 或 PR。
  - 詳見 [透過 GitHub 留言和 PM 對話](TALK_TO_PM.md)。
- **測試穩定度**（#350）：修正兩個 CI 偶發失敗：meeting 的 host 測試，以及 Windows 隔離量測。

其餘功能和 Beta 7 相同。

尚未在實機上走過：真實的 Claude Code 與 Codex 是否走到 `gh` 包裝程式、是否照指示署名；Windows PowerShell 5.1 的參數傳遞；真實 PM CLI 透過 GitHub 的一來一回。這些都列在 #135 的 T342、T343。身份組的工具權限並非完全強制，各 CLI 的強制程度說明同 Beta 5。Windows 受管隔離（#289）依管理者決定暫緩，不在這一版。

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

- Release tag `v0.0.3-beta.8` 指向上述來源 commit，並標為 prerelease。
- 來源 commit 在 main 上的 CI 14 項全部成功。在隔離 worktree 對來源 commit 執行 `npm ci`、`tsc`、`npm test`：2243 項，2235 通過、0 失敗（其餘 8 項依平台略過）。
- VSIX 由來源 commit 以 `npm run vsix:package` 產生，`verify-vsix` 確認共 242 個檔案（903651 bytes）；唯一打包的第三方套件是 fflate 0.8.3（MIT）。從 Release 下載回來的 VSIX 重新計算 SHA-256，與 `release-candidate.json` 相同，壓縮檔內也是 242 個檔案。
- 雜湊以本頁與 `release-candidate.json` 為準。
- **尚未在實機上走過**：#135 的 T311、T342、T343（總負責人流程、gh 包裝程式與署名、透過 GitHub 和 PM 對話）。
