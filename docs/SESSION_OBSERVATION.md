# Session 狀態與用量觀測核心

對應 Issue #18 的第一個切片。這一版定義 provider 共用的本機觀測模型，以及 Claude 的結構化證據介面；沒有 hook／status line 安裝、CLI 輸出解析、VS Code UI 或真實帳號整合。

## 共用模型

`src/observations/session.js` 的 `SessionObservationCore` 先以 `sessionId`、`provider`、`accountProfileId` 註冊固定綁定，再接受版本化 evidence envelope。事件含固定 schema version、event id、遞增 sequence、時間戳、狀態與標準 usage 欄位。事件只存在記憶體，沒有持久化；session id 與 account profile id 是私人本機資料，不得放入 GitHub。

狀態只有 `working`、`waiting`、`completed`、`ended`。沒有 evidence 時是 `unknown`；terminal 輸出、shell 仍開著或送出命令都不是 evidence。事件重播依 event id 冪等；sequence 倒退、時間倒退、未來時間、未知 schema、provider／account 綁定不符與無效 usage 都拒絕，而且不會部分更新。`ended` 後的事件不能讓 session 復活。

每個 snapshot 都固定列出：

- `session.state`
- `session.model`
- `usage.input_tokens`
- `usage.output_tokens`
- `usage.cache_read_tokens`
- `usage.cache_write_tokens`
- `usage.cost_usd`

每個值沿用 `src/accounts/observation.js` 的 `field`、`value`、`unit`、`scope`、`source`、`observedAt`、`confidence`、`validForMs`。缺席欄位明確為 `unknown`，不沿用其他事件猜測。`actual` 是證據來源回報，`estimated` 是本機估算，source 另加 `.local-estimate`；兩者在 TTL 內都可顯示為 fresh，但只有 fresh `actual` 可通過既有 `isGateEligible()`，estimated 不能當硬性分派依據。到期後值成為 `unknown/stale`。

`source` 與 usage `scope` 只能是短的機器代碼，不能帶本機路徑、帳號標籤或自由文字。輸出不包含 event id，也不保存輸入物件或 transcript。

## Claude 證據介面

`src/observations/claude.js` 固定 provider、account 綁定與 source，接受的輸入只有已正規化的 event id、sequence、時間、狀態及 usage。它**不解析** terminal 文字、transcript、hook JSON、status line JSON、登入檔案或 token；多餘欄位會拒絕。

未來 host adapter 只有在依官方文件驗證 Claude 事件格式，並能把事件可靠綁定到本機 session 與 account profile 後，才可呼叫此介面。官方 hooks 與 status line 的候選來源已列於 `docs/IMPLEMENTATION_PLAN.md`，本切片沒有把文件範例當成已完成的真實整合。

## 未完成／未驗證

- Claude 官方 hook／status line 的實際 schema、版本變動、安裝與還原既有使用者設定。
- 真實模型名稱、等待／完成事件、token／成本欄位與 CLI 原生顯示的對照。
- 同一真實帳號與啟動 profile 的綁定、CLI 結束通知、VS Code session registry 與 UI 整合。
- macOS／Windows 真實互動 terminal；CI 只驗證 Node 模型與合成 evidence。
- Codex adapter 屬 #19，應重用本文件的共用核心。
