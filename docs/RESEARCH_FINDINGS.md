# 研究發現的資料結構

對應 #61 的第 1 項。`src/research/finding.js` 是純模組：不連網、不執行任何東西。它規定研究人員的每一筆發現長什麼樣子，以及哪些事它**不能**宣稱。

## 先講限制

- **不保證新穎、不確認最新。** 程式只能要求可查證的來源、日期與比較對象，並把「是否新穎」寫成結構化、由人檢查的判斷。查不到、日期不明、來源無法驗證的項目一律是 `unknown`。
- 各 CLI 能否搜尋、能否使用 MCP，在官方文件與實機驗證前都是 `unknown`（見 [Provider 登錄](PROVIDERS.md)）。本模組不假設任何 CLI 或 MCP server 的行為。

## 來源只能由工具回傳的紀錄填入

`fromToolRecord(raw, { serverId, toolName, retrievedAt })` 把工具回傳的紀錄轉成受信任的來源描述：server id、工具名稱、紀錄識別碼（DOI、arXiv 編號或其他）、發表日期、取得時間、來源類型（同儕審查／預印本／官方文件／部落格／其他）、版本與撤稿資訊。這些值由執行工具的程式提供，模型不能提供。`createFinding` 只接受這樣產生的紀錄；若輸入帶有 `source`、`url`、`doi`、`publishedAt`、`serverId` 等來源欄位，一律拒絕（`source-field-supplied-by-model`）。紀錄缺識別碼或日期時仍可建立，但標為未知，不會被猜測補上。

## 模型負責的欄位

`claim`（主張）、`comparison`（對照專案哪份文件或 Issue，以及比較結果）、`novelty`（`new`／`partly-new`／`known`／`unknown` 加理由）、`confidence`、`quote`（限長；必須是紀錄標題或摘要中實際存在的文字，記錄其 SHA-256，不得整篇複製）。文字會移除控制、雙向與零寬字元並限長。

## 新穎性的有效值

模型要求的判斷會保留在 `novelty.requested`，但 `novelty.effective` 只有在下列全部成立時才採用，否則為 `unknown` 並在 `blockedBy` 列出原因：

1. 來源有識別碼與發表日期；
2. 來源已由注入的查證步驟確認（`withVerification`：識別碼存在、標題與日期相符；有引用片段時還要確認片段存在）；
3. 有提供與專案文件的比較；
4. 沒有撤稿。

查證失敗（`failed`）一定是未知；沒有答案保持 `unverified`。信心程度在未查證前上限為 `medium`。預印本、撤稿狀態未知、版本未知都會產生 `warnings`。

## 不可信資料

每個發現都標為 `trust: 'untrusted-data'`。交給其他身份組時用 `wrapUntrusted`：每筆以 JSON 引用，`<`、`>`、`&` 以跳脫表示，欄位內容無法結束區塊、無法自成一行指令，也不複製摘要。它只是引用資料，**不得放進指令（instructions）或規則（forbid／require）層**；這個放置規則由後續 PR（#61 第 4 項）的注入端負責。

## 尚未包含

身份組範本與權限（第 2 項）、對外查詢掃描（第 3 項）、研究域與跨域分享（第 4 項）、真實查證 fetcher（第 5 項）、MCP 允許清單（第 6 項）、候選 server 評估（第 7 項）。本 PR 只用合成資料，沒有任何真實論文來源、MCP server 或網路。
