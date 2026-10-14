# multiagentSystem

以支援 macOS 與 Windows 的 VS Code 擴充套件管理同一個 GitHub 專案中的多個 CLI coding agents。每個 agent 使用可直接操作的真實終端機；使用者可在同一畫面查看工作、程式碼、角色、帳戶及可取得的用量資訊。

產品將支援 PM 與 worker 等自訂身份組、依身份共享的精選記憶，以及以 GitHub Issues／PRs 為主的任務與 review 流程：PM 定義 issue，coding agent 領取任務並提交 PR，PM review 通過後由人工或依設定由 PM merge。使用者可為同一 CLI provider 登入多個帳號，指定各 agent 使用的帳號並查看可取得的各帳號額度。執行階段 agent 資訊不得進入 GitHub 提交與協作內容。

目前仍在規劃階段。需求、技術選型、開源參考、風險、里程碑與驗收標準見 [實作計劃書](docs/IMPLEMENTATION_PLAN.md)。
