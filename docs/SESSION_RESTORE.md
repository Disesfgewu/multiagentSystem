# 工作區 session 恢復

受管 session 的固定設定現在會保存至擴充套件既有私人儲存的 `sessions` collection。重新載入同一工作區時，總覽／Sessions 恢復名稱、provider、身份組、帳號、工作目錄與模型要求；不自動開 terminal、續接 CLI、重新登入或把舊 session 顯示為活躍。所有恢復項目的狀態都是 unknown，重開仍走既有確認與帳號檢查。

snapshot 不保存 terminal 綁定 token、環境變數、憑證、用量觀測或 runtime state，不寫入專案。工作區範圍包含 workspace URI 與依序排列的 folder URIs；不同工作區分開保存。工作區變更或空視窗開啟資料夾後，需重新載入以綁定新範圍，舊視窗不會改存到新範圍。

同一視窗的保存依序執行。兩個視窗開啟同一工作區時，第一個成功保存後，較舊的 writer 會因 revision 衝突停止保存並警告；不會覆蓋另一視窗的新記錄。儲存不可用、內容損壞或寫入失敗時亦停止保存，當前 sessions 仍可留在記憶體使用。重新載入前請先處理正在執行的 terminal；無法從 snapshot 證明舊 terminal 是否仍存在。

單一 snapshot 受 PrivateStore 既有 64 KiB 記錄大小限制，最多驗證 256 筆。超限時拒絕保存，不刪減歷史或覆寫既有記錄。歷史清理介面尚未交付。

驗證範圍：私人儲存與 manager round-trip、並行寫入、跨視窗衝突、工作區變更、損壞保護，以及 Extension Host 命令實際保存。真實視窗重開、舊 terminal 的 VS Code 持久化行為與原生 Windows 人工操作仍待驗收；本切片不代表 #11 全部完成。
