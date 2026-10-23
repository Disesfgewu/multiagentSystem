# VSIX 打包與授權核對（#29 切片）

在 Node.js 24 執行 `npm ci --ignore-scripts`、`npm run vsix:package`，候選封存會寫至 `artifacts/multiagentsystem.vsix`，證據清單寫至 `artifacts/release-candidate.json`。清單把套件版本、完整 40 碼來源 commit、VSIX 位元組數、內容檢查檔案數與 SHA-256 綁在一起。這些檔案不受 Git 追蹤，流程本身不會建立 GitHub Release 或上架 Marketplace。

清單的 `release` 預設是 `v<版本>-beta`。發行第 N 個 Beta 時，以環境變數帶入 tag，例如 `RELEASE_TAG=v0.0.3-beta.8 npm run vsix:package`（直接執行腳本時也可用第三個參數：`node scripts/release-candidate.js <vsix> <json> v0.0.3-beta.8`）。tag 必須符合 `v1.2.3`、`v1.2.3-beta` 或 `v1.2.3-beta.4` 格式，且版本須與 VSIX 內的套件版本相同，否則不寫出清單並以失敗結束。

macOS 與 Windows CI 各自從鎖定的依賴重新建置、打包、檢查封存內容，再保存 14 天供審查。各平台的 ZIP 封裝 metadata 可能不同，審查時必須以同一份 artifact 內的 JSON 雜湊核對同一份 VSIX，不能拿另一個 job 的雜湊代替。雙平台 CI 打包也不等於乾淨機器已完成安裝、升級或移除。

封裝只允許 extension manifest、README、MIT 授權、第三方聲明、圖示、編譯後 `out/src`／`out/packages` JavaScript，以及唯一的執行期 npm 相依 `fflate`。`src`、測試、文件、腳本、source map、開發設定與本機產物均排除。`scripts/verify-vsix.js` 直接解開產出的 VSIX，確認入口檔與相依授權檔存在、manifest 的執行期相依與鎖檔一致、沒有額外路徑，並對套件自有文字使用 #23 的 `scanPublication`。掃描器自身兩個實作檔含刻意的敏感路徑／憑證測試字串，第三方 `fflate` 檔案由 `npm ci` 鎖檔完整性保障；這些檔案不接受文字掃描的「clear」宣稱。封裝掃描不等於證明不存在未知型態、編碼或二進位秘密，發佈仍需人工審查。

| 進入 VSIX 的執行期相依 | 固定版本 | 授權 | 證據 |
| --- | --- | --- | --- |
| `fflate` | `0.8.3` | MIT | `package-lock.json`、VSIX 內 `node_modules/fflate/LICENSE`、`THIRD_PARTY_NOTICES.md` |

`@vscode/vsce` 固定為開發工具 `4.0.0`（MIT），只在建置環境執行，不收入 VSIX。Git／gh／Claude Code／Codex CLI／agy 均不隨 VSIX 打包；其官方來源與部署限制見 [工具來源矩陣](TOOL_SOURCE_MATRIX.md)。

目前 `package.json` 尚無 `publisher`。加上 publisher 會改變 VS Code 的 `globalStorageUri` 資料夾名稱，可能讓既有私人資料看似消失；因此本切片只補 repository 供 `vsce` 正確處理 README 相對連結。正式決定 publisher 前需與 #27 完成舊資料夾偵測／安全遷移或清楚的使用者處理流程，再做實機升級驗收。

Beta 0.0.3 的安裝、回復、限制與人工發行核對見 [Beta 候選說明](BETA_0.0.3.md)。
