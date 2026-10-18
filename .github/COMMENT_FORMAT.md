# Issue／PR 留言格式

所有 PM、worker 與人類共用，讓留言能快速掃讀、少重複。

## PR 審查結論（第一行固定）
- `結論：Pass｜head <sha7>｜CI 全綠（N 項）`
- `結論：Needs changes｜<一行阻擋原因>`

接著依序：證據（測試數字、mutation 結果、範圍核對）→ 不擋合併的後續 → 給 worker 的下一步（Pass：直接做下一個 ready／mvp 項目；Needs changes：要修的具體項目）。Pass 只對該 head 有效，有新 commit 就失效。

## Issue 進度留言
- 開頭標明身分與動作：`PM：…`、`Worker：認領…`、`Worker：已送出 PR #N…`。
- 寫具體證據：檔案路徑、測試檔、測試數字、PR 編號、head SHA；不要只寫「已完成」。
- 狀態用固定詞：`程式完成待外部資源`、`rebase only`、`not planned`。

## 認領
- 動工前在 issue 留言 `Worker：認領 <切片>，分支 <branch>`。依專案進度追蹤 issue（#90）的領取規則，認領後 12 小時內沒有分支或 PR 視為釋放。

## 關閉
- 只有每條驗收都有程式與測試證據、且不依賴實機等外部資源才關閉；關閉前留言附證據。範圍被上層決定取消時用 `not planned` 並說明原因。
