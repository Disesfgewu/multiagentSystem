# GitHub 讀取 adapter

對應 Issue #15：以**唯讀**方式讀取 GitHub Issue、PR、head SHA、review、CI checks、對話與 branch rules，供專案總覽使用。這個套件獨立於 VS Code Extension：HTTP transport 與 token 由呼叫端注入，之後由 #8 的 Extension Host 接上。

沒有第三方相依（不使用 Octokit），不需要安裝步驟。`npm test`（Node ≥ 20）使用合成資料與假 transport，不連網、不需要 token、不寫入 GitHub。

## 邊界

- 只讀：REST 一律 `GET`；唯一的 `POST` 是固定常數的 GraphQL **query**（review thread 是否已解決只在 GraphQL 提供），用戶端會拒絕 mutation／subscription。
- 不讀本機私人內容：不讀環境變數、檔案、家目錄、`gh`／CLI 登入、SecretStorage。token 只透過注入的 `getToken()` 取得，只放在 `Authorization` 標頭，不進入結果、錯誤、快取鍵（只用雜湊指紋隔離不同憑證）。`test/boundary.test.js` 會掃描原始碼防止回歸。
- 沒有磁碟快取；快取只在記憶體中。
- 帶 token 的請求只會送往設定的 API origin：跨 origin 的重新導向或分頁連結一律拒絕。

## 使用

```js
const { createGitHubReadAdapter, createFetchTransport, isSuccess } = require('@multiagent/github-read-adapter');

const adapter = createGitHubReadAdapter({
  transport: createFetchTransport(fetch),   // 可換成任何 async ({method,url,headers,body,signal}) => {status,headers,body}
  getToken: async () => tokenFromSecretStorage, // 由 Extension 提供；可省略（匿名，僅公開 repo）
  // apiBaseUrl: 'https://ghe.example.com/api/v3'  // GitHub Enterprise；必須 https
});

const reader = adapter.useRepository({ owner: 'example-org', name: 'example-repo' });
const snapshot = await reader.getPullRequestSnapshot(7, { signal });
```

`reader` 方法：`getRepository`、`getIssue`、`listIssues`、`getPullRequest`、`listPullRequests`、`getReviews`、`getIssueComments`、`getReviewComments`、`getChecks(sha)`、`getReviewThreads`、`getBranchRules`、`getBranchProtection`、`getBranchRequirements`、`getPullRequestSnapshot`，以及 `reader.links.*`（導向正確 GitHub 頁面的 URL）。每個方法都接受 `{ signal, forceRefresh, maxAgeMs }`。輸入不合法（非正整數、非完整 SHA、不合法的 repo 名稱）會同步丟出 `TypeError`；遠端狀況一律以結果物件回報，不丟例外。

## 結果種類

每次讀取回傳帶 `kind` 的物件；呼叫端必須分支處理，不可把失敗當成空清單。

| kind | 意義 |
| --- | --- |
| `ok` | 完整讀到資料（`data`、`fetchedAt`、`source: network｜cache｜revalidated`）。 |
| `empty` | 伺服器**確認**沒有項目（例如 200 加 `[]`）。 |
| `partial` | 部分獨立來源讀不到（`unavailable` 列出哪些）。資料只是下限，不能當完整結論。 |
| `truncated` | 達到頁數上限；已讀部分在 `partialData`、頁數在 `pagesFetched`。合併多個來源的讀取（checks、branch requirements）若全部截斷也維持此 kind，並以 `components` 列出各來源狀態。 |
| `not_found` | 404／410。GitHub 對無權限查看的資源也回 404，因此帶 `possiblyHidden`。 |
| `denied` | 401／403（`reason`：`bad_credentials`、`forbidden`、`sso_required`…）。 |
| `rate_limited` | 主要或次要限流，含 `resetAt`／`retryAfterMs`；不自動重試。 |
| `transient` | 5xx、逾時等，已用完重試次數（指數退避，可注入 `sleep`）。 |
| `offline` | 連不到伺服器。 |
| `cancelled` | 呼叫端取消，或切換了 repo（`reason: aborted｜repository_changed`）。 |
| `invalid` | 回應無法解讀（壞 JSON、缺必要欄位、不安全的連結）。 |

失敗結果可能帶 `lastKnown`（記憶體快取的舊資料與其讀取時間），僅供顯示「離線，上次同步於…」，不是有效證據。分頁中途失敗時，已讀部分只放在 `partialData`，不會變成 `ok`。

## 新 head 使舊 approval 失效

`assessApprovals({ reviews, headSha, prAuthor, requiredApprovals })` 是純函式：每位 reviewer 只看最新的 APPROVED／CHANGES_REQUESTED／DISMISSED；**只有審查的 commit 等於目前 head 才算有效**，其餘列入 `staleApprovals`（不管 repo 是否開啟「推送後撤銷核准」）；作者自己的核准不算；被撤銷（DISMISSED）的不會讓更早的核准復活；CHANGES_REQUESTED 不論 commit 都持續阻擋。

`getPullRequestSnapshot` 在讀完 reviews／checks／threads／規則後會強制重讀 PR（條件請求）。若 head 在讀取期間改變，`consistent` 為 `false`，核准以最新 head 判定，舊 head 的 checks 標為 `unknown`。review 讀不到時 `approval.status` 是 `unknown`，不是「沒有核准」。

結果是 review **證據**；branch rules 是否要求、reviewer 權限是否讓核准生效，仍以 GitHub 為準（`reviewDecision` 也一併回傳供對照）。

## 快取、分頁與 repo 切換

- 記憶體快取依「憑證指紋＋完整 URL」分區，預設 30 秒，過期後以 ETag 條件請求重驗證（304 只更新 `fetchedAt`）。多頁清單**不**用第一頁 ETag 重驗證，因為新 review／留言出現在最後一頁。
- 分頁沿 `Link: rel="next"`，每頁 100 筆，預設上限 20 頁，依 id 去重。
- `adapter.useRepository(repo)` 切到不同 repo 時，會中止前一個 repo 所有進行中的請求並使舊 reader 失效；即使 transport 不理會 abort，遲到的回應也會被丟棄並回報 `cancelled/repository_changed`。repo 名稱不分大小寫。

## 尚未完成／未驗證

- **Extension 整合**（等 #8 合併）：提供 `fetch`、從 SecretStorage 取 token、總覽 UI。這裡的測試**全部使用合成資料與假 transport，不能視為對真實 GitHub 的整合驗收**。
- 尚未對真實 GitHub 或 GitHub Enterprise 驗證：branch 名稱含 `/` 的路徑編碼、`rules/branches` 與 `branches/{branch}/protection` 在不同權限下的實際回應、GraphQL 欄位、各種 token 類型（fine-grained／GitHub App）所需權限。
- Windows 只由 CI 驗證，未在實機驗證。
- 不推導「Ready to merge」：這裡只提供證據與摘要；合併條件判定與 broker 屬後續 Issue。
- 不處理 GitHub 帳號之間的身分區分（PM／worker 是否為不同主體）：這是 P0 的 GitHub 身分驗證項目。
