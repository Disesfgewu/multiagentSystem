# PR 交付與 merge 判定核心

對應 Issue #17 的第一個切片。這一版只有純判定與注入式協調器，沒有 GitHub writer、Issue 關閉、分支刪除或 UI 整合。

`src/delivery/merge.js` 接受 `github-read-adapter` 的 PR snapshot。`assessMerge` 不讀網路、不持有憑證，也不寫入；它只在以下證據全部完整時回傳 `merge-ready`：

- snapshot 完整且兩次 PR head 讀取一致，PR 開放、非 draft 且可合併；
- 正式 `APPROVED` review 來自設定的 PM GitHub login，並綁定目前 head SHA；COMMENTED、自我核准與舊 head approval 都不算；
- 至少有一個 CI check／status，全部與必要 checks 均通過且屬目前 head；沒有 CI 也會拒絕；
- review threads 可完整讀取、屬目前 head 且沒有未解決對話；
- branch rules／classic protection 可完整讀取，且沒有目前 adapter 無法證明的規則；
- `src/publish-policy.js` 對可信 broker 提供的穩定 actor ID 授權此次 merge。

人工 merge 是預設。`mergeAuthority: 'human'` 時 PM 呼叫會得到 `human-merge-required`；只有明確設定 `pm` 才可能通過。worker 呼叫會由共用 publish policy 回傳 `role-forbidden`。

## 協調器介面

```js
const result = await mergePullRequest({
  reader,                         // getPullRequestSnapshot(number, { forceRefresh: true })
  writer,                         // mergePullRequest({ repository, number, expectedHeadSha })
  repository: { owner, name },
  pullNumber,
  role: 'pm',
  actorId, authorId, pmLogin,     // 由可信 broker 建立，不接受 worker 自稱
  policyConfig: { pmActorId, mergeAuthority: 'pm' },
  publication,                   // src/publish/scan.js 的 units
  scanOptions
});
```

協調器在寫入前強制刷新完整 snapshot，使用既有 `scanPublication` 檢查即將發布的內容，最後把 snapshot 的 head SHA 當成 `expectedHeadSha` 交給 writer。writer 必須在 GitHub 端原子核對該 SHA。衝突、拒絕、例外或格式不明的 writer 結果都不會自動重試；網路例外回 `merge-outcome-unknown`，避免把可能已成功的 merge 再送一次。

結果只帶固定原因碼，不回傳 reader／writer 的錯誤文字。內容掃描結果也只暴露狀態與固定原因，不帶被掃描的文字。

## 本切片未完成與未驗證

- writer 與最小權限 broker 屬 #24；本模組沒有 GitHub 寫入能力，也不能阻止直接 `git`、`gh` 或 HTTP 旁路。
- 目前 PM 與 worker 共用同一個 GitHub actor，所以真實正式 approval 不成立；同 login 會被拒絕。不同 actor 的正式 review 循環尚未實機驗證。
- main 目前沒有可供端對端驗證的 branch protection。核心會拒絕讀不到、部分讀取及不支援的規則，但真實 ruleset／classic protection 尚未驗證。
- merge 後關閉已驗收 Issue、刪除遠端分支與完整 request changes → 修正 → approval → merge 流程仍待 #16、#24、#4 的整合。
- macOS 與 Windows 只有 Node CI 的合成資料測試，不代表兩平台的真實 GitHub 寫入與權限已通過。
