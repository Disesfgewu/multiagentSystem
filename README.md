# multiagentSystem

以支援 macOS 與 Windows 的 VS Code 擴充套件管理同一個 GitHub 專案中的多個 CLI coding agents。每個 agent 使用可直接操作的真實終端機；使用者可在同一畫面查看工作、程式碼、角色、帳戶及可取得的用量資訊。

產品將支援 PM 與 worker 等自訂身份組、依身份共享的精選記憶，以及以 GitHub Issues／PRs 為主的任務與 review 流程：PM 定義 issue，coding agent 領取任務並提交 PR，PM review 通過後由人工或依設定由 PM merge。使用者可為同一 CLI provider 登入多個帳號，指定各 agent 使用的帳號並查看可取得的各帳號額度。執行階段 agent 資訊不得進入 GitHub 提交與協作內容。

第一階段內建三個 CLI provider：Claude Code、Codex CLI 與 agy（見 [Provider 登錄](docs/PROVIDERS.md)）。啟動選單與身份組現在都使用登錄；agy 可選擇在原生 terminal 啟動，規則與記憶以手動方式注入，其餘能力一律未知；使用者自訂 provider 尚未支援。

目前已有原生 terminal、GitHub 清單、Agent 總覽，以及帳號與身份組的部分操作入口；PM 報告、決策佇列、完整帳號額度控制、MCP 權限與共享記憶尚未完成，不能視為可用的管理平台。以 GitHub Issues／PRs 追蹤目前需求與交付：整體進度見 [Issue #76](https://github.com/Disesfgewu/multiagentSystem/issues/76)，決策工作台見 [Issue #106](https://github.com/Disesfgewu/multiagentSystem/issues/106)。[舊交付台帳](docs/MASTER_PLAN.md)僅供查閱歷史紀錄，不再是側欄功能或即時狀態來源。需求與驗收標準見 [實作計劃書](docs/IMPLEMENTATION_PLAN.md)，PM 工作規則見 [PM system prompt](docs/PM_SYSTEM_PROMPT.md)。

## 試用 P0 雛形

首次安裝、Tools Setup 狀態、四個原生終端與故障復原步驟見 [首次設定與診斷](docs/GETTING_STARTED.md)。

在 VS Code 開啟這個資料夾，按 `F5` 啟動 Extension Development Host；在新視窗的 Command Palette 執行：

- 開啟 Explorer 裡的 **Multiagent GitHub** 區塊，即可列出目前專案的開放 Issues／PRs；點選項目會在 VS Code 編輯器讀取內容，PR 頁會讀取 review／CI 摘要。可按標題列的 Refresh 更新清單。此切片只讀取 GitHub；建立、review 與 merge 的套件內操作仍待後續工作。

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

此雛形尚未實作帳號隔離、額度讀取、Issue／PR 寫入操作、身份規則或防外洩強制控制，也尚未完成 macOS／Windows 的四格實機驗收。給 Claude Code worker 的持續實作指令與 PM 工作方式見 [Claude Code worker prompt](docs/CLAUDE_CODE_WORKER_PROMPT.md)。
