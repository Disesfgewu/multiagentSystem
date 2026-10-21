# 自訂 CLI provider（Issue #59）

在**使用者設定** `multiagentSystem.providers.custom` 列出自己的 CLI（`id`、`label`、`executable`、可選的 `args`），再用「Multiagent: Show Custom Providers」檢查、「Multiagent: Start Custom Provider Terminal」啟動。

## 規則
- **只讀使用者層級**：工作區、資料夾、語言層級的設定值一律忽略（只回報「有被忽略」）；設定項本身也宣告 `scope: application`。
- **能力全是 unknown，只有終端啟動**：不假設任何身份、用量、規則注入、續接能力；不建立 session 紀錄。
- **程式名稱 → 絕對路徑**：只看絕對的 PATH 項目；工作區資料夾與目前資料夾內的 PATH 項目、或解析後（跟隨連結）落在其中的程式一律不使用——**兩邊都用「原樣」與 `realpath` 兩種拼法比對**（工作區可能經由連結、macOS 的 `/tmp`、Windows 短檔名打開）。Windows 只接受 `.exe`／`.com`。
- **首次啟動確認**：顯示解析後的完整路徑、引數、資料夾與「未驗證」說明；確認綁定 provider id＋解析後路徑＋引數，任何一項變了就重新問。未信任的工作區在詢問前就拒絕。
- 啟動時，GitHub 憑證變數（`GH_*`／`GITHUB_*` 含 token／key 等、askpass、`SSH_AUTH_SOCK`、注入的 git 設定）從 terminal 環境移除。

## 已知邊界
- 確認**不包含檔案內容**：同一路徑的程式之後被換掉不會再次詢問。
- 環境清除只移除已知的憑證變數；其他變數仍會傳給程式。
- 沒有受管隔離：這只是「用你列的程式開一個原生 terminal」，不擋網路、不擋檔案（受管隔離見 `ISOLATION_CAPABILITY.md`）。
- 真的 CLI、Windows 實際 `.exe` 啟動、各 shell 設定下 `shellPath` 的行為：未驗證（#135）。

## 與受管隔離的關係

自訂 provider 還沒有受管隔離（沒有沙箱、沒有代理、沒有為它探測）。因此只要使用者設定 `multiagentSystem.isolation.mode` 是 `enforced`（或不是 `advisory` 的其他值），「Start Custom Provider Terminal」**不會啟動**並說明原因，不會退回無隔離的啟動；改回 `advisory`（預設）才能啟動。
