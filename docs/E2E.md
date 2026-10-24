# 端到端測試（#361）

`npm run test:e2e` 用 Playwright 的 Electron 模式（`playwright-core` 1.64.0）啟動真實的 VS Code（預設 1.95.0，可用 `MULTIAGENT_E2E_VSCODE` 指定），載入編譯後的擴充套件，開啟一個暫存的 Git 專案，然後只用滑鼠與鍵盤操作畫面上看得到的東西。Command Palette 是鍵盤的入口；測試不呼叫擴充套件內部的指令。

## 環境（全部是合成的）
- **暫存的 VS Code profile**：user data、extensions 資料夾都在暫存資料夾裡。`HOME` 指向暫存資料夾，所以不會讀寫你自己的 `~/.claude` 或 `~/.codex`。
- **合成的 CLI**：PATH 最前面放了合成的 `claude`、`codex`、`agy`、`gh`（`test/e2e/fakes.js`）。
  - 它們會回答 `--version` 與 `auth status`，email 一律是 `owner-a@example.test`。
  - 每次被呼叫都會寫一行到 `calls.jsonl`，步驟可以檢查擴充套件實際呼叫了什麼。
- **網路**：
  - 擴充套件第一次使用時下載 GitHub CLI 的動作會被關掉。方式是環境變數 `MULTIAGENT_E2E_NO_DOWNLOAD=1`，它只在 Development 模式（e2e 以 `--extensionDevelopmentPath` 啟動）下有效。安裝後的擴充套件是 Production 模式，任何設定、參數或環境變數都無法讓它跳過下載，也沒有任何驗證被跳過（`src/setup/firstUse.js`）。
  - VS Code 本身的請求會送到本機一個關閉的 port（`http.proxy`），更新、實驗功能與擴充套件市集也都關閉。
  - 網路並沒有在作業系統層級封鎖：曾試過 macOS 的 `sandbox-exec`，但在那種環境下 VS Code 的工作台無法載入。

## 結果
- `artifacts/e2e/<項目編號>-<步驟>.png`：每一步的截圖。失敗的步驟會留下失敗當下的截圖（`-failed.png`）。
- `artifacts/e2e/REPORT.md`：每一項的通過或失敗、每個檢查看到了什麼、截圖連結。另外還有 `report.json`。
- CI 的 `End-to-end screens` job（macOS）每次都會上傳整個資料夾，artifact 名稱是 `e2e-report`。
- `npm run test:e2e -- --update-guide`：所有項目都通過時，把截圖複製到 `docs/user-guide/images/`，供 [使用教學](USER_GUIDE.md) 使用。

## 「檢查通過」不等於「已驗收」
報告把兩件事分開寫：
- **checks**：每一步的檢查是否成立。
- **accepted (#360)**：這一項是否已經符合 #360 的驗收條件。

每一項在 `steps.js` 裡標出 `acceptance`：
- `accepted`：步驟檢查的內容，正是 #360 要管理者看到的。
- `framework`：只證明畫面到得了。
- `not-done`：功能還沒做；用 `pending` 寫明還差什麼，以及負責的 issue。

只有標成 `accepted`、而且每個檢查都成立的項目，報告才會寫「accepted」；檢查通過但沒有標成 accepted 的項目，會寫「checks pass — NOT DONE (…)」。

目前已驗收（#357）：
- **00 側欄**：只留一個入口，原本的 view 都不在畫面上。
- **11 指揮台**：從工作台新增帳號並檢查登入、建立身份組、啟動 3 個 agent，畫面上有 3 張卡片，每張都有代號、帳號（含 email）與模式。

## 寫步驟時要注意
- `drive(page, answers, done)` 依提示文字回答 VS Code 自己的視窗（quick pick、輸入框、modal）。設定裡的 `window.dialogStyle` 是 `custom`：系統原生的對話框不在頁面裡，看不到也點不到。
- agent 的終端機會在編輯區打開，蓋在工作台前面，所以操作工作台前要先點它的分頁。
- 截圖前要先 `npm run build`，因為 `run.js` 載入的是編譯後的擴充套件。
- `MULTIAGENT_E2E_DEBUG=1`：在等待時截圖，每個流程最多 20 張，用來看頁面碰不到的視窗。

## 新增一項
每個面向使用者的 PR，都要在 `test/e2e/steps.js` 補上自己那一項（#360 的編號）：
- 每一步寫明 `does`，也就是管理者要按哪裡。
- 每一步都要用 `check` 斷言畫面上的文字。
- 然後執行 `--update-guide`，並在 `docs/USER_GUIDE.md` 的對應章節加上說明與截圖。

小工具：
- `runCommand(page, title)`：開啟 Command Palette、輸入指令、按 Enter。
- `webviewText(page, title, wait)`：讀取 webview 的文字。
- `clearNotifications(page)`：截圖前關掉右下角的通知，不使用遮蓋。

## 限制
e2e 證明的是「畫面與流程」。以下項目仍要在實機確認（#135）：
- 真實帳號的登入。
- 真實的 CLI 是否照指示執行。
- 原生 Windows 上的行為。

另外，Windows 的 e2e 目前還沒加入 CI。
