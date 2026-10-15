# multiagentSystem

以支援 macOS 與 Windows 的 VS Code 擴充套件管理同一個 GitHub 專案中的多個 CLI coding agents。每個 agent 使用可直接操作的真實終端機；使用者可在同一畫面查看工作、程式碼、角色、帳戶及可取得的用量資訊。

產品將支援 PM 與 worker 等自訂身份組、依身份共享的精選記憶，以及以 GitHub Issues／PRs 為主的任務與 review 流程：PM 定義 issue，coding agent 領取任務並提交 PR，PM review 通過後由人工或依設定由 PM merge。使用者可為同一 CLI provider 登入多個帳號，指定各 agent 使用的帳號並查看可取得的各帳號額度。執行階段 agent 資訊不得進入 GitHub 提交與協作內容。

第一階段內建三個 CLI provider：Claude Code、Codex CLI 與 agy（登錄核心已建立，見 [Provider 登錄](docs/PROVIDERS.md)；啟動選單等尚未改用登錄，所以目前的選單仍只有前兩項）。agy 只假設能在原生 terminal 啟動，其餘能力一律未知；使用者自訂 provider 尚未支援。

目前已有 P0 原生 terminal 雛形。需求、技術選型、開源參考、風險、里程碑與驗收標準見 [實作計劃書](docs/IMPLEMENTATION_PLAN.md)。

## 試用 P0 雛形

在 VS Code 開啟這個資料夾，按 `F5` 啟動 Extension Development Host；在新視窗的 Command Palette 執行：

- `Multiagent: Open Four Native Terminals`：開啟四個可直接輸入的 VS Code 原生 terminal，名稱為 PM、Worker 1–3。依 VS Code 實際排列，必要時手動拖曳或分割成想要的格局。
- `Multiagent: Launch CLI Agent in Native Terminal`：選 Claude Code 或 Codex CLI，再輸入 terminal 名稱；CLI 在新建的原生 terminal 執行，使用目前環境的 CLI 登入與預設 shell。

## 開發與驗證

需求：Node.js 24 以上與 VS Code 1.95 以上。

```text
npm ci               # 依 package-lock.json 安裝（鎖定相依版本）
npm run check        # TypeScript 型別檢查，不輸出檔案
npm run build        # 編譯到 out/
npm test             # 型別檢查 + 建置 + 單元測試
npm run test:host    # 在隔離的 Extension Host 載入建置結果並執行命令
```

- 按 `F5` 會先執行 `npm: build`，再啟動 Extension Development Host。建置輸出位於 `out/`，不納入版本控制。
- `npm run test:host` 會下載 VS Code（預設 1.95.0，可用環境變數 `VSCODE_VERSION` 指定，例如 `stable`）到 `.vscode-test/`，使用暫存的使用者資料與工作區，執行時會短暫開啟一個視窗，不讀取或修改你的 VS Code 設定。
- CI 在 macOS 與 Windows 分開回報兩類結果：**型別檢查與單元測試**，以及 **Extension Host 冒煙測試**（只證明建置結果可載入、命令可執行且建立四個原生 terminal）。輸入、互動提示、`Ctrl+C`、重啟與分格排列等**實機驗收不在 CI 內**，仍須在真實視窗中人工驗證。
- 既有的 `test/**/*.test.js`（純 Node 的 P0 模組測試）與編譯後的 TypeScript 測試一起由 `npm run test:unit` 執行；新增 JavaScript 模組時放在 `src/`，會隨 `allowJs` 原樣輸出到 `out/`。

此雛形尚未實作帳號隔離、額度讀取、Issue／PR 操作、身份規則或防外洩強制控制，也尚未完成 macOS／Windows 的四格實機驗收。給 Claude Code worker 的持續實作指令與 PM 工作方式見 [Claude Code worker prompt](docs/CLAUDE_CODE_WORKER_PROMPT.md)。
