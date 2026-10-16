# 公開 PM 報告留言格式（v1）

Issue 或 PR 的一般留言不會被當成 PM 報告。若 PM 要在報告工作台顯示結構化摘要，請由倉庫擁有者帳號發布一則公開留言：第一行必須是 `MULTIAGENT_PM_REPORT_V1`，第二行起是單一 JSON 物件，包含且僅包含以下八個非空字串欄位。

```text
MULTIAGENT_PM_REPORT_V1
{"operableResult":"使用者可完成的操作","solution":"採取的解法","alternatives":"考慮的替代方案","acceptanceGap":"尚未符合的驗收條件","risks":"已知風險","recommendedAction":"建議的下一步","evidenceTime":"2026-10-16T00:00:00Z","evidenceVersion":"PR 的完整 head SHA 或 Issue 的 updatedAt"}
```

`evidenceVersion` 對 PR 必須等於目前完整 head SHA，對 Issue 必須等於讀取到的 `updatedAt`。版本不合時報告顯示過期。留言讀取失敗或最新一則有標記的報告格式損壞時顯示未知，不沿用較舊報告；沒有帶標記的留言時顯示待 PM 補。倉庫擁有者帳號不等同獨立驗證的 PM 身份，畫面會據實標示來源。

此留言是公開資料。發布前必須經 #23 發布掃描；本機回饋只存於 PrivateStore，不寫入此留言或 GitHub。此切片不執行 GitHub 寫入、審核或合併。
