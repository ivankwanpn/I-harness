# R4A A3 驗收與 Codex 修整 — 2026-10-20

**結論：接受本輪 A3 文字輸出切換、已修正的邊界及實際驗證過的路徑。整個 R4A 尚未完成，不能合併或發佈。** 原外部交付不能直接接受；Codex 已重現問題、修正產品並完成限定範圍的獨立複審。完整套件仍有下列明列的失敗，沒有宣稱整套全綠。

## 範圍與分工

| 項目 | 固定點 |
| --- | --- |
| 工作目錄／分支 | `D:/I-harness-main`／`codex/v0.1.13-development` |
| 本批 A3 起點 | `4730ca83f5f3e97a1ab5a4bf8d8d2b5131987456` |
| 外部 A3 產品／交付 | `954f6c87`／`0cf2d24f4f723745a27d0b5d33ec18698b0296ba` |
| Codex 修正 | `583bc11fff2905778b0c983f1887a75de61d380c` |
| Codex 增量 | 27 個產品／測試檔，+560／−66 |
| 完整 A3 產品／測試範圍 | 35 檔，+1148／−327 |
| Desktop／Session format／拆分 | `0.1.13-rc.1`／10／27/43，均未改 |
| 獨立審查 | specification PASS、quality PASS，限定本輪修正與已驗證路徑 |

本輪由 Codex root 單獨修改產品，原 GPT6.1Sol reviewer 唯讀審查。審查代理的最終工具回合因用量限制報錯，但完整審查報告已保存；2026-10-20 已重新讀取全文並核對 commit、來源與證據。沒有用工具失敗通知代替審查結論，也沒有重新派發代理冒稱原審查已完成。原[外部交付報告](2026-10-19-context-r4a-a3-delivery.md)保持不變；本次[獨立複審全文](context-r4a-a3-review-20261020/independent-review.md)與[最初審查](context-r4a-a3-review-20261020/initial-review.md)分開保存。

使用者在 2026-10-20 決定後續回到 **Codex 主導，委派實作與審查使用 GPT 6.1 Sol**。這覆蓋先前 DeepSeek 初步實作的分工；已完成成果不重做，一次一名產品 writer，實作與獨立審查分開。

## 已修正的實際問題

1. **完整原文先進歷史、再另存 artifact。** 外部實作在保存前已提交完整 `code/output.content`，即使 artifact 被 quota 拒絕仍留下巨大原文。現在每段已接受文字沿原來源先完成保存，再發布一份有界 envelope；單段觀察重用原 ref，多段觀察使用 `code-text-index-v1`，只記原 ref 與媒體位置，不再拼接另存完整文字。
2. **取消讓已發出的保存永久失去恢復能力。** 原 scope 綁定觀察者 abort signal；checkpoint cancellation／Stop 後同一 operation 也無法完成。現在在 await `beginResult` 前記錄已發出狀態，已接受工作沿原 source／capture 被動結算；初始化回執未知不再誤判成「從未發出」。
3. **新事件驗證沒有接上真正入口。** 新 envelope 的互斥檢查已連接實際 intake 與 JSONL decode；legacy `content` 仍可讀，新 envelope 與 raw content 不能同時出現。實際 append／冷讀控制涵蓋前版、現版、未來版與衝突資料。
4. **恢復後仍被長壽命暫停來源卡住。** 已接受輸出由實際 cell action 登記有限生命週期的保存來源；原保存、F1 事實與 callback 完成後，只釋放自己的 hold。掛載本身仍可使用，沒有新增通用 reset。
5. **多段索引未知時仍可接受新工作。** 真正的 retained ToolExec outcome 在 registry finalization 尚不存在時，便由原工具來源維持 hold；不能依賴尚未建立的 finalization handle。
6. **Stop／close 可能先發布 terminated，再發布原輸出。** 終止 metadata 在進佇列時已嚴格驗證並固定，但只有輪到原 FIFO 位置才建立 F1 capture；避免 source pre-drain 搶先發出尚未輪到的終止事實。驗證順序為 `started → code/output → terminated`，也驗證外部後續修改 metadata 不影響原 stop 記錄。
7. **第一段保存未知時，第二段已接受輸出失去恢復記錄。** 同一 cell 已接受的文字與媒體佇列共用仍有效的原保存來源，不能在 hold 下重新申請權限。實際 Worker 消息控制確認兩段進入原 host listener 後才回報第一次 finish 未知；恢復後兩份輸出皆在，guest／內部工具各一次，第一份內容沒有重寫。
8. **文字 bytes 不等於最終 JSON bytes。** NUL 反例原本產生 99,178-byte 普通模型輸出。新 `observation-output.ts` 以最終跳脫 JSON 的 64,000-byte 預算縮短預覽；完整資料仍在原 artifact。70,000 字元的合法圖片名稱保留在 typed image，不再重複塞入普通 metadata 導致成功 guest 被誤報失敗。

Gateway、搜尋預覽與現有 renderer 已識別新表示；舊資料仍走原讀取分支。媒體維持既有 typed 限制與順序。本輪沒有修改協議 adapter、提高 guest transfer 上限、重播工具或新增第二套日誌／調度器。新增責任葉檔 `output-facts.ts`、`observation-output.ts` 分別負責發布與模型 DTO；原 `runtime/output.ts` 為 374 行，原拆分清單沒有因此提前加分。

## 驗證與來源範圍

測試依序執行，來源在每個 run 前後固定；下列範圍互有重疊，不能相加為獨立總覆蓋率。

| 驗證 | 結果與限制 |
| --- | --- |
| 最終 Code Mode 套件 | **95 passed／1 failed**；失敗為 retained completed-cell 測試的 `Active cell limit exceeded` |
| 最終 executor 相關範圍 | **39 passed／5 failed**；保留 1 個 legacy shell `contextRef` 期望與 4 個 legacy search／Stop 期望失敗 |
| 實際主代理恢復控制 | **8 passed**：begin、finish、index、已接受 backlog、checkpoint cancellation／Stop、跳脫與合法媒體 metadata |
| 最終 Gateway-copy libraries | **30 tests／5 files passed**，涵蓋真實 WASM／store／角色限制／source／schema 路徑 |
| 最終 executor 型別檢查 | exit 0 |
| 最終 Gateway／CLI build 與 CLI `verify-dist` | 全部 exit 0；CLI 保留既有 dynamic-import warnings |
| 較早的固定來源驗證 | core-session 418、core-tools 136、retained-agent 5、subagent Code Mode 7、renderer 6、Gateway 冷投影 1，全部通過；另六個型別範圍通過。這些 receipts 在後續 FIFO／cohort 修正之前，保留其來源時點，不冒充整套最終版本重跑 |
| 最終 reachability | exit 1；399 rows，仍為交接 WIP 已記錄的 6 個 unused-export，沒有新增豁免、reseed 或假 consumer |

最終套件失敗名稱與外部 A3 candidate 已保存日誌一致，並非本次才第一次看到；但外部證據沒有獨立 `4730ca83` baseline，因此不能據此宣稱整個 A3 無回歸或失敗頻率不變。原始失敗、修正中的失敗和通過記錄均保留。

**實際大型輸出控制：** 真正 WASM guest 經 assembly 產生 1 MiB 文字，原 F1 輸出保持有界，保存後由新 service 冷讀，核對完整內容、encodedBytes 與 digest。這不是純假 transport，也不是 100 MiB session 驗證。真正受限角色的 child assembly 另確認只見角色工具，child 輸出仍由其自身權限讀取，parent 不能憑 ref 讀取。

**後續任務與冷恢復控制：** 原 child／team 三回合測試的一秒快照輪詢會撞上正在寫入的 F1 保護。保留四次失敗後，測試改等真正的 `turn/end` 事件，仍在第二回合 receipt callback 精確關閉 owner，關閉完成後才冷讀；第三回合及保存狀態檢查保留，原 15 秒全測試期限未增加，最終通過。此修正是測試觀察時序，不是放寬產品讀取保護。

## 證據核對與封存

最終維護來源 digest 為 `48a8a627ca0bb87d852820c48639f85fdd9dcd91d9d94e497f267d655ee7a192`，共 **2,583 inputs**。最終 receipts 的 HEAD 是 `0cf2d24f`，因修正當時尚未 commit；記錄 bytes 與現在的 `583bc11f` 一致。獨立 reviewer 核對 root 27 檔與完整 A3 35 檔，均零差異；root 收束時再核對全部維護來源。

- 新 evidence：`.tmp/context-r4a-a3-codex-20261019/`，**57 份 receipts、312 個封存檔案**；stdout／stderr、前後來源、控制檔、執行時間及原始失敗皆經核對，0 mismatches。
- Evidence inventory digest：`458f3bf2e070748f25d8821a45e81e9f6ef462910431dd5ca66cc7b7214ad9da`。
- Gateway copy：`.tmp/context-r4a-a3-gateway-20261019-b/`；**845 個來源檔一致、280 個內部依賴在副本內解析**。
- 複製測試只以 AST 改寫 7 個測試／helper 中的 38 個 import，產品副本沒有修改。第一次 setup 因 desktop-gateway 為 bundled entry 而非 node_modules 套件失敗，保留原結果；第二份獨立 QA 目錄通過。Gateway 冷投影另由來源測試驗證，不冒充 Gateway IPC 入口測試。
- CLI：`.tmp/context-r4a-a3-cli-20261019-b/ih.mjs`，6,755,585 bytes；SHA256 `5b8f10f464dbb50b572e91c43d0edd6a7c5954c4ba36a9ade397373397e219b9`。
- 外部交付的 31 個封存檔與 7 份 receipts 也經核對。4,594 manifest rows 中 2,409 對應 root 最初維護來源記錄，另 2,185 是額外未追蹤檔案；沒有把這個總數說成維護程式檔數。外部封存集合缺少隔離 baseline 與另外八個宣稱的型別範圍 receipts，缺失不當成通過。

可攜摘要：[verification-summary.json](context-r4a-a3-review-20261020/verification-summary.json)。封裝副本的 library controls 與 CLI smoke 不等於所有 packaged real-entry、Electron UI 或線上協議測試。

## 尚未完成與下一批

- **A4**：MCP `structuredContent`／`isError`、其餘 media／search／export／readers、版本與跨 owner catalog 授權的完整切換。
- **A5／A6**：其餘 crash、Stop、ACL、刪除並行、literal9/8→10 實際 owned 路徑，以及最終來源的 100 MiB／100-child、Gateway／CLI 完整入口與 renderer build 資格。
- **原來源綁定的範圍切換**：目前 `sourceFor(sessionId)` 在 emission/capture 時讀取；cell admission 到第一次輸出之間若實際專案 scope 改變，其行為尚未由真 Desktop 路徑證明。reviewer 沒有確認一個可重現的失敗，這是明列的未驗證項，不冒稱已修正或另立確定缺陷。
- **R4B／R4C、R5、R6**：語意繼承、可靠交付、觀測/UI 及大型歷史／冷恢復仍待完成。完整事件驅動、指令檔支援與無關拆分未因本輪恢復或提前完成；27/43 維持。

本輪僅本地提交，沒有 push、merge、tag、release。下一步按[進度總表](../refactoring/context-engine-progress.md)與[分批框架](../superpowers/plans/2026-10-19-context-engine-external-execution.md)推進 A4，沿用新授權的 Codex 主導／GPT6.1Sol 子代理流程。
