# Git worktree 服務

`src/projects/worktrees.js` 是無套件依賴的本機 Git 服務。入口須先取得 VS Code Workspace Trust；所有路徑、工作目錄與 commonDir 均為私人本機資料，不能直接作為 GitHub 訊息內容。

```js
const { WorktreeService } = require('../src/projects/worktrees');
const project = await WorktreeService.open(absoluteProjectPath);
const worktrees = await project.list();
const created = await project.create({ branch: 'feature/issue-10', target: absoluteNewPath });
await project.remove(created.path);
```

`open` 支援一般 repo 與 linked worktree（`.git` 為指向檔），以 canonical commonDir 辨識同一本機 repo。GitHub remote 僅回傳不含憑證的 canonical owner/repo；沒有 origin 或不是 GitHub remote 時為 null。GitHub 數字 repo ID 之後由讀取 adapter 補上；bare repo 不屬此入口支援範圍。

`create` 驗證 branch 與 base，使用可執行檔／引數陣列呼叫 Git，拒絕工作目錄重疊與無法解析的路徑。Git 自己處理 branch 並行競爭；失敗時不任意刪除可能已建立的 branch 或使用者檔案。

`remove` 僅接受已登記的 linked worktree，保護 primary、服務目前所在的 worktree 與 locked worktree。存在 tracked 變更、untracked 或 ignored 檔案時拒絕釋放，不使用 force、clean 或 reset，也不刪除 branch。呼叫端須先停止受管寫入者並確認工作已交付；外部任意程序的寫入不受此服務控制，不能把一次 status 檢查當成跨程序隔離保證。

執行 `node --test test/projects/worktrees.test.js` 驗證服務。CI 在 macOS 與 Windows 執行真實暫存 Git repo、Unicode／空白路徑、link／junction 及並行建立情境。這些測試不取代 VS Code 導覽整合驗收；命令／總覽入口由 session 與專案總覽功能接續。

## VS Code 命令

三個命令呼叫上述服務，不重寫其邏輯（`src/projects/worktreeController.ts` 為不依賴 `vscode` 的流程，`worktreeCommands.ts` 為薄薄的 VS Code UI 層）：

| 命令 | 行為 |
| --- | --- |
| `Multiagent: List and Open Worktrees` | 列出專案所有 worktree（分支、短 SHA、primary／此視窗／locked／missing／detached 標示、路徑），選取後在新視窗開啟；選到目前視窗的 worktree 只提示。 |
| `Multiagent: Create Worktree` | 輸入新 branch 名稱與資料夾（預設建議在 repo 旁的 `<repo>-worktrees/<branch>`，不在 repo 內），建立後可選擇在新視窗開啟。 |
| `Multiagent: Release Worktree` | 只列出可釋放的 linked worktree（排除 primary 與目前視窗），需要強制確認視窗；branch 保留。 |

行為界線：

- 釋放**沒有強制選項**。含 tracked 變更、untracked 或 ignored 檔案、locked、missing 的 worktree 會被拒絕並顯示原因與「Nothing was deleted」；不存在任何略過檢查的參數。
- Git 失敗（例如 branch 已存在或已被其他 worktree 使用）顯示 Git 自己的 `fatal:` 說明；路徑重疊、無法驗證的路徑、非法 branch 分別有獨立訊息。
- 需要受信任的工作區：擴充套件沿用 VS Code 預設（未宣告 `untrustedWorkspaces`，Restricted Mode 下整個擴充套件停用），命令內再檢查 `isTrusted` 作為縱深防禦；信任策略由 #11 重寫啟動流程時一併決定。多根工作區會先選專案資料夾；不在 Git repo 內時回報明確訊息。從 repo 子資料夾開啟時，服務以 `git rev-parse --show-toplevel` 取得該 worktree 根目錄，所以「此視窗」標示與保護仍正確。
- 路徑與 worktree 資訊只用於本機 UI，不寫 log、不進入 GitHub。

命令可帶選項物件呼叫（供 Extension Host 冒煙測試）：`{ interactive: false, folder?, branch?, target?, base?, path?, confirmed? }`。`interactive: false` 不顯示任何提示並回傳結構化結果；釋放時若沒有 `confirmed: true` 就視為取消。`confirmed` 只對 `interactive: false` 生效，互動呼叫一律由確認視窗決定。這個形式沒有放寬任何服務檢查；其他擴充套件仍可用非互動形式釋放**乾淨**的 worktree（含本機檔案者仍被服務拒絕，branch 保留）。

### 驗證範圍

- 單元測試（`test/unit/worktreeController.test.ts`）以真實暫存 Git repo 驗證建立、列出、釋放、各種拒絕原因與取消流程。
- Extension Host 冒煙測試在 VS Code 1.95.0 與 stable 以真實 Git 工作區執行建立／列出／含本機檔案時拒絕釋放／乾淨釋放。
- **未驗證**：互動式 UI（QuickPick、輸入框、確認對話框）的實際操作、「在新視窗開啟」、macOS／Windows 實機的多 worktree 日常操作與 Windows 磁碟代號／空白／Unicode 路徑在 UI 的表現。這些需要人工實機驗收，CI 不能代替。
