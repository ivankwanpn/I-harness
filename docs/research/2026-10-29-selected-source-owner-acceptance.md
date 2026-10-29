# 固定來源與增量讀取持有者：主線驗收

MAIN `3a5b2f7dbb52261a969e6ccf0c42b469c34bf78b` 已整合受審的 retained binding、managed 固定來源見證、project getter/stamp 和 result observation。合併保留原始 process-read 變更追蹤：同一份真實 managed 文件追加內容時，固定來源撤銷，而健康的 process 觀察可消費原始已安裝增量；驗證後的追加仍拒絕。

來源持有者支援閒置自動撤銷、活躍使用排空、原始鎖／pin 的清理重試與依賴順序。setup 和每次 use 的 ALS 分別到期，保留原始 getter A 和 observation A/A，不讓逃逸回呼重新建立來源。Recovery hold 的整合遺漏已修正：狀態建立後同步通知固定來源，兩個 hold 只撤銷一次，原 hold 清除也不會復活舊見證。

Project 接合需要早期 HOST 的原始觀察 helper。只加入已裁定的 project-scope 機制，保留 MAIN `hasLiveOwnership` 行為；沒有合入整個舊 F1 提交、metadata reader、selected journal/B2 或生產 host 切換。

Root 在固定主線重新串行執行：persistence **155**、JSONL **36**、executor **16**、gateway **58**，共 **265 項通過、無跳過**，四套型別檢查全部 exit 0。八份來源清單前後不變且與當時 MAIN 原始檔案相同；48 個測試根目錄互不相同。這些是明列套件／測試及跨套件來源範圍，不宣稱完整第三方依賴閉包。

證據在 `.superpowers/sdd/2026-10-29-selected-source-main/evidence/`，`qualification.json` 保存零當前雜湊差異與固定 HEAD；整合／修復獨立審查在 `2026-10-29-selected-source-current-integration` packet。已保留來源既有 EOF 空白提醒；未以格式變更重寫受審內容。

真正 native source constructor、metadata reader、operation-bound host/controller、B2 authority 和整個版本驗證仍是後續範圍。沒有宣稱這些持有者等於完整事件驅動或可發佈版本。
