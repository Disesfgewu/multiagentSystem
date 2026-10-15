# 共享記憶 A/B 評測框架

回答「共享記憶是否真的降低總成本且不降低品質」。這一版只有可重現的框架與固定的合成評測；**沒有任何真實帳號或 CLI 的量測，因此不得宣稱記憶降低 token**。

## 兩組

- `off`：只注入規則。
- `on`：注入規則與依任務選出的記憶（`MemoryStore.select`，含隱私域與預算規則）。

執行：`node scripts/memory-eval.js`（可加 `--usage <檔案>` 讀入已記錄的、由 provider 回報的用量 JSON）。結果固定格式、可重跑；固定的合成記憶、任務與檢查在 `src/memory/eval-suite.js`，內容皆為虛構，不取自任何真實專案、session 或帳號。

## 量到什麼

- **注入大小**（精確）：每個任務兩組的字元數、選入的記憶數、記憶字元數、因預算而省略的項目數與字元數、來自其他隱私域（明確授權）的來源。字元數**不會**被換算成 token。
- **品質**（機器可判定，無主觀評分）：`context-includes`（注入內容含某規則文字）、`context-excludes`（例如不含其他隱私域的內容，即洩漏檢查）、`output-includes`／`output-excludes`（針對呼叫端記錄的輸出）。沒有記錄輸出的檢查為 `not-run`，不算通過。
- **用量**：每筆為 `{ arm, taskId, field, value, source, method?, billing? }`。`source` 只能是 `provider-reported`（以 provider 回報為準）或 `estimated`（必須說明 `method`）。缺項標「未知」而不是 0；估算與回報分開記，不混加；訂閱（`subscription`）與 API（`api`）計費分開彙總，不相加；記憶建立與檢索成本（`memory_build_tokens`、`memory_retrieval_tokens`）算進記憶組。

## 何時才能說「節省」

`assessSavingsClaim` 只有在下列全部成立時回 `supported`，否則列出原因：

1. 量測是真的（`real: true`，由呼叫端對真實 CLI 的量測負責）；
2. 至少 10 個任務；
3. 單一已知的計費模式，兩組每個任務都有 provider 回報的輸入與輸出 token（含記憶建立與檢索成本）；
4. 記憶組總 token 低於對照組；
5. 品質沒有退步（通過率不低於對照組且失敗數不增加，且兩組都有實際執行的檢查）。

限制：token 總和不是成本——快取 token 計價不同，訂閱與 API 也不同；通過這些條件只代表「在這份樣本上總 token 較低且品質未退步」。樣本大小、任務選擇與重複次數仍須在報告中說明，且不能由單次 prompt 縮短量推論總節省。

## 未驗證

沒有真實帳號與 CLI 的結果，一律是未驗證；agy 沒有已驗證的用量來源，用量一律未知。
