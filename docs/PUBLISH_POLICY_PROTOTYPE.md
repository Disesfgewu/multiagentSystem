# P0 發布政策原型

`src/publish-policy.js` 提供無網路、無憑證的政策判斷函式。執行 `node --test test/publish-policy.test.js` 可驗證角色限制、預設人工 merge、舊版本 review／CI 與未知狀態的處理。

| 動作 | 可執行角色 |
| --- | --- |
| 定義或修改 Issue | 指定 PM |
| 領取 Issue、建立 PR | 與 PM 身份不同的 worker |
| Review PR | 指定 PM，且不是該 PR 作者 |
| Merge PR | 指定 PM，且專案明確設定為 `pm` |

身份使用 GitHub 穩定 actor ID，不使用 CLI 帳號或本機角色標籤。政策輸入必須由可信 broker 從登入結果、私人角色設定及 GitHub 狀態建立，不能直接接受 worker 自稱的角色或合併條件。

PM merge 需要開放且非 draft 的 PR、可合併狀態、對最新 head 的指定 PM approval、同一 head 的必要檢查通過、沒有阻擋 review 或未解決對話，以及 GitHub branch rules 已滿足。缺少任一欄位會拒絕。預設 `human` 模式不授權 broker 代為 merge。

此函式尚未接上 GitHub adapter／broker，也沒有內容掃描、Issue 領取鎖或 OS 隔離。它不能阻止 CLI 直接執行 `git`、`gh` 或 HTTP 寫入，不能宣稱已保證防外洩。未來 broker 須重新核對最新狀態，並在 GitHub merge API 帶入預期 head SHA，避免檢查後 head 改變的競態。

P0 待驗收項目：不同 GitHub actor 的正式 review 循環、branch rules 的可信狀態取得、雙客戶端領取衝突，以及 macOS／原生 Windows 的憑證與網路旁路隔離。自動化政策測試通過不代表這些實機情境通過。
