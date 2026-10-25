# Multiagent 使用教學

這份教學依管理者驗收清單（#360）的 11 項分章。每一章說明要做什麼、從哪裡點、會看到什麼，以及常見的問題與原因。

**截圖來源**：截圖由端到端測試 `npm run test:e2e -- --update-guide` 自動產生，存放在 `docs/user-guide/images/`。畫面改了，就重新執行這個指令，不要手動更新截圖。測試只使用合成的 CLI 與資料，所以截圖裡沒有真實的帳號。

**目前狀態**：還在開發中的有帳號流程（#352）、GitHub 樣式的頁面（#353）等功能。只有已經做好、而且 e2e 測試走過的部分，才會附上步驟與截圖。還沒做好的項目會寫明，並附上負責的 issue。

## 5 分鐘入門

1. **打開側欄**：點左側活動列的 **Multiagent** 圖示（四個方塊）。側欄只有一個區塊：最上面是 **Open Workbench**，下面三行分別是 agent、需要你處理的事、帳號。點任何一行，都會打開工作台的對應分頁。

   ![Multiagent 側欄](user-guide/images/00-open-side-bar.png)

2. **打開工作台**：點 **Open Workbench**。工作台開在編輯區，有 7 個分頁：Agents、Work、Accounts、Broadcast、Ask、Knowledge、Setup。

   ![工作台](user-guide/images/00-open-workbench.png)

3. **新增帳號**：在 **Accounts** 分頁按 **Add Claude Code account**（Codex 則按 **Add Codex account**），輸入名稱後按 **Add and Sign In**。精靈會自動完成：
   - 建立這個帳號專用的資料夾。
   - 設定用量與 agent 狀態的回報。
   - 開啟登入用的終端機。

   在終端機登入後，按 **I have signed in — check now**（或直接關掉那個終端機），帳號列就會顯示 email、方案與「sign-in checked」（見第 1 章）。

4. **建立身份組**：在 **Agents** 分頁按 **Create role group…**：
   - 選範本，例如 Developer。
   - 選 Claude Code。
   - 輸入名稱。
   - 按 **Create Role Group**。

5. **啟動 agent**：在 **Agents** 分頁按 **Start agent…**：
   - 選 Claude Code、帳號與身份組。
   - 模型選「Use CLI default model」。
   - 依畫面確認。同一份指示只會問一次。

   每個 agent 都會在編輯區開一個終端機，工作台上也會多一張卡片（見第 11 章）。

## 1. 多帳號登入

**要做什麼**：登入多個 Claude Code（或 Codex）帳號，而且分得出是哪一個。

**從哪裡點**：工作台 → **Accounts** → **Add Claude Code account**。
1. 輸入名稱，例如「Work A」。
2. 跳出一個確認視窗，列出精靈接下來會做的事：
   - 在家目錄下建立 `multiagent-accounts/claude-work-a`。
   - 在這個資料夾自己的 `settings.json` 設定 status line（5h／7d 用量）與 hook bridge（每個 agent 在做什麼）。你自己的 Claude 設定不受影響。
   - 開啟登入用的終端機。
   - 登入後檢查一次。
3. 按 **Add and Sign In**，在開啟的終端機裡登入。
4. 按右下角的 **I have signed in — check now**，或直接關掉那個終端機。

另一個帳號照同樣步驟再做一次，例如「Work B」。

**會看到什麼**：每個帳號一列，寫成 `Work A · owner-a@example.test · Claude Code`，右邊是 **sign-in checked**；側欄寫 `Accounts: 2 accounts, 2 signed in`。兩個資料夾如果登入的是同一個真實帳號，會標示重複，並寫明怎麼修正。

![兩個帳號](user-guide/images/01-add-second-account.png)

**常見問題**：
- **精靈最後說「The sign-in could not be confirmed」**：終端機裡的登入還沒完成。完成後，按帳號列上的 **Check sign-in**。
- **用量寫「bridge on, no reading yet」**：還沒有 agent 在這個帳號上跑過；啟動一次就會出現（見第 2 章）。

## 2. 每個帳號的額度與訂閱

**要做什麼**：看每個帳號用了多少額度，以及是哪個方案。

**從哪裡點**：工作台 → **Accounts**。

**會看到什麼**：帳號列會列出：
- 方案，例如 `plan Max`。
- 用量，只寫用了多少、什麼時候重設：`5-hour: 32% used, resets in 2h`、`Weekly: 10% used, resets in 3d`。如果 Claude Code 有回報依模型的週額度，也會列出，例如 `Weekly (Opus): 5% used`。數字過期或不能用來擋啟動時，後面會加一兩個字，例如 `(out of date)`。
- 按帳號列下方的 **Details**，可以看到每個數字的讀取時間、可信度與來源，例如 `5-hour: verified and current · read 1m ago · from claude status line rate_limits`。

還沒有讀數的帳號，會寫明原因與下一步，不會只寫「unknown」。

![用量與方案](user-guide/images/02-see-usage.png)

**為什麼一開始沒有用量**：Claude Code 只有在有 session 執行時，才會透過 status line 回報用量。所以帳號第一次有 agent 跑起來之後，數字才會出現。

**帳號已經有自己的 status line**：Multiagent 不會默默換掉它。帳號列會寫 `another status line is set`，旁邊有 **Review the status line setting**。按下去會跳出確認視窗，列出目前的命令和要換成的命令；按 **Cancel** 就什麼都不改，右下角會寫 `Existing settings were not changed`。Add account 精靈遇到這種情況也一樣不覆蓋，只提醒你之後再設定。

![保留自己的 status line](user-guide/images/02-keep-own-status-line.png)

## 3. 每個 agent 用哪個帳號

**要做什麼**：決定每個 agent 用哪個帳號；Claude Code 和 Codex 都可以有好幾個帳號。

**加一個 Codex 帳號**：工作台 → **Accounts** → **Add Codex account**，步驟和第 1 章一樣（名稱、**Add and Sign In**、在終端機登入、**I have signed in — check now**）。Codex 會自己回報登入的是哪個帳號，帳號列寫成 `Codex A · codex-owner@example.test · Codex CLI`，還有方案，例如 `plan Plus`。

![Codex 帳號](user-guide/images/03-add-codex-account.png)

**給身份組一個預設帳號**：工作台 → **Agents** → **Edit role group…** → 選身份組 → **Set default account profile** → 選帳號。右下角會寫 `“E2E Developers” now has the default account “Work B”: Start agent lists it first, and you can still choose another.`

**啟動時改選**：**Start agent…** 選了身份組之後，帳號清單的第一個就是它的預設帳號，旁邊寫 `this role group's default account`。要用別的帳號，直接選別的就好。

![預設帳號排第一](user-guide/images/03-see-default-first.png)

**會看到什麼**：每張 agent 卡片都寫它用哪個帳號，例如用預設帳號啟動的這張寫 `Account: Work B (owner-b@example.test)`。

![用預設帳號啟動](user-guide/images/03-start-with-default.png)

**換帳號重新啟動**：卡片下方按 **Switch account…** → 選另一個帳號（清單裡不會有它現在用的帳號）。會跳出確認視窗 `Restart “E2E Agent 5” with the account “Work A”?`，說明它的終端機會關掉、agent 會停下，然後在同一個資料夾、用同樣的名稱、身份組和模型重新啟動。按 **Restart with This Account** 才會動作；按 **Cancel** 什麼都不變。重新啟動之後，工作台只剩一張它的卡片，寫著新的帳號；如果新的 session 在後面的確認視窗被取消，舊的卡片會留著，寫 **Terminal closed**，可以重新開啟。終端機已經關閉的卡片（例如重新載入視窗之後）也可以換帳號。換帳號後 agent 的代號不變（例如一直是 `Worker-05`），所以它在 GitHub 上的署名不會中途改變。

![換帳號前先確認](user-guide/images/03-confirm-switch.png)

![換帳號後：同一個代號，新的帳號](user-guide/images/03-switch-account.png)

## 4. 和 PM agent 一起 review reports

**要做什麼**：直接在 Issue 或 PR 頁面上做決定：Approve、Request changes、Merge、Delete branch、Close。也可以照第 8 章的方式，先請 PM agent 讀某一則留言並回覆。

**從哪裡點**：照第 8 章打開 Issue 或 PR 頁面，在 head 與檢查結果下方找到 **Decide**。

**會看到什麼**：
- PR 頁面有 **Approve**、**Request changes**、**Merge**、**Delete branch** 四個按鈕。
- Issue 頁面有 **Close as completed**、**Close as not planned** 兩個按鈕。
- 現在能做的按鈕是亮的。不能做的按鈕是停用的，旁邊寫著原因，例如：
  - `Merge authority is "Human only": merge it on GitHub yourself, or change it (command: Configure Merge Authority).`
  - `Only the branch of a merged pull request can be deleted.`
  - `Checks failed on this head.`
  - `There are unresolved review threads.`
  - `Trust this workspace first; until then this page only reads.`
- 原因來自原本文字報告用的同一組檢查：發佈帳號、合併權限、CI、未解決的討論、分支規則、這個 head 的 review。讀不到的項目會寫 `unknown`，按鈕維持停用。

![Decide：哪些能按、哪些不能、為什麼](user-guide/images/04-see-decisions.png)

**和 PM agent 一起看**：
- 前提：要有一個 PM 角色的 agent 在執行。用 Command Palette 執行 `Multiagent: Create Role Group`（還沒有任何身份組時，工作台 **Agents** 分頁也有 **Create role group…**），選 **PM** 範本建立身份組，再用 **Start agent…** 以這個身份組啟動一個 agent，它的代號會是 `PM-01` 這類名稱。
- 在任一則留言或 review 下按 **Discuss with PM**，確認視窗會問 `Ask the PM agent to read this post on PR #7 and reply there?`，按 **Send Now**。
- PM 的終端機只會收到一行編號，例如 `管理者請你閱讀 PR #7 的 review（ID 7101），並在 PR #7 回覆你的看法。`，不會收到 review 的內容。PM 讀完後會在 GitHub 回覆，回覆會出現在這個頁面上，標著 **New**。
- 你也可以在留言框寫好留言，按 **Comment and tell PM**（見第 8 章）。

![啟動 PM agent](user-guide/images/04-start-pm-agent.png)

![請 PM 看這則 review](user-guide/images/04-discuss-with-pm.png)

**Approve／Request changes**：
1. 在頁面最下方的留言框寫好 review 內容（留言框是空的話，會跳出輸入框問你）。
2. 按 **Approve** 或 **Request changes**。
3. 確認視窗會列出 repo、PR 編號、head 的 commit，以及整段 review 內容。按 **Submit formal review** 才會送出。

送出時，review 綁定這個頁面讀到的 head：如果在你讀完之後有人推了新的 commit，就會拒絕送出，什麼都不會發生，請按 **Refresh** 重新讀取。送出後頁面會自動重新讀取，新的 review 會出現在對話裡，標著 `管理者` 和 `review: approved`。

![Approve 之後](user-guide/images/04-approve-pr.png)

**Merge**：合併權限設成 PM 可以合併，而且這個 head 已經 approve、CI 通過、沒有未解決的討論時才會亮。按下後會跳出確認視窗，再檢查一次所有條件才會合併。合併後頁面會顯示 `merged`，**Delete branch** 變成可以按。

**Close**：在 Issue 頁面按 **Close as completed** 或 **Close as not planned**，確認視窗寫著關閉的方式，按 **Close Issue** 才會關閉。關閉後狀態變成 `closed (completed)`，兩個按鈕都停用，原因寫 `The Issue is already closed.`。

![關閉 Issue 之後](user-guide/images/04-close-issue.png)

**每個動作都要你按確認**：頁面本身不能直接寫到 GitHub。它只會把按了哪個按鈕告訴擴充套件，由擴充套件跳出自己的確認視窗、重新檢查，然後才送出；按取消就什麼都不做。頁面只能送出固定的動作名稱；review 的文字是你在留言框打的，會在確認視窗裡完整列出。

**常見問題**：按鈕旁寫 `No GitHub account is set to publish for this repository yet`。
- 原因：還沒有設定由哪個 GitHub 帳號替你發佈。
- 處理方式：發一次留言（第 8 章），或在 Command Palette 執行 **Configure PM Publisher**。

## 5. 直接問問題
尚未完成，見 #353、#357（Ask 分頁）。

## 6. 直接在 VS Code 上工作
**要做什麼**：讓從工作台啟動的 Claude Code agent 連到這個 VS Code 視窗，在 agent 的終端機輸入 `/ide` 時，它看得到你開的檔案，改動也會以 diff 顯示在這個視窗。

**前提**：這個 VS Code 視窗裝了並啟用 Claude Code 擴充套件。它會在 `~/.claude/ide/` 留下一個鎖檔，裡面寫著它的 port 和這個視窗開的資料夾。本擴充套件只讀 port、資料夾和程序編號（用來確認那個視窗還開著），不讀也不轉送裡面的 token。

**從哪裡點**：工作台 → **Agents** → **Start agent…**，和平常一樣啟動。

**會看到什麼**：卡片右上角有綠色的 **VS Code connected**；**Details** 裡寫著 `VS Code: connected through this window's Claude Code port (…)`。連不上時，卡片改成黃色的 **VS Code not connected**，Details 寫原因與下一步。

![agent 連到這個視窗](user-guide/images/06-start-connected-agent.png)

e2e 的環境沒有 Claude Code 擴充套件，所以鎖檔由 e2e 自己寫；在真機上輸入 `/ide` 並看到 diff 的部分列在 #135。

**常見問題**：卡片顯示 `VS Code: not connected (no VS Code window has registered with Claude Code …)`。
- 原因：VS Code 的 Claude Code 擴充套件沒有安裝或沒有啟用。
- 處理方式：安裝或啟用它，然後重新開啟這個 session。

## 7. 對同一個身份組廣播 prompt
尚未完成，見 #357（Broadcast 分頁）。

## 8. PR 與 Issue 像 GitHub 一樣呈現

**要做什麼**：在 VS Code 裡讀 Issue 和 PR，看起來像在 GitHub 上一樣。

**從哪裡點**：工作台 → **Work** → **Open Issue or pull request…** → 從清單選一個（清單列出這個專案所有開啟中的 Issue 和 PR）。也可以用 Command Palette 的 `Multiagent: Open Issue or Pull Request Page`。舊的 Issues／PRs 報告清單點下去，開的也是這個頁面。

**會看到什麼**：編輯區多一個分頁，例如 **Issue #12**。
- 最上面是標題、狀態（open、closed、merged、draft）、標籤、誰在什麼時候開的。
- 內文和每一則留言都會渲染 Markdown：標題、清單、勾選清單、粗體、程式碼、程式碼區塊、表格、引用、連結。
- 每則留言的標頭都有一個徽章，寫著是誰寫的：`管理者`、`PM-01（自稱）`、`Worker-01（自稱）` 或 `未署名`。`管理者` 只出現在你從 VS Code 發出、之後也沒有被改過的留言上；`（自稱）` 表示是 agent 自己在第一行署的名字，只是它的說法，不是證明（所有 agent 和你共用同一個 GitHub 帳號）。徽章在留言內容的外面，所以留言裡就算打了 HTML，假裝成「管理者」徽章或 **Approve** 按鈕，也只會照原樣顯示成文字。

![Issue 頁面](user-guide/images/08-open-issue-page.png)

PR 頁面還會顯示：
- head 的 commit 與分支，以及用白話寫的檢查結果與 review 狀態，例如 `Checks: checks passed · Review: changes requested`。
- review 和留言依時間排在一起。
- **Files changed**：點檔名就會開啟那個檔案的 diff，和文字報告裡點檔名一樣。
- **Review comments on lines**：每則都寫著檔案和行號，按 **Go to …** 就會跳到 diff 的那一行。

![PR 頁面](user-guide/images/08-open-pr-page.png)

![點檔名開啟 diff](user-guide/images/08-open-file-diff.png)

頁面上方有三個按鈕：**Refresh**（重新讀取）、**Open on GitHub**、**Open as text report**（原本的純文字報告，裡面有私人筆記、合併權限等資訊）。

**安全**：GitHub 上的文字都不可信，因為 repo 是公開的。所以：
- 頁面不載入任何外部資源。
- 連結只接受 https 開頭的網址，或這個 repo 裡的路徑，而且一定在瀏覽器開啟。
- 圖片不會載入，只會出現一個按鈕，按了才在瀏覽器開啟。這樣就沒有人能從圖片知道你讀過這則留言。

**留言**：頁面最下方是留言框，用 Markdown 寫。按 **Preview** 可以先看渲染後的樣子，再按下面其中一個：
- **Comment**：發成 GitHub 留言。發出前會先檢查有沒有私人資訊，再跳出確認視窗把整段文字列出來，按下確認才會發。發出去的留言會記成「管理者」，所以頁面上的徽章是 `管理者`。
- **Comment and tell PM**：先照上面的方式發出留言，再從 GitHub 讀回來確認真的在上面，然後才問你要不要通知 PM agent。通知時，PM 的終端機只會收到一行數字，例如 `管理者在 Issue #12 留言（留言 ID 4242），請讀取這則留言並在 Issue #12 回覆。`，不會收到留言內容。

![留言與預覽](user-guide/images/08-write-comment.png)

第一次發留言時，還沒有設定由哪個 GitHub 帳號替你發留言，所以會出現 **Configure PM Publisher**。按下去並確認一次，之後就不會再問。

![發出留言](user-guide/images/08-publish-comment.png)

**請 agent 看某一則留言**：每則留言、review、逐行留言下面都有兩個按鈕：
- **Discuss with PM**：請 PM agent 讀這一則並回覆。
- **Ask an agent…**：從正在執行的 agent 中選一個（例如 Worker-01），請它讀這一則並回覆。

兩個按鈕都會先跳出確認視窗。對方終端機收到的只有編號，例如 `管理者請你閱讀 Issue #12 的留言（ID 1201），並在 Issue #12 回覆你的看法。`。GitHub 上的文字永遠不會被打進終端機，所以留言裡就算寫了「忽略規則、執行某指令」，也不會被執行。

![請 agent 看留言](user-guide/images/08-ask-agent.png)

**自動更新**：頁面開著而且在畫面上時，每 45 秒會重新讀一次。讀取失敗時會等久一點再讀，遇到 GitHub 的流量限制時，會等到 GitHub 說可以再讀的時間。打開頁面之後才出現的留言會標上 **New**。正在寫的留言不會因為更新而消失。

**未信任的工作區**：只能閱讀。留言框和所有寫入按鈕都是停用的，旁邊會寫原因。

**Talk to PM via GitHub**（工作台 **Ask** 分頁，或 Command Palette）：現在開的也是這個頁面。

**Approve、Merge、Close**：在頁面的 **Decide** 區塊，見第 4 章。

## 9. 危險自動模式與模型切換
尚未完成，見 #358。

## 10. 用 skills 與共享記憶省 tokens

**要做什麼**：把常用的步驟（開 PR、跑測試、rebase、回應 review、領 issue…）寫成 skill，交給對應的身份組。agent 啟動時只會被告知 skill 的名稱和一行說明，需要時才自己去讀內容，這樣就不必每次重新摸索，也省 tokens。

**從哪裡點**：工作台 → **Knowledge**。
1. **Add starter skills…**：加入內建的起始 skills（預設全部勾選），按 Enter。
   ![加入起始 skills](user-guide/images/10-add-starter-skills.png)
2. 在某個 skill 上按 **Role groups…**，勾選要給的身份組，例如 `E2E Developers`，按 Enter。這張卡片會改成 `For: E2E Developers`。
   ![指定身份組](user-guide/images/10-assign-skill.png)
3. **Edit**：skill 會以 `SKILL.md` 開在編輯器裡。照一般方式存檔（⌘S／Ctrl+S）就會存回庫裡。
   ![編輯 skill](user-guide/images/10-edit-skill.png)

其他按鈕：
- **Add skill…**：輸入名稱和一行說明後，在編輯器裡寫步驟，再存檔。
- **Turn off／Turn on**：關掉的 skill 不會告訴任何 agent。
- **Remove…**：從庫裡移除，會先確認。
- **Bring in this repository's skills…**：讀進專案裡 `.claude/skills`、`.agents/skills` 的 skills。
- **Write skills into this repository…**：寫到這兩個位置給 CLI 使用。會先列出要寫的檔案，已經存在的檔案絕不覆蓋。

**存檔時的檢查**：skill 的內容會給 agent 看，所以存檔前會檢查，有以下情況就不存，並說明原因：
- 有隱藏字元或控制字元。
- 有「忽略你的規則」這類字眼。
- 有本擴充套件自己的訊息標記。
- 有看起來像密鑰、email 或家目錄路徑的內容。

agent 提出的 skill 只會成為「suggested by an agent」，你按 **Approve…** 之後才會生效。

**agent 啟動時拿到什麼**：身份組的 agent 啟動時，指示裡只有一段 **Skills**，列出這個身份組可用的 skill。每個 skill 一行，寫著名稱、什麼時候用，以及檔案位置。skill 的內容不會放進指示裡；agent 覺得用得上時，才去讀那個檔案。
- skill 檔案寫在這個 agent 自己的私人資料夾，**不會寫進專案**，所以不會被誤 commit。
- Claude Code 啟動時會帶 `--add-dir <那個 skills 資料夾>`，只開放這一個資料夾，讓它讀檔時不必再問。Codex 直接讀檔案路徑。agy 和其他指示一樣，要手動貼上。
- **Claude Code 是看清單、需要時才自己讀檔**，不是用它原生的 skill 自動載入機制（PM 決定，見 #359）。省 tokens 的方式相同：只有清單會佔用每次啟動的指示。
- 關掉的 skill、別的身份組的 skill、還沒核准的 agent 建議，都不會出現在清單裡。
- 確認啟動之後，如果 skill 在 agent 真正啟動前被改過、被加入或被關掉，這次啟動會被判定為過期，請重新確認，避免 agent 拿到你沒看過的清單。

**看得到給了多少**：在 agent 卡片按 **Details**，會看到一行 `Given at start: 7 rules, 0 shared notes and 1 skill (their names, not their text) — about 650 tokens (an estimate). The CLI is told about them; that does not prove it read them.`

token 數是估算（中日韓文字每字算 1、其他每 4 個字元算 1），只顯示實際給了多少，不推算「省了多少」。

![agent 拿到 skill 清單](user-guide/images/10-start-agent-with-skills.png)

**比較兩次 session**：
1. 用 Command Palette 執行 `Multiagent: Compare Two Sessions' Token Usage`。
2. 選帳號，或 **All accounts**。
3. 依序選兩個 session。清單只列出用量紀錄裡有讀數的 session，每一個都寫著啟動時給了多少，例如 `given about 334 tokens at start, 1 skill`。
4. 編輯區會開一份唯讀文件，左右並排兩個 session：
   - 啟動時給了多少（估算的 tokens，以及 rules／notes／skills 各幾個）；
   - 最近一次回報的用量：input／output／cache tokens、費用；
   - 兩者都有數字時寫出差多少，一樣時寫 `same`，任一邊沒有回報就寫 `—`。

這份文件只列實際的數字，不推算「省了多少」。要知道省了多少，需要在實機上用同一個任務跑兩次 session 來比較（#135）。Claude Code 只回報費用（list price 的估算，標成 ESTIMATE），不回報累計的 token 數，所以 token 那幾行是 `—`。

![比較兩次 session](user-guide/images/10-compare-sessions.png)

**共享記憶的上限**：每個 agent 啟動時，只拿到自己身份組、自己隱私範圍內、已採納的共享記憶，依相關度排序，最多 2,000 字。超出的記憶不會丟掉：指示裡只列出每則的標題（第一句，最多 80 字），全文寫在 skills 同一個資料夾的 `_left-out-notes.md`，agent 需要時自己去讀。這些記憶也算在你要確認的內容裡，改了任何一則都要重新確認。

卡片的 **Details** 會寫出有幾則沒放進去，例如 `Given at start: 7 rules, 1 shared note and 1 skill … 1 more shared note did not fit the size limit (listed by title only).`。要讓身份組使用共享記憶：**Edit role group…** → **Set memory scope** → **Role group**。新增記憶：Command Palette 執行 `Multiagent: Add Shared Memory Note`。

![超過上限的記憶](user-guide/images/10-memory-past-limit.png)

**還沒驗證的部分**：真實的 CLI 是否真的會在需要時讀 skill，以及實際省了多少 tokens（比較兩個做相同工作的 session 的用量紀錄），列在 #135 的實機項目。

## 11. 一個畫面看到所有 agent

**要做什麼**：在一個畫面看到所有正在這個專案工作的 agent。

**從哪裡點**：
- 側欄的 **Open Workbench**，或側欄的 **Agents: … running** 那一行，都會打開工作台的 **Agents** 分頁。
- 也可以從 Command Palette 執行 `Multiagent: Open Workbench`。

**會看到什麼**：
- **Agents (數量)**：每個 agent 一張卡片，用白話寫成：
  - 第一行：代號（例如 Worker-01）、名稱與身份組；右上角是狀態。如果有需要注意的事，會多一個黃色的小標，例如「VS Code not connected」。
  - 下面四行：
    - CLI 與模型，例如 `Claude Code · CLI default`。
    - `Account: Work A (owner-a@example.test)`：email 是這個視窗最近一次登入檢查讀到的，只存在記憶體裡。
    - `Mode: Auto`。
    - `Doing: …`：正在處理的 Issue 或 PR。
  - **Details**：點開才看得到。每件事只寫一次、用白話，依序是：
    - 模型：要求的是哪個、CLI 回報實際用的是哪個；
    - 權限模式：CLI 回報的模式，還沒回報時寫要求的模式；
    - VS Code 連線、資料夾信任；
    - 啟動時給了什麼；
    - 工作資料夾（Git）、狀態從哪裡來；
    - 分支、CI、費用等只有這裡才有的資訊；
    - 報告與額度。

    卡片上已經寫過的帳號、身份組、狀態，不會在這裡重複。需要注意的行會以黃色顯示。
  - 主要按鈕：**Focus terminal**。
- 左邊是 PM 與待決定的事項。
- agent 的終端機只會顯示一行「Multiagent: starting Claude Code (Worker-01)」，不會顯示一長串啟動指令。

下圖是 e2e 用合成的 CLI 啟動 4 個 agent 之後的畫面，一個畫面就放得下 4 張卡片：

![4 個 agent 的卡片](user-guide/images/11-see-four-cards.png)

**常見問題**：
- **卡片有黃色小標「VS Code not connected」**：點開 Details 可以看到原因，通常是這個視窗裡沒有 VS Code 的 Claude Code 擴充套件（見第 6 章）。
- **卡片寫 `state unknown`**：agent 還沒回報狀態，畫面不會猜測。
- **側欄寫 `Needs you: 1 account`**：打開 Accounts 分頁，看那個帳號寫了什麼，例如額度橋接還沒設定。

## 12. 工單看板：每張 Issue 在哪個階段

**要做什麼**：一個畫面看出每張工單（Issue）在哪個階段、誰在做、PR 的 head 與 CI、PM 最後的結論，以及停在這個階段多久。

**從哪裡點**：工作台 → **Work**。第一次打開這個分頁時會讀一次；之後按 **Refresh board** 重新讀。

**會看到什麼**：六欄，每欄寫著張數：
- **待辦 Backlog**：沒有 `ready` 標籤，也沒有 agent 或 PR。
- **可領取 Ready**：有 `ready` 標籤，還沒有人做。
- **進行中 In progress**：有 agent 在做，或 PR 還是草稿。
- **待審查 Waiting for review**：有 PR，而且 PM 還沒對目前的 head 下結論；或結論是 Pass，等你合併（卡片寫 `waiting for merge`）。
- **需修改 Needs changes**：PM 最後的結論是 Needs changes。之後推了新的 head 也一樣，直到 PM 下新的結論。
- **已合併 Merged**：最近兩週合併的 PR，以及它關閉的 Issue。

每張卡片寫著：
- 負責的 agent 代號，沒有就寫 `no agent`；
- PR 編號、head 前 7 碼、CI；
- PM 的結論：誰寫的（`管理者`，或 `PM-01（自稱）`，和頁面上的徽章一樣）、針對哪個 head；
- 在這一欄停了多久。

讀不到的寫 `unknown`。按卡片標題會打開那張 Issue 的頁面（第 8 章）；**Open PR** 打開 PR 頁面；有 agent 時，**Focus terminal** 會切到它的終端機。

![工單看板](user-guide/images/12-see-board.png)

![從看板打開 Issue](user-guide/images/12-open-from-board.png)

**哪些結論算數**：只有 repo 擁有者的帳號、而且是你自己從 VS Code 發的（`管理者`），或第一行署名 PM（例如 `— PM-01`）的留言或 review，才會被當成結論。任何人都能在留言裡打「結論：Pass」，所以其他帳號、worker 或沒有署名的留言都不會讓卡片換欄。

**和 GitHub 比少點幾次**：
- 在 GitHub 上，要知道 N 張工單各自的階段、誰在做、CI 和 PM 結論，每張大約要點 4 到 5 次：Issues 列表 → Issue → 連結的 PR → Checks → 往下找最後一則 PM 結論。總共約 4N 到 5N 次。
- 在看板上，打開工作台、按 **Work**，共 2 次。

**限制**：
- 看板最多顯示 30 張卡片，優先順序是：需修改、待審查、進行中、可領取、待辦、已合併。沒列出的會寫出還有幾張。
- 遇到 GitHub 的流量限制時，看板會說明原因，以及什麼時候可以再讀。
- 未信任的工作區不會讀取（偵測 repo 需要在工作區裡執行 Git）。
- 「已驗收」（已發佈並走查通過）這一欄還沒有做。
- 看板只讀取，不會寫入 GitHub。

## 限制

e2e 測試證明的是「畫面與流程」。以下項目仍需要管理者在實機確認（#135）：
- 真實帳號的登入。
- 真實的 CLI 是否照指示執行。
- 原生 Windows 上的行為。
