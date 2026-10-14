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
