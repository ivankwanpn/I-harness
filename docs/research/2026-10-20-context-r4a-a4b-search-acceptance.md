# R4A A4b Task1 搜尋驗收 — 2026-10-20

**接受本輪搜尋投影及索引升級，包含 fix1 的子代理修正。** 初版未直接通過；原獨立審查的 Important finding 已由同一 reviewer 確認解決，修正沒有新增 actionable finding。Codex root 完成來源、副本與證據核對後，接續 Task2 的 CLI／Desktop 消費者工作。

## 範圍

| 項目 | 固定點 |
| --- | --- |
| 工作目錄／分支 | `D:/I-harness-main`／`codex/v0.1.13-development` |
| Task1 BASE | `4b0f949c4aa0e44b9061686cdc357dcb39f2218e` |
| 初版行為／coverage 文案 | `d2b624ed`／`8f93fc02` |
| 修正產品 | `42bbaebce6ec0b14ef410511b869cfd4f4043d2c` |
| 修正交付 HEAD | `541cd06335db0195b44d76b77de86c1337ca046a` |
| 全部產品／測試差異 | 9 檔，+358／−10；既有搜尋 owner 內完成，沒有新結果 store |
| 版本／原拆分 | 產品0.1.13-rc.1、Session10、27/43，未改；只有可重建搜尋索引的版本1→2 |

實作與審查均為 GPT6.1Sol；一名產品 writer，另一名獨立 reviewer，root 負責規劃修正與最終接受。完整記錄：[初版交付及更正](2026-10-20-context-r4a-a4b-search-delivery.md)、[fix1 交付](2026-10-20-context-r4a-a4b-search-fix1-delivery.md)、[首次審查](context-r4a-a4b-search-review-20261020/initial-review.md)、[原 reviewer 複審](context-r4a-a4b-search-review-20261020/fix1-review.md)。

## 行為與修正

普通工具、nested Code Mode 工具及 emitted output 的新結果，現在索引已保存的 inline value 或有界 preview。原始任意資料欄位不因名稱像 `images`／`error`／`ref` 而被移除；獨立 typed media、保存參照及 dependency metadata 不進搜尋文字，也不自動讀取完整 artifact body。歷史 raw 分支維持原行為。模型看得到的 `session_search` 說明亦明確交代這個覆蓋範圍。

現有索引可能在新結果尚未支援時已把它們存成空文字；單改 normalizer 無法打破相同來源 revision／fingerprint 的 skip。現在由原 application-id／transaction owner 將 owned derived schema1 升為2並重建。原 JSONL 不變，foreign／future3 SQLite 檔案不被重置，第二次未變動查詢仍走正常 skip。

**初版計劃有一處過度統一，已公開更正。** 真正的子代理 TaskResultOwner 刻意清空 descriptor preview；`subagent/end.resultText` 與 `error` 才是同一新格式中、總計受2048-byte限制的預覽。Root 在驗收時追查實際 producer，發現初版 READ-02 會令這些結果的搜尋變空。修正後新 child completion 索引兩個 present string，以換行連接；不改 producer、不重複保存預覽、不讀完整 body。沒有 envelope 的歷史分支保持原 first-present 語義。

原測試的三個 child RED 使用了錯誤 expected oracle，不能算成真正產品缺陷證據；原始日誌及數字保留，交付文件已明確更正。新的四個反例經真正 TaskRegistry→TaskResultOwner→capture/store→managed F1→file-backed FTS 重現並修通，包含 completed/error × artifact/quota。它不是完整 spawn/model 執行的資格證明。

## 驗證

| 最終 fix1 範圍 | 結果 |
| --- | --- |
| Core 搜尋／結果／JSON owner | 37 tests／4 files 通過 |
| 完整 session-query 套件 | 62 tests／7 files 通過 |
| Retained-child owner 控制 | 15 tests／4 files 通過 |
| 受影響 core-session／session-query／subagent 型別 | 全部 exit0 |
| 新 Gateway build | exit0，242 packages；保留原 optional-platform 訊息 |
| 最終 copied runtime | 37 tests／5 files 通過，含真正 task producer 及冷讀權威／完整值控制 |

測試範圍有重疊，不相加成總覆蓋率。初版 CLI／Gateway types 等結果保留其原來源時點，沒有冒稱修正後重新執行。

Root 獨立驗證 fix1 的13個循序且來源穩定的 receipts、2,665個來源輸入、923個來源／manifest副本、280條副本內依賴、5個 QA fixture／21個 import 轉換及77個封存證據檔，零不一致。[fix1 核對](context-r4a-a4b-search-review-20261020/fix1-root-verification.json)與[初版核對](context-r4a-a4b-search-review-20261020/initial-root-verification.json)分開保留；初版來源一致不能抵銷其程式／測試契約缺陷。

最後 source-manifest SHA256：`3c00b6391f2e6e7a8407efc49d84786637d32817fcfb78148abaef04001c7ec3`。Fix1 inventory digest：`9e7399e16fe0affdada883b5bb7628106708ef30d2f8603e0d635649bf3bb142`。複審報告 SHA256：`b3a6b76b7528404a826ab1208e3f28d8df9b23a17659da8c17b4e9a0b2d3a15c`。

完整 raw 證據仍在本機 `.tmp/context-r4a-a4b-search-20261020-implementation/` 與 `.tmp/context-r4a-a4b-search-fix1-20261020-implementation/`。原17個 receipts／兩份副本／seal 未被覆寫。保存副本測試驗證 library/query/task-owner，並非 Gateway IPC、Electron、CLI transcript 或線上供應商驗證。

## 接續

Task2 的 CLI／Desktop 顯示與 history/export qualification 接著執行；明確 artifact-page reader、owned version qualification、A5/A6、R4B/C/R5/R6 仍未完成。既有全工作區失敗與六項 reachability unused-export 沒有由這一批宣告解決。使用者要求連續工作，這是內部驗收檢查點，不是等待使用者再批准的停止點。沒有 push、merge、tag 或 release。
