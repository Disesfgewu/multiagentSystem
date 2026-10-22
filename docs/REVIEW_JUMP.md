# 從報告跳到程式碼（Issue #308，第一部分）

PR 報告裡：

- 「CHANGED FILES AND DIFF」下的每個檔名可以點開（原本就有）。
- **新增**：「INLINE REVIEW DISCUSSION」下每則行內審查留言的 `路徑:行號` 可以點開，跳到那一行。

## 點開之後看到什麼

0. **優先**：如果這台電腦的 Git 裡有這個 PR 的 head commit 和 base 分支（`refs/remotes/origin/<base>`，不會去抓取），就開 VS Code 自己的**並排 diff**：左邊是 PR 分出去時（base 與 head 的 merge-base）的檔案，右邊是 head 的檔案，游標在該行；新增的檔案左邊是空的、刪除的右邊是空的。檔案是二進位或超過 1 MB、head 不在本機、base 分支不認得、路徑不是儲存庫內的普通路徑，都不用這個。
1. 如果某個 working folder（`git worktree list` 列出的，包含 agent 的）**目前停在這個 PR 的 head 這個 commit、而且沒有未提交的修改**，就開啟那個資料夾裡的真實檔案，游標在該行，並說明「這是 agent 工作資料夾的版本」；可以按 **Show the patch instead** 改看 patch。
2. 否則開啟 GitHub 回傳的 patch（PR head 對 base），游標在該行。該行不在 patch 顯示的範圍（沒被改到、也不在上下文裡）時，patch 開在最上面並明說。

## 安全與限制

- 只有「這份報告自己列出的檔案」才能被開；留言裡的路徑不在報告的檔案清單時不會變成連結。
- 工作資料夾必須是 **完全相同的 head**（不是同名分支）；有未提交修改的資料夾不使用，因為檔案內容可能不是 PR 的內容。
- 路徑必須是儲存庫內的相對路徑（沒有 `..`、絕對路徑、反斜線）；檔案是符號連結、或解析後跑出工作資料夾外，一律不開，改開 patch。
- 行號必須是 1 到 10,000,000 的整數，其他值被拒絕。
- 這是唯讀的跳轉：不改任何檔案、不寫 GitHub。

## 其他

#308 的 Discuss with PM Agent 與 Start Meeting 見 `docs/DISCUSS_WITH_PM.md`、`docs/MEETING.md`。
