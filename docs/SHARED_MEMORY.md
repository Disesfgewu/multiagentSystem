# 共享記憶的操作介面（Issue #306，驗收 2–4）

後端沿用 `src/memory/`（`docs/MEMORY_DOMAINS.md`）。這一輪補上介面與注入：

## Shared Memory 面板
Multiagent 側邊欄的 **Shared Memory**：依身份組、再依隱私域分組列出這個專案的筆記，每則顯示狀態（啟用／已關閉／待複核／過期／被隔離）、是否會給之後啟動的 agent、來源、範圍與到期日；上方另列「等待審核的建議」。內容只存在這台電腦。

指令（都**不接受參數**，身份組、文字、選哪一則、確認都來自視窗；修改前一律有 modal 確認；未信任的工作區不能改）：
- **Add Shared Memory Note**：選身份組與隱私域（預設各帳號各自一域）、輸入文字 → 經過既有的 `sensitive`／transcript 檢查與去重 → 確認後以本機使用者的名義採納。
- **Edit**：新文字是一則新筆記（一樣先檢查），儲存成功後才刪掉舊的；新文字被拒時保留舊的。
- **Switch On or Off**（停用保留、不再給 agent）、**Delete**。
- **Record Agent Suggestion as Memory Candidate**：目前**沒有**從執行中 agent 自動進入這個儲存庫的通道，所以由你貼上 agent 的建議並指明是哪個 session；它只是候選，**不會**給任何 agent。
- **Review Suggested Memory**：採納（以本機使用者名義）或拒絕。沒有這個視窗，沒有任何東西會被採納。

## 注入
身份組的記憶範圍設為 `role-group` 時，啟動 agent 前（準備指令快照時）把該身份組、這個專案、這個帳號隱私域內「已採納、未關閉、未過期」的筆記加進注入內容（沿用 `memory/injection.js`；預算超過時說明省略了幾則）。範圍為 `off` 就不給。

- 記憶檔存在但讀不到 → 拒絕啟動（`memory-unavailable`），不會悄悄少帶。
- 快照記錄了用到的筆記（id＋版本），並計入指令摘要；準備之後筆記被改、關閉或新增 → 快照過期（`memory-changed`）。
- 預覽（指令摘要）顯示「Shared memory: N reviewed notes prepared」。
- 指揮台卡片顯示「Prepared for this agent: N rules and M shared notes」。這是**準備好要告訴 CLI 的**數量，不是 CLI 讀了的證明；不知道時寫 unknown。

## 限制
- 這是告訴 CLI 的指示，不是強制；已在執行的 agent 不會被改。
- 隱私域只做到「每個帳號各自一域」；跨域授權（`grants`）沒有操作介面。
- 沒有真的 Claude Code／Codex 驗證（#135）。
