# 受管 session 的模型要求

從帳號／身份組啟動 Claude Code 或 Codex CLI 時，先選「Use CLI default model」或「Request a model」，後者可輸入供應商模型 ID／alias。預設選項不增加模型旗標；明確要求則以 `--model` 傳入新 terminal 的啟動命令。取消選擇不啟動 session。agy 尚未核實模型旗標，因此不提供模型要求。

模型 ID 只能使用 1–128 個英數字、點、底線、冒號、斜線或連字號，且以英數字開頭；含空白、shell 語法或旗標前綴的值拒絕。較特殊的 alias 語法尚未支援。擴充套件不下載模型、不查模型價格／帳號存取清單，也不改正在執行中的 CLI。

總覽 tooltip 將「Requested model」與「Actual model: unknown」分開。要求值不證明 CLI 已啟動、使用該模型或帳號可存取；真實 CLI 回報的模型來源尚未接入。重開同視窗中的 session 會保留原要求；底層 snapshot 能保存要求，但擴充套件的跨視窗 session 持久接線仍由 #11 追蹤。

官方參數於 2026-10-17 核對：[Codex CLI reference](https://learn.chatgpt.com/docs/cli/reference)、[Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)。實際安裝版本、真帳號可用性與 macOS／原生 Windows 人工操作仍待驗收。
