# S0a Task Documents 觀察與確認：主線驗收

MAIN `fe98032502740d945337059fefa8ad1605479df7` 已整合原始 Documents operation owner、JSONL 原工廠接線和純 task v1/v2 validator。此範圍是 **S0a 讀取／確認／生命週期**，不包含 S0b 寫入確認、Session14、task-v3 或新的 child launch。

實際路徑先取得真實 READY parent pin 和原生 task document lease，再觀察原始 bytes、以純 validator 驗證並確認同一個 witness。所有有限工作由原紀錄持有；失敗開始、取消、父會話撤銷和關閉都保留具體原資源與清理錯誤。檔案清理成功後才釋放文件 lease，該 lease 成功後才釋放 parent pin。重複 close 保留同次結果，明確 retry 才恢復原剩餘清理。

原始 queue 在 admission 前拒絕同 owner／parent 的 task self-call，包括跨另一 session 的祖先情況和已逃逸回呼。Signal 原始方法、可能已安裝的 listener 及 falsey install/remove 失敗也納入同一 failed-begin 所有權。實際 native lease-release 失敗測試證明 parent pin 保留，成功檔案關閉不重做，明確 retry 能收尾；確認 ack 與清理 debt 分別保留。

Root 在固定 MAIN 串行驗證 persistence **104**、JSONL **52**、純 subagent adapter **1**，共 **157 項通過、無跳過**，三套型別檢查均 exit 0。前兩包涵蓋實際 composed factory、ordinary/bootstrap READY parent、精確 bytes、absence/tombstone、self-call、暫停 acquisition、原始確認與 shutdown；adapter 不 restore registry、不遷移文件。

收據在 `.superpowers/sdd/2026-10-29-task-documents-main/evidence/`；受審來源及因果失敗在 `2026-10-29-task-documents-next` packet，最終獨立複核為 `task-a-repair-review-20261029.md`。先前 mixed EOL 已以實際原始 bytes 與 Git 正規化內容逐檔核對，沒有用重新跑舊測試改寫歷史。

下一個單元是同一操作內的 immutable staged write、具體 ack 和原 TaskPersistence save 的接合；一般 void write 或 caught flush 仍不能當作新寫入的確認。版本保持0.1.13-rc.1／Session13，沒有發佈、推送或格式啟用。
