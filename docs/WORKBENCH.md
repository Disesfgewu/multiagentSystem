# 工作台與側欄（#357）

## 側欄只留一個入口

點活動列的 **Multiagent** 圖示，側欄只剩一個區塊「Multiagent」。由上到下：

| 行 | 說明 | 點了打開 |
|---|---|---|
| **Open Workbench** | 打開工作台 | 工作台的 Agents 分頁 |
| **Agents: N running**（右邊寫幾個在等你） | 這個視窗裡正在執行的 agent | Agents 分頁 |
| **Needs you: …** | 在等你的 agent、需要你處理的帳號；沒有時寫「nothing right now」 | 能處理那件事的分頁 |
| **Accounts: N accounts, M signed in** | 帳號數與已登入數；還沒有帳號時寫「none yet」 | Accounts 分頁 |

**狀態的顏色**：每一行都同時用顏色和文字表示狀態，不只靠顏色。
- 綠色：正常。
- 黃色：需要注意。
- 灰色：未知，代表讀不到；讀不到的數字一律寫「unknown」，不會寫成 0。

**原本的 9 個 view**（Overview、Issues Report、PRs Report、GitHub、Accounts and Sessions、Role Groups and Rules、Administrator Broadcasts、Shared Memory、Tools Setup）預設隱藏。要顯示它們有兩種方式：
- 打開設定 `multiagentSystem.showClassicViews`。
- 或在工作台的 **Setup** 分頁按 **Show classic views**。

它們能做的事，工作台都有入口。

## 工作台

可以從側欄的 **Open Workbench** 打開，也可以從 Command Palette 執行 `Multiagent: Open Workbench`。原本的 `Multiagent: Open Command Center` 也會打開同一個工作台。工作台開在編輯區，分頁固定如下：

| 分頁 | 現在有什麼 | 自己的畫面由哪個 issue 完成 |
|---|---|---|
| **Agents** | PM 面板、待決定的事項、每個 agent 一張卡片 | 已完成（本頁） |
| **Work** | 待決定的事項；Browse GitHub、Assign Issue、Export report | #353 |
| **Accounts** | 每個帳號的登入、方案、額度與按鈕；Add account | #352 |
| **Broadcast** | Send task、Create broadcast notice、Send broadcast to agents | #357 後續 |
| **Ask** | Talk to PM via GitHub、Discuss selection with PM、Start meeting | #353 |
| **Knowledge** | Team rules、新增或審查共享記憶、Install agent skills | #359 |
| **Setup** | 重新檢查工具、診斷、Sessions、Show classic views | #357 後續 |

**Agents 分頁**：
- 卡片用白話寫成，一個畫面至少放得下 4 張：
  - 代號、名稱、身份組、狀態。
  - CLI 與模型。
  - 帳號：名稱，以及這個視窗最近一次登入檢查讀到的 email。
  - 模式：一個詞，Auto、Ask、Dangerous 或 unknown。
  - 正在做什麼。
  - 一個主要按鈕：Focus terminal。
- **需要注意的事**會變成黃色小標，例如「VS Code not connected」「will ask to trust the folder」「auto mode not in effect」。原因放在 Details 裡。
- **Details**：放工作資料夾、報告、權限模式、額度、注入的規則數，以及其他證據；Collapse 與 Pin 也在這裡。
- **agent 的終端機**：啟動時先清除畫面，只顯示一行「Multiagent: starting <CLI> (<代號>)」。實際執行的指令不變。
- 沒有 agent 時，會顯示下一步：**Start agent…**、**Add account**、**Create role group…**。

**每個分頁都有下一步按鈕**：按鈕只會送出一個固定的名稱，由擴充套件對應到既有的指令，而且不帶任何參數。
- 要選哪個 CLI、哪個帳號、輸入什麼文字、要不要確認，都由那個指令自己的視窗詢問。
- 頁面送不出任何會直接停止、移除、合併或發佈的指令。

**Issues report／Pull requests report**：在 Work 分頁有自己的清單（#353）之前，這兩份報告仍在原本的 view。如果原本的 view 是隱藏的，按下時會先詢問要不要顯示原本的 view。

**從報告回到 agent**（Back to Agent Overview）：會打開工作台的 Agents 分頁；如果有顯示原本的 view，則回到 Overview。

## 還沒做（#357 後續）
- 卡片上的按鈕：換帳號、換模型、停止、以新模式重新啟動。依新的規則，這些都要先跳出 modal 確認。
- Setup 分頁的 **Show classic views** 會先跳出 modal 詢問，管理者同意後才寫入設定。
- Broadcast、Setup 分頁自己的畫面。
- 安裝後第一次啟動時，自動打開工作台並跑 5 步的入門流程。
- 頂端的輸入框：用說的就能下指令，先預覽、確認後才執行。
- e2e：側欄（00）與「一個畫面看到所有 agent」（11）的驗收步驟，要等 #371 的框架合併後補上。
