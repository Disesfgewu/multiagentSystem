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
  reader,                         // snapshot + publication methods below
  writer,                         // mergePullRequest({ repository, number, expectedHeadSha, commitTitle, commitMessage })
  repository: { owner, name },
  pullNumber,
  role: 'pm',
  actorId, authorId, pmLogin,     // 由可信 broker 建立，不接受 worker 自稱
  policyConfig: { pmActorId, mergeAuthority: 'pm' },
  scanOptions: { memories, rules, knownValues } // optional extra private references for detection
});
```

協調器在寫入前強制刷新完整 snapshot，再呼叫同一個可信 reader 的：

```js
reader.getPullRequestPublication(number, expectedHeadSha, { forceRefresh: true })
// { kind: 'ok', data: { complete: true, number, headSha, diff } }
```

這是給 #24 reader／broker 實作的 fail-closed 介面，本切片沒有 GitHub transport。結果必須明確表示完整，且 PR number 與 head SHA 都和剛讀到的 snapshot 相同；部分、過期、格式不明或讀取失敗一律回 `publication-unverified`。協調器不接受 caller 自由傳入的 publication units，以免乾淨的替代文字掩蓋實際 PR 內容。

掃描單位由協調器自己組成：最新 snapshot 的 PR title、PR body，以及綁定該 head 的完整 unified diff。三者以既有 `scanPublication` 檢查後，才把同一個 head SHA 當成 `expectedHeadSha` 交給 writer。writer 必須在 GitHub 端原子核對該 SHA，並以 `commitTitle`、`commitMessage`（即已掃描的 PR 標題與內文）作為 merge commit 文字，不得讓 GitHub 在 merge 當下改用目前的標題與內文。

掃描若沒有收到任何私人素材（`memories`、`rules`、`knownValues` 皆空或缺漏），結果的 `privateReference` 為 `none-supplied`；此時協調器回 `private-reference-unchecked`，除非呼叫端明確傳入 `privateReferencesChecked: true`，表示它已比對過私人素材且確實沒有可提供的內容。衝突、拒絕、例外或格式不明的 writer 結果都不會自動重試；網路例外回 `merge-outcome-unknown`，避免把可能已成功的 merge 再送一次。

結果只帶固定原因碼，不回傳 reader／writer 的錯誤文字。內容掃描結果也只暴露狀態與固定原因，不帶被掃描的文字。呼叫端可提供額外的私人記憶／規則／已知值供掃描器檢查；預設偵測器不能被呼叫端替換，未知掃描選項會被忽略。

## 本切片未完成與未驗證

- writer、`getPullRequestPublication` 的真實 GitHub diff 讀取與最小權限 broker 屬 #24；本模組沒有 GitHub transport，也不能阻止直接 `git`、`gh` 或 HTTP 旁路。
- 純函式 `assessMerge` 只判斷 GitHub review／CI／rules 證據，單獨呼叫不代表 merged code 已通過內容掃描；只有協調器在取得完整且同 head 的 publication evidence 後才會執行掃描與 writer。
- 目前 PM 與 worker 共用同一個 GitHub actor，所以真實正式 approval 不成立；同 login 會被拒絕。不同 actor 的正式 review 循環尚未實機驗證。
- main 目前沒有可供端對端驗證的 branch protection。核心會拒絕讀不到、部分讀取及不支援的規則，但真實 ruleset／classic protection 尚未驗證。
- merge 後關閉已驗收 Issue、刪除遠端分支與完整 request changes → 修正 → approval → merge 流程仍待 #16、#24、#4 的整合。
- macOS 與 Windows 只有 Node CI 的合成資料測試，不代表兩平台的真實 GitHub 寫入與權限已通過。
