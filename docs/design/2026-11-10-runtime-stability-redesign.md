# Runtime 與持久化穩定性調整

## 基準與交付

本分支為 `codex/runtime-stability-redesign`，起點為 `f885bec895d7d54de8e56f7633bd87615ea6b469`。調整涵蓋本輪審查發現的持久化、會話狀態、SDK、導航及打包問題，並驗證正常產品入口。

### 目前整體進度

目前本報告記錄 125 項具體問題與 S1 至 S7 的結構調整。Team 執行功能已移除，Code Mode 保留獨立 package 與 QuickJS／Worker 架構。第 102 至 114 項的已確認根因均已提交對應修正並完成定向驗證，實機使用 DeepSeek Flash 的 Code 執行、背景等待、草稿清除及冷重啟亦已通過，後續真實父子任務及其關閉、冷讀取也已驗證。測試品質修訂前三批完成 65 項控制，第四批冷讀取 fixture 及其依賴回歸完成 119 項。後續確認第 118 項閒置清理恢復缺口，修正後 251 項相關控制及五個 package 型別通過。整體工程完成度估計約 80%，剩餘工作包含完整回歸失敗、效能問題、最終問題狀態及交付核對。各輪控制的範圍有重疊，完整穩定性驗收仍未完成。

測試修訂第五批已提交為 `9ce120ac`。九個發布故障點分開執行並斷言實際注入次數，索引案例核對原生 SQLite 修復及 canonical 內容，三檔合計 76 項通過。只調整實測超過原有預設的個別案例期限。後續 legacy 功能檔案的 19 處原五秒測試宣告依量測給予 20 秒，10,001 筆案例獨立成檔並保留原五分鐘期限，完整案例內容及原生退休計數斷言保持原樣。[76 項驗證](C:/Users/IvanKwan/AppData/Local/Temp/ih-bootstrap-index-receipt.json)

測試修訂第六批完成三個完整檔案，部分回應重試 23 項、審批關閉 11 項及原生 Task 崩潰／冷恢復 15 項，分批合計 49 項通過，零略過，Executor 型別通過。沿用真正 constructor 的注入入口、Task transition coordinator 及 CLI／SDK 原始 child host。崩潰 cut 依原生 committed ACK 與原始 Task 文件取證，核對 producer PID、實體 journal 與保留內容。Task v3 保存的完成結果可冷讀，缺少 parent terminal 的情況仍斷言沒有 receipt、admission 或重跑 child。審批政策失效的首次 close 核對原始 CONTEXT_INPUT_STALE，後續 close 與實際釋放次數均驗證。部分保存斷言核對實際持久化 prefix，保留至多一次工具結果及零 effect。原有案例與 IPC 期限維持原值。[49 項逐檔驗證](C:/Users/IvanKwan/AppData/Local/Temp/ih-executor-constructor-receipt.json)

第六批第一次診斷啟動時與尚未退出的型別檢查短暫重疊，後續正式數字取自獨立重跑。審批測試曾加入所有 close 都必須成功的過強假設，核對原始 host 的失效回報契約後，改為驗證一次明確診斷及後續原始清理完成。[正式完整 Task 檔案](C:/Users/IvanKwan/AppData/Local/Temp/ih-delivery-cold-final.json)

第 119 項撤銷槽部分寫入的恢復修正，完整功能檔案 47 項通過，一項 Windows 原生 file symlink 權限略過。相關八檔另有 181 項通過、兩項相同環境條件略過及兩項 funding 失敗，Context 型別通過。失敗的 d31 案例超過 120 秒後仍繼續執行，隨後 d1 的共享 I/O 觀察被污染，後續在原有 120 秒期限內獨立重跑，d31 於 113.890 秒通過，d1 於 12.568 秒通過，批次執行的期限與逾時後收尾仍需改善。[修正與完整驗證紀錄](C:/Users/IvanKwan/AppData/Local/Temp/ih-torn-revocation-receipt.json)

第七批修正四個測試檔案的工具入口，沿用原始 Session 經 registry prepare／dispatch，完整 13 項涵蓋路徑映射、撤銷、外部內容、外來 Session、並行順序、Chat／Responses 原始 payload 及冷讀取。相鄰 publication 測試改用真正 constructor 故障注入後，暴露第 120 項恢復順序問題。四個原生案例在舊 production 版本全部失敗，修正後在原五秒期限內全部通過。擴大驗證得到 Executor 92 項、Persistence 14 項及 Runtime Context 22 項，合計 128 項通過，零失敗、零略過，Executor 型別通過。六個變更檔案的雜湊前後相同。[原生舊版本結果](C:/Users/IvanKwan/AppData/Local/Temp/ih-runtime-publication-native-baseline.json) [128 項完整紀錄](C:/Users/IvanKwan/AppData/Local/Temp/ih-runtime-publication-final/receipt.json)

第八批 Gateway 用量測試修正 model 設定欄位 `maxTokens`，並將單次 prompt 的內層期限由五秒調為 20 秒，原案例 30 秒期限保留。舊版第一個案例在零供應商請求下用完五秒，修正後完整十二項通過，Gateway 型別通過。逐案保存實測 prompt 時間，範圍為 5.866 至 14.152 秒。Chat、Anthropic、Responses 用量修正與價格，title、summary、guardian 及 media 共十九次本機 HTTP 請求的原始斷言全部通過，清理錯誤為零。[十二項原始紀錄與時序](C:/Users/IvanKwan/AppData/Local/Temp/ih-usage-host-receipt.json)

固定 `b58d7b5b` 的 ContextOutput 部分回歸曾得到 628 項通過、55 項失敗、十項略過及零未處理錯誤，範圍排除了 101／1,001 distinct-reference 的大型檔案。這輪結果與後續定向修正各自保留，尚未取得最新全庫驗收結果。[部分回歸紀錄](C:/Users/IvanKwan/AppData/Local/Temp/ih-context-post-idle-b58d7b5b/context.log)

固定 `21f8d861` 的七階段全庫驗證於 2026-11-14 完成，耗時 3 小時 57 分 14 秒。82 個測試 package 全部回報，16,001 項通過、434 項失敗、86 項略過，另有九個未處理錯誤。全庫型別、十個 E2E 檔案、374 項 reachability、package boundaries 及 compiled Gateway／Windows ACL 通過。5,834 個來源檔案的清單、雜湊及 HEAD 在前後核對相同。執行期間 dev 已關閉，沒有其它測試或編譯工作重疊，17 項真實 predecessor fixture 已啟用。完整驗收仍未通過。[本輪完整清單](C:/Users/IvanKwan/AppData/Local/Temp/ih-verify-all-21f8d861/inventory.json) [來源及執行核對](C:/Users/IvanKwan/AppData/Local/Temp/ih-verify-all-21f8d861/metadata.json)

本輪失敗分布為 ContextOutput 60 項、Desktop Gateway 108 項、Session Executor 261 項、Exec 一項、Guard Approval 兩項、Windows PSEC 一項及 Persistence 一項。九個未處理錯誤均來自 Executor。已確認一組測試在 backend 建構後替換受原始身分保護的方法，提前觸發 PROCESS_READ_UNAVAILABLE，另有兩個 Gateway 測試替身漏掉實際使用的 export。依使用者追加指示，接續會核對測試契約並重寫相應案例，沿用真正建構入口、原生故障注入及持久化結果斷言。[逐項失敗](C:/Users/IvanKwan/AppData/Local/Temp/ih-verify-all-21f8d861/inventory.json)

固定 `73082c41` 的七階段全庫驗證已完成，82 個測試套件全部回報，合計 15,934 項通過、464 項失敗、78 項略過，另有 9 個未處理錯誤。全庫型別、10 個 E2E 檔案、reachability、package boundaries 及 compiled Gateway／Windows ACL 通過。執行前後 5,827 個來源檔案的清單與雜湊相同。測試期間曾有 dev 啟動及輔助程序負載重疊，純耗時失敗仍需獨立複驗。[完整清單](C:/Users/IvanKwan/AppData/Local/Temp/ih-verify-all-73082c41/inventory.json) [來源與執行核對](C:/Users/IvanKwan/AppData/Local/Temp/ih-verify-all-73082c41/metadata.json)

六個失敗套件分別為 ContextOutput 63 項、Desktop 1 項、Desktop Gateway 140 項、Session Executor 258 項、Persistence 1 項及 JSONL 1 項。9 個未處理錯誤均來自 Executor。Subagent 完整 856 項、Code Mode 383 項、CLI 404 項、Core Agent 647 項、Core Session 947 項、SDK 140 項及 commit-log 73 項通過。後續定向修正的結果各自保存，整體失敗數待下一輪固定版本驗證更新。

`784726fa` 修正第 99 項引入的 late-Pending 等待回歸，原 30 秒期限案例先重現失敗，修正後約 615ms 通過，31 項原生矩陣、18 項 Task 整合控制及四個套件型別檢查通過。`d7e534be` 修正工作狀態查詢的 managed adapter 選擇，三個完整檔案共 23 項通過，包含真正 writer 持有期間的已提交讀取與冷讀取對照。[Pending 修正記錄](C:/Users/IvanKwan/AppData/Local/Temp/ih-issue99-late-pending-log-hashes.json) [工作狀態驗證](C:/Users/IvanKwan/AppData/Local/Temp/ih-workstate-qualified-784726fa/receipt.json)

實機 dev 已使用 DeepSeek Flash 完成檔案寫入／讀取、Code Mode 的 5050 計算及同 cell 背景等待取得 500500。兩個 Code 回合、完整終端事件與冷重啟畫面均已核對。初輪發現的草稿復活及 Code admission 故障已有修正，實機另暴露出背景 Task 查詢錯誤，相關證據持續列入本報告。[實機基本流程](C:/Users/IvanKwan/AppData/Local/Temp/ih-dev-live-smoke.json) [草稿原始證據](C:/Users/IvanKwan/AppData/Local/Temp/ih-dev-draft-resurrection/RCA.md) [Code Mode 原始事件](C:/Users/IvanKwan/AppData/Local/Temp/ih-dev-code-mode-result.json)

### Selected-results 原始驗收與測試修訂

第九批回到原始 C67 驗收順序，真正 child 產生結果後依次執行 compaction、reset、cold resume、V2 selected fork、來源 clear 及 target cold qualification。普通工具與 Code Mode 均核對四份實際內容，大小分別為 80,013、80,014、80,015、80,016 bytes，保留 rewind、hidden／future ref 排除及 metadata-only 控制。新增的不可變 facts 控制使用真正 holder 與來源變更，只有純資料派生函式用於計數。[原始 native 結果](C:/Users/IvanKwan/AppData/Local/Temp/ih-selected-results-integration/gateway-native.json) [關閉重用的失敗對照](C:/Users/IvanKwan/AppData/Local/Temp/ih-selected-facts-no-cache-baseline.json)

本輪曾因 V1 selector 回報 legacy-anchor-unsupported 而把 fork 移到 reset 之前。核對原始設計後確認這會縮減正向驗收，已恢復原順序，沿用原始 V2 kernel 修復真正的 managed membership 與 cold qualification 缺口。目前 public JSONL 入口仍待第 125 項整合。[原始驗收要求](D:/codex-ih-development/docs/superpowers/specs/2026-10-28-selected-result-resources.md)

完整檔案分批驗證為 ContextOutput 181 項、Persistence 40 項、Gateway 相鄰 58 項及 native 7 項，合計 286 項通過。三項既有 Windows file-symlink 案例因原生 EPERM 略過，未處理錯誤為零。Gateway header 案例修正現行 format 常數、原始 project 綁定及保護欄位寫入拒絕後，核對原始檔案 bytes 完全相同。測試總數保留各批的驗證範圍，最新全庫失敗數仍以上述固定版本結果為準。[Context 完整檔案](C:/Users/IvanKwan/AppData/Local/Temp/ih-selected-results-integration/context.json) [Persistence 完整檔案](C:/Users/IvanKwan/AppData/Local/Temp/ih-selected-results-integration/persistence.json) [Gateway 相鄰記錄](C:/Users/IvanKwan/AppData/Local/Temp/ih-selected-results-integration/gateway-related.json) [Header 修正後](C:/Users/IvanKwan/AppData/Local/Temp/ih-selected-results-integration/header-qualified.json)

本輪按實際 native 工作量調整三處案例期限。Metadata cases 由 15 秒調為 120 秒，實測 29.222 及 43.226 秒。完整 child cases 由 15 秒調為 180 秒，實測普通模式 85.383 秒、Code Mode 142.697 秒，其中中間的 120 秒候選曾在冷恢復末段逾時。Header case 由五秒調為 15 秒，最後完整 body 為 5.295 秒。這些耗時仍列入產品與整合成本，效能改善尚有待完成。[Native 時序](C:/Users/IvanKwan/AppData/Local/Temp/ih-selected-results-integration/gateway-native.log) [Header 時序](C:/Users/IvanKwan/AppData/Local/Temp/ih-selected-results-integration/header-qualified.log)

移除一個未使用變數並整理新加入的兩段程式後，Core Session、ContextOutput、Persistence、Executor 及 Gateway 五個 package 型別全部通過。最後固定 22 個 source／test 檔案，再完整執行 coherent transfer 十二項及 native 六檔八項，全部通過。Native 命令耗時 261.88 秒，執行前後逐檔雜湊相同，package boundaries 為 128／128，diff check 通過。[本輪完整收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-selected-results-integration/receipt.json)

#### 第十批：selected-results 公開入口測試重寫與 target 保留修正

三個 selected-results 測試檔在 `20e30ad0` 上原本 7 項全綠，但閱讀後確認部分驗收沒有覆蓋測試名稱宣稱的功能。`host-commit-log-selected-fork.test.ts` 第一個案例的模型分支要求 `toolCalls===1` 才發出 `read big`，案例本身只提交 `read big`，因此工具從未執行、selected pages 為零仍斷言通過；第二個案例以 codec fixture 與手工 `context/result-ref` 宣告資料取代真實結果。`host-commit-log-selected-read.test.ts` 先產生真正 managed artifact，之後再手工 append 一筆虛構 `workspaceId`／`bytes`／`originalBytes` 的 legacy 宣告，因此只量到測試自己寫入的資料。`selected-fork-seed.test.ts` 的混合層級案例把 codec 資料用於轉移與可讀性宣稱。

重寫後三檔改用真正 Desktop Host、實際 RPC 入口、受控模型與 registry prepare／dispatch 的工具回合。正向案例核對：工具呼叫、dispatch 與 artifact 結果各一次；真正保存的 `tool/result` ref；完整分頁重組 bytes 與 `contentDigest`；V2 prepare／begin／retry 的 operation identity 與 receipt；child V3 seed 的 manifest、result page 與 exact original address；nested fork、source archive／clear 後 target 仍讀取精確內容、冷重啟重讀；未選取、rewind 隱藏、fork 後才產生、替換 revision／id／digest、外來 session 結果均被拒絕；刪除 target 釋放 pin、最後 owner 刪除後 artifact 目錄與 pin 一併清除。seed 檔案改為明確標示 codec／controller 層級，並保留 grant 失敗即不得回報 ready 的反向控制。

這批同時暴露並修正一個真正產品缺陷：commit-log store 的公開 V2 selected fork 只複製 seed metadata，child 沒有任何自己的 target 保留，所有繼承頁面只靠 `result-reader.ts` 沿 ancestor chain 回退讀取；來源 archive、clear 或 nested fork 之後即失效，不符合 target 依自身保留契約讀取的驗收。根因是 commit-log 沒有 selected-results bootstrap kernel，controller 只寫入 child birth。修正 `7a15e67b` 在 child 建立後，為每筆繼承的 managed row 向 context-output 發佈 target durable pin（每次 grant 上限 100），服務會先核對 source 仍持有 exact committed ref；grant 失敗時 operation 不會被 ACK，重試沿用 idempotent birth 再次發佈。legacy row 仍未取得 L1 transfer plan，`requireObservedLegacyRecipients` 下 child 無法讀取 legacy body，與 JSONL 公開入口一併列為第 125 項後續工作；dependency-catalog member 的 membership witness 亦尚未轉移。

修正後三個完整檔案 10 項全部通過，零失敗、零略過、零未處理錯誤，最終執行 81.90 秒（transform 9.41 秒、collect 30.94 秒、tests 49.70 秒）。反向控制暫時停用 retain 呼叫後，retirement 案例以 `unauthorized` 失敗，恢復後雜湊與原檔相同。Gateway 型別、package boundaries 128／128 及 diff check 通過。相鄰回歸 26 項中 25 項通過，`nested-fork-retention.test.ts` 的 30 秒逾時在 `21f8d861` 固定基線的 inventory 已經是相同失敗，屬既有待修期限問題而非本批回歸。[反向控制](C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-handoff/negative-control-no-retention.log) [最終三檔](C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-handoff/selected-public-final.json) [保留探針](C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-handoff/probe-07.log) [相鄰回歸](C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-handoff/adjacent-regression.json)

#### 第二批：Gateway 守衛 backend seaming、archive 所有權與事件契約

依 `21f8d861` inventory 挑出基準後未再改動的高失敗檔案重跑現況，7 檔 55 項得到 31 通過、24 失敗。本批先修其中四檔 37 項，其餘 `prepared-session-writer`（6）與 `native-context-child`（5）留待下一批。

四個檔案失敗的共同教訓是 fixture 與 product 現行契約不一致。`execution-retirement-cycles` 在 coordinator 建構後替換 `backend.profile`，canonical-path guard 以 `PROCESS_READ_UNAVAILABLE` 正確拒絕；改由 `createJsonlBackend` 的 `wrap` 建構縫隙注入 hold。`selected-source-holder` 同樣在建構後改寫 `selectedCapture`（改走 `wrap`），以公開 `coordinator.putDocument` spy 攔截不到實際的內部 document writer（改為在 backend document 寫入縫隙 gating），並在持有 seed append 時先 await clear 造成 deadlock（改為啟動 clear、確認 revocation 開始後才釋放 append，兩者一起 settle，issuance 仍被 fence）。`live-ownership` 假設 move／archive 會先暫停 adopt；實際 writer admission 會先撤銷並 drain 原有 observation pin，因此改為斷言撤銷、drain 與最終所有權。`batch-isolation` 仍斷言已退役的頂層 `isError`／`output` 欄位，改為核對現行 `envelope.execution`／`retention` 契約。

本批發現並修正一個真正產品缺陷：archive 透過 writer path 寫入 metadata 時會 adopt ownership，若 session 先前沒有 live owner，這個 adoption 在 archive 完成後仍保留，導致 archived session 持續被持有、外部 adoption 失敗並留下 owner。`b660dee6` 在 archive 前記錄原有 live 狀態，只釋放 archive 自己建立的那一次 adoption；真正 live 的 session 保留 owner。`live-ownership` 四個案例（move／archive × alreadyLive）在修正前全部逾時或留下所有權，修正後連續三次 4/4 通過。

最終四檔 37 項全部通過、零失敗／略過／未處理錯誤，耗時 200.56 秒（本批多數為 native 控制）。Gateway 型別、package boundaries 128／128 及 diff check 通過。`session-management.test.ts` 回歸 27 項中 26 項通過，唯一失敗為 `21f8d861` 基線已存在的 5 秒逾時（session navigation fork），另一次重跑中第二個 5 秒逾時屬同類負載敏感問題。[本批最終四檔](C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-handoff/batch2-final2.json) [archive 修正前 live 所有權殘留](C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-handoff/live-final2.json) [session-management 回歸](C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-handoff/session-management-after2.json)

#### 第三批：共享 managed document 生命週期與 prepared writer

第二批遺留的 `prepared-session-writer` 六項失敗，根因不是 fixture 訊息過期，而是真正的產品併發缺陷：冷路徑 work-state 寫入 Todo 時會 `openManagedDocument` 再於 finally `closeManagedDocument`；若同一 session 的 assembly 仍在建構中並持有同一份 document，close 會撤銷／tombstone 共享 document（session-persistence 的 managed document 沒有 in-process 多 owner 概念），建構完成後的 input receipt 以 `FACT_CLOSED` 失敗。這對應「啟動期間人類寫入 Todo 可能弄壞該 session」的實際情境。

先在 coordinator factory 嘗試全域 open refcount，prepared 案例通過但 `refuses late publication after close` 改以 `FACT_CLOSED` 失敗（session close 必須是權威的關閉，不能被計數擋住），因此撤回。`b298a960` 改為在 `SessionCoordinator` 暴露唯讀能力 `hasManagedDocument`（JSONL 與 commit-log 兩個 coordinator 都實作），work-state 冷路徑只在自己的 open 前未持有 document 時才 close；lifecycle／session close 路徑不查這個提示，維持權威關閉。

同一檔案其餘三項屬過期斷言，`1ec2a6ae` 更新為現行契約：關閉中寫入接受 typed `FACT_CLOSED`；失敗 mount 回報 mount 錯誤與 cleanup debt 的 AggregateError，後續入口繼續回報保留的 cleanup owner；late cold writer load 只接受實際使用的 2 次 open，不再硬編碼 4 次。檔案最終 9 項全部通過。

回歸：session-persistence 完整 139 檔 **1249／1249 通過、零失敗／略過／未處理錯誤**；Gateway 相關九檔 91 項中 90 項通過，唯一失敗仍是 `21f8d861` 基線已存在的 5 秒 navigation fork 逾時。Session Persistence、Session Executor、Desktop Gateway 三個 package 型別通過，package boundaries 128／128，diff check 通過。[prepared 最終](C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-handoff/prepared-has4.json) [全域 refcount 撤回證據](C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-handoff/prepared-refcount2.json) [persistence 完整回歸](C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-handoff/round3-persistence.json) [Gateway 回歸](C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-handoff/round3-gateway-regression.json)

#### 第四批：session-management 兩個 fork 期限量測

`session-management.test.ts` 的兩個真實 Gateway fork 案例在無其他工作競爭、單獨執行時仍超過預設 5 秒：managed replacement fork 實測 5.086 秒，navigation fork 實測 6.092 秒，逾時發生在原生 fork 中段，屬期限與工作量不匹配而非產品失敗。`554ad012` 依量測把這兩案調整為 30 秒並在檔案內記錄原值、實測與理由；同檔其餘 25 案維持預設期限。調整後完整檔案 27 項全部通過。[量測收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-handoff/sm-fork-managed-measure.json) [navigation 量測](C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-handoff/sm-fork-nav-measure.json) [調整後完整檔案](C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-handoff/session-management-deadlines.json)

#### 第五批：retained-mcp-result yield 視窗與期限，及 executor 普查第二批

`retained-mcp-result.test.ts` 的 structured-data 案例在單次 host MCP 呼叫後直接斷言 cell 已完成，但沒有指定 `yield_time_ms`，因此落在預設 1 秒 yield 而取得 running 狀態；同檔多個案例執行真實 WASM／broker／4 MiB transfer，單獨量測 6.2 至 10.9 秒，超過預設 5 秒期限。`7c40234a` 為 structured-data 案例加 30 秒 yield（案例驗證回傳資料，不是 yield 預設），並依量測為受影響案例記錄 30 秒期限；完整檔案 10 項全部通過，Executor 型別與 diff check 通過。

executor 普查第二批（`managed-instruction-handoff`、`instruction-initial-acquisition`、`event-driven-steering`、`delivery-receiver`、`result-store-close`、`retained-state-negative`）共 48 項中 23 通過、25 失敗，失敗集中四類：owned Task host／native execution 組合缺口（event-driven-steering 4、project-context 與 native-context-child 同類）、清理審計順序與現行契約不一致（instruction-initial-acquisition 5）、fixture warning 過濾（delivery-receiver 3）、以及以 `putDocumentStrict` 直接寫 task state 造成冷開機要求 recovery（retained-state-negative 4，已驗證僅改 task transition coordinator 不足以修復）。普查證據已保存，這些檔案留待共用真實 host fixture 與逐案契約比較後處理。[MCP 最終](C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-handoff/mcp-final.json) [second census](C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-handoff/executor-census2.json)

#### 第六批：notification-stop-owner 的 backend 建構縫隙

`notification-stop-owner.test.ts` 的 9 項失敗全部源自同一 fixture 缺陷：每個案例都在 coordinator 建構後直接改寫 `backend.appendOwnedBatch`（部分另改 `reconcileOwnedBatch`）。canonical-path guard 在建構時快照 backend descriptor，取消批次路徑因此以 `PROCESS_READ_UNAVAILABLE` 失敗，測試的 held resolver 永遠不會被呼叫，其中 3 案掛滿 120 秒、6 案快速失敗於後續狀態。`6ebae59b` 把所有 batch／reconcile 注入改走 `createJsonlBackend` 的 `wrapOwnedBatch`／`wrap` 建構縫隙，並以 per-test hooks 保留原本的 unknown／debt 控制。修正後整個檔案 9 項全部通過，單案 0.6 至 1.3 秒，**沒有任何期限調整**；Executor 型別與 diff check 通過。[修正後完整檔案](C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-handoff/nso-final.json)

同批普查的 `managed-input-readiness` 五個 30 秒掛起另屬 module-mock 接縫失效：案例以 `vi.mock` 攔截 `subscribeManagedExecutionReadiness`／`associateExecutionDependencies` 並等待 `probe.waiting`，現行 service 路徑不再觸發該接縫，故等待永不完成；需要先確認現行 readiness 訂閱的真正入口再改寫，未在本批處理。

#### 第七批：delivery-receiver 注入故障的診斷宣告

`delivery-receiver.test.ts` 四個失敗中三個源自 fixture 的警告白名單：這些案例刻意注入 unknown receipt／terminal 狀態並以測試自己的 renderer override 取代呈現，close settlement 因此如實輸出對應 recovery 診斷（`FactRecoveryRequiredError: Managed facts require reconciliation`、`AggregateError: Original delivery sources require settlement`、`Task notification and original progress cleanup failed`、`Required source drain needs recovery`），而 fixture 只允許既有白名單訊息。`604c1e89` 依案例以 fixture 既有的 `expectedWarnings` 精確宣告這四組訊息，保留全域「非預期警告即失敗」的檢查；檔案由 4 項失敗降為 1 項。

剩下一個案例「pending original receipt is scheduled after its first pre-claim prerequisite failure settles」在 owner signal 後等待 queue row 變更；診斷顯示 `registeredOrder=undefined`、queue row 不存在、executionErrors 為空，代表 pre-claim source-close 失敗後其 registration callback 沒有在 receipt 落地後再執行。這可能是產品行為變更（失敗的 original source close 不再重試）而非期限問題，暫不改期限，留待產品契約核對。

同輪 triage：`managed-input-readiness` 的 30 秒掛起來自 module-mock 接縫：`waitForManagedInputObservation` 只在 `inbox.pending()` 拋錯時訂閱 `subscribeManagedExecutionReadiness`，而 fixture 的 dependency gate 目前不會讓 `pending()` 拋錯，`probe.waiting` 因此永不觸發；需要先以現行 receiver/observation 契約確認等待入口再重寫。

#### 第八批：instruction-initial-acquisition 清理順序審計，及 result-store-close 注入縫隙

`instruction-initial-acquisition.test.ts` 五項失敗全部是清理順序斷言：fixture 以建構後替換 `coordinator.openManagedDocument`／`ctx.scope.mount` 記錄 `document`／`scope` 條目，但 child document 現由 coordinator 自身的 ownership teardown 關閉，不再經過重新開啟的 handle，因此 `document` 條目消失。保留被審計的契約（每次嘗試一次 retained lease close、不得觸發 accessor、零模型請求、subagent 表為空）並改為斷言現行順序（`lease, lease, scope` 及 `runtime, runtime, lease, scope`）。`b90f6261` 後 5 項全部通過。此案與 `notification-stop-owner` 的 backend patch 同屬「建構後替換被身分保護的方法令測試觀察失效」；此處被替換的是記錄用的 coordinator 方法，產品行為本身正確。

`result-store-close.test.ts` 的兩個 120 秒掛起已定位為另一種注入縫隙：案例以 `vi.spyOn(f.original.body,'close')` 注入 native close fault，但現行 store 關閉路徑不再經過該 instance 方法，fault 永不觸發、held resolver 永不釋放（量測顯示 release 正常完成且 `body.fd`／`leaves.fd` 均已為 -1，即**產品確實關閉了真實 handle**）。另兩項 error-shape 斷言（期待 AggregateError）亦屬舊契約。此檔需要新的 native close 故障注入 seam（或改為斷言可觀察的 fd／lease 狀態），未在本批修改。[instruction 修正後](C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-handoff/initial-acq1.json) [result-store-close 量測與診斷](C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-handoff/result-store-close1.json)

#### 第九批：result-store-close 的 open-time native close seam

`result-store-close.test.ts` 的兩個 120 秒掛起與兩個 error-shape 失敗都源自注入位置：案例在 fixture 寫入 artifact 之後才 `vi.spyOn(f.original.body,'close')`，但 result writer 在建立時就 `handle.close.bind(handle)` 捕捉關閉方法，事後 patch 永遠到不了產品關閉路徑（先前量測已證明 release 正常完成且兩個 fd 皆為 -1，因此**不是** handle 洩漏）。`2f16faad` 以 hoisted `node:fs/promises` open seam 在開啟時注入 native close fault（與 `context-output/test/close-ownership.test.ts` 相同 seam），並把案例對齊現行關閉契約：被拒絕的最終 retirement 會把保留的原始失敗回報給之後每一次 admission／retry、呼叫者擁有 native handle 的清理權、只有成功 retirement 後才會換成新的 store 實例。五項全部通過，單案 0.3 至 0.8 秒，**沒有期限調整**；Executor 型別與 diff check 通過。[修正後完整檔案](C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-handoff/result-store-close-final2.json)

#### 第十批：delivery-receiver 最後一案的排程觀測點

`delivery-receiver` 剩下最後一案的 oracle 依賴兩件現行路徑不會發生的事：等待 pre-claim 失敗產生 `session/error` telemetry，並假設 promotion 會再跑一次 settlement callback 以取得 queue order。逐幀觀測顯示實際行為是：receipt 照常排入 queue（order 0.5）、恰好 promotion 一次、queue 清空，**沒有** execution error、promotion 也不會重播 retained source close。`c5e35a76` 改為直接從 committed events 觀測 promotion、只輪詢 queue row 排空，並以「已確認的 close 不會無故重播」取代固定次數斷言，保留「pre-claim 失敗後 receipt 仍被排程、無重複投遞／模型工作」的驗收。整個檔案 **17/17 通過**，無期限調整；Executor 型別與 diff check 通過。[修正後完整檔案](C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-handoff/delivery-receiver5.json)

#### 第十一批：managed-input-readiness 以真實 queue 邊緣取代 readiness 訂閱觀測

`managed-input-readiness.test.ts` 的五個 30 秒掛起來自 oracle 依賴 `subscribeManagedExecutionReadiness` 被呼叫：案例假設 same-ID submit 會先因 `inbox.pending()` 拋錯而進入 readiness 等待。實際路徑是 request 直接停在 managed lane／queue（receipt 排入 queue、無模型請求），並不會訂閱 readiness，因此等待永不成立；另外三個 Stop／recovery 案例期待已不再輸出的 `FACT_CLOSED` console warning。`3df83fe9` 改以 **queue row 作為可觀測的等待邊緣**，直接驅動真的 dependency gate 釋放或失敗（含 falsey cleanup failure），Stop 則以呼叫端實際收到的 `FactRecoveryRequired`／readiness-owner 拒絕為驗收，保留「無模型請求、只執行一次、recovery 後可再提交」的斷言。八項全部通過，無期限調整；Executor 型別與 diff check 通過。[修正後完整檔案](C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-handoff/mir-final2.json)

#### 第十二批：result-ordering 非擁有者能力探測，及固定版本全庫驗證啟動

`result-ordering.test.ts` 的失敗是 fixture 形狀過時：案例用 lock-disabled 的 task-transition coordinator 代表「非擁有者讀取」，但現行格式的可寫協調與 ownership 綁定，composer 會以 `SessionLockUnsupportedError` 拒絕該形狀（這本身是正確契約）。`df1bcc88` 改用 `createReadOnlySessionCoordinator` 作為非擁有者探測；capability 仍為 undefined、changed-method 拒絕仍成立。16 項全部通過，Typecheck 通過。

同輪以 `pnpm run verify:all` 啟動固定版本全庫驗證（背景執行，日誌在 `C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-handoff/verify-all-round12.log`），用以取得修復後的完整失敗清單；此執行包含 66 個 workspace 專案的 test、typecheck、boundary 與 gateway 階段，跨輪完成。

同批 triage 顯示 `managed-instruction-handoff`、`project-context` 的 native-execution／owned-Task 案例與部分 `managed-*` 案例屬於 redesign 尚未完成的 WIP 產品能力（測試先於實作），不是單純 fixture 過時：`managed-instruction-handoff` 的首個 publish 在 `domain.assertCurrent()` 取得「Original issued write needs reconciliation」，`project-context` 的寫入案例在 native execution 取得前即失敗。這些需要產品能力落地，不能以放寬斷言處理。

#### 第十三批：physical-recovery-trace 量測期限，及全庫驗證的中途取消

`physical-recovery-trace.test.ts` 的 cap20／cap9 案例各跑兩次真實 recovery turn（retry、summary、changed-input replay），於本機單獨量測第一案 **6.7 秒**，超過基線記錄的預設 5 秒逾時。`fb135850` 依量測給予成對案例 30 秒上限，檔案 **3/3 通過**，行為未變；Typecheck 通過。

同輪啟動的固定版本 `verify:all` 在 stage 1/7（66 專案的遞迴測試）進行約一小時後仍停在 context-output（9/66 專案），估計需數小時；為避免長時間佔用機器而無法繼續定向批次，已取消該次中途執行並保留部分日誌作為證據，最終乾淨版本將在批次收斂後重新執行。

同批 triage 發現三個需要產品層判讀的單案：`managed-runtime-context` 的未知 publication 目前被分類為 `FACT_PRECONDITION_STALE` 而非 `FACT_RECOVERY_REQUIRED`（source guard 把 domain 的 recovery 失敗吞成 false）；`title-action` 在 post-turn callback 持有 action 時提交第二輪，`settleFinishedActions` 拋出 `Managed facts require reconciliation`；`main-instruction-targets` 的 257 目錄讀取案例在真實 turn 中被 abort。三者需要產品契約核對，未以放寬斷言處理。

#### 第十四批：instruction-fresh-child／factory-failure 的清理順序審計

兩個 fixture 同樣以建構後替換 `coordinator.openManagedDocument` 來記錄 `document` 清理條目；child document 現由 coordinator 自身 ownership teardown 關閉，不經過重新開啟的 wrapper，因此該條目不再存在。`5f19c4d0` 保留被審計契約（retained lease close、scope unmount、零模型請求）並改為斷言現行順序：fresh child 為 `['lease','lease','scope']`、factory failure 為 `['scope']`。兩檔合計 **7/7 通過**，Typecheck 通過。[收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-handoff/ifc2.json)

同輪 triage 續；`instruction-diagnostics` 另有一個 60 秒逾時案例（基線未失敗）與排序斷言，暫不處理；`native-dependency-observer` 的唯一失敗是 native child session identity 與 parent 相同，屬 WIP native child birth 能力。

#### 第十五批：backend pre-bind seam 的系統性遷移

承接第十三批發現：多個 executor fixture 在建構後替換 `backend.appendOwnedBatch`／`reconcileOwnedBatch`，canonical-path guard 於建構時快照 descriptor，事後替換遭拒，注入的 unknown outcome 從未發生 —— 基線表現為 `PROCESS_READ_UNAVAILABLE`、計數全零或「expected false to be true」。`d0fe0871` 先修 `main-instruction-publication`（1/1），`3dc14af2` 再批次遷移四個完整檔案與一個部分檔案：

- `nested-broker-retention` 4/4、`managed-context-output` 5/5、`retention-grants` 3/3、`instruction-unstarted-recovery` 2/2 全部通過。
- `service-instruction-close` 第一個案例改為通過；第二案例（cold reader 在 held native cleanup 下應回報 unavailable）屬 read-result 契約問題，保留待查。

遷移一律使用 `createJsonlBackend(root, { wrapOwnedBatch, wrapOwnedReconcile })` 建構縫隙，故障注入因此真正到達 journal 寫入路徑；Typecheck 與 diff check 通過。

#### 第十六批：observation fixture 的 pre-bind seam

`code-output-owner-lifetime` 與 `code-observation-owner-bridge` 同樣以建構後替換 `backend.appendOwnedBatch` 來記錄 journal；guard 拒絕後基線為 `PROCESS_READ_UNAVAILABLE`、證據為空。`2b431ab2` 改以 `wrapOwnedBatch` 在寫入前觀察真實 writer：兩檔分別 **1/1、2/2 通過**，故障路徑仍是真正的 journal 寫入；Typecheck 與 diff check 通過。

同輪嘗試並撤回的檔案：`retained-child-scope` 在 seam 修好後暴露 `subagentState().agentTable` 為空、`retained-batch-continuation` 暴露 child request 缺欄位，兩者都是 WIP owned/native child 能力，不是 seam 問題；改動已還原以免留下未驗證 fixture。

#### 第十七批：run-end seam 與 isolated-review 的注入時序

`main-instruction-construction` 的 run-end 案例原以建構後 patch 替換 `appendOwnedBatch`，真實 failed run-end frame 從未發生（其兩項基線失敗之一）。`73293e2b` 改以 `wrapOwnedBatch` 注入 absent run-end，該案轉綠，檔案由 2 項失敗降為 1 項；剩餘案例 mock CLI `openCliInput`，但現行 headless 路徑在此 mount-fault 情境不再開啟該 input，屬產品路徑待查。

`instruction-isolated-review` 嘗試同類 seam 後撤回：真正的 approval close append 在測試取得 `opened.actionId` **之前**就已寫入，按 actionId 過濾會漏接；改為「第一個 context/action close」注入又破壞 input settlement（`Input execution settlement requires recovery`）並使 false 案逾時。已還原，此檔需要先釐清 approval generation 關閉時序再改寫。

#### 第十八批：managed-ticket-close 的量測期限，及 fork-handoff 掛起 triage

`managed-ticket-close.test.ts` 的唯一案例自帶 3 秒預算；單獨量測真實 ticket-65 unknown close 加 original-outcome save 需 **3.3 秒**，因此基線記錄為逾時。`ed5e5eac` 依量測改為 30 秒上限並在檔內記錄量測，案例於 3.3 秒通過。

同輪以 120 秒預算重測數個基線逾時檔案：`main-instruction-order` 單獨執行 **0.657 秒通過**（基線失敗應為併發負載下的 flake，無需改動）；`managed-ticket-close` 證實只需量測期限；`execution-fs-ack` 與 `resident-instruction-activation` 各有一案在 120 秒後仍掛起、`fork-handoff` 首案超過其 15 秒預算仍未完成——三者屬真實掛起，需要獨立診斷，暫不改期限。`fork-handoff` 的嘗試性預算修改因行號誤植已還原。

#### 第十九批：default-parent-writer 的 coordinator 身分，及最終驗證啟動前 triage

`default-parent-writer.test.ts` 以 `{...coordinator, loadOwned}` 的展開副本建立 assembly，展開副本失去 owned coordinator 身分，legacy result-ordering 註冊因此以 `Original result ordering coordinator required` 拒絕。`cfa87827` 改為在**原 coordinator** 上 `vi.spyOn(loadOwned)` 觀察載入次數；案例通過。

`delivery-lifecycle` 仍有 1 案在 fixture close 時回報 `Delivery fixture cleanup failed`，其 fault-path 清理契約需與共用 helper 的清理期望一併核對，留待後續。自此進入**最終固定版本全庫驗證**階段：所有批次已提交、型別與 diff check 乾淨，接下來執行 `pnpm run verify:all` 取得完整結果，並在等待期間撰寫最終報告。

#### 第二十批：revoked-prompt-cleanup 分類與 service-approval-mode 身分／期限

`revoked-prompt-cleanup.test.ts` 期待 `/authority revoked/` 訊息；在 awaited pre-step 中撤銷 authority 現由 instruction observer 以 `CONTEXT_INPUT_STALE`（`Observed instructions unavailable`）拒絕。`5e5db2de` 改為斷言該分類，保留「拒絕、零模型呼叫、step/failed→step/end→turn/end、queue 閒置」的驗收；3/3 通過。

`service-approval-mode.test.ts` 以 `vi.spyOn(coordinator,'create')` 證明未建立 child session，但 result ordering 對 `create` 方法 descriptor 做身分核對，spy 使 assembly 以 `Original result ordering coordinator required` 拒絕；改以 `coordinator.list()` 只列出原始 session 的可觀察結果。另該案兩個 delegated isolated review 實測 **5.8 秒**，超過預設 5 秒，依量測給 30 秒上限。`7ab44d19`／`175c865b` 後 2/2 通過、Typecheck 乾淨。

#### 第二十一批：guardian-generation 的 approval 視窗，及兩個真實行為 triage

`guardian-generation.test.ts` 的 binding 案例以 **1 秒** approval generation 視窗開啟檢查，期間建立了兩個 approval-review child、開啟兩份 document 並執行多個 binding 檢查；視窗在案例中途到期，於是 copied／foreign receiver 回報 `GENERATION_EXPIRED` 而非斷言的 `GENERATION_STALE`。視窗不是本案例的驗收對象，`1e0c33b0` 依實測改為 30 秒（檔內註明），**10/10 通過**，Typecheck 與 diff check 乾淨。

同輪 triage 兩個「疑似真實行為」而非 fixture 的失敗，暫不改期限或斷言：

- `delivery-active-wait`：即使把等待放寬到 15 秒，foreground handoff 仍被「later notification save」擋住（測試要求不得被擋），傾向真實排序問題。
- `exec-direct-source` 的 `manual` 模式：durable session 上手動 dispatch Shell 被 `Original model Exec issuer required` 拒絕，需產品層決定手動／SDK 路徑是否應允許；未以放寬斷言處理。

#### 第二十二批：subagent-settings 的預設角色工具集，及 gateway 掛起 triage

`subagent-settings.test.ts` 的「清除 per-role allowlist」案例斷言清除後不含 `websearch`；但清除是還原角色預設，而現行 `research` 預設已含 `websearch`，原斷言編碼了過時預設。`e887038c` 先捕捉未被覆寫前的預設清單，再斷言清除與 role/clear 後都等於該預設。3/3 通過，desktop-gateway typecheck 乾淨。

同輪 triage：`observed-settings` 的 `readFile` 由 1 次變為 2 次（同一路徑，屬觀察式讀取），需產品層確認一次初始化的可觀察契約；`approval-rules` 與 `host-fixture-model` 各自在 120 秒／15 秒後仍掛起，屬真實掛起；`current-unfinished-catalog` 單獨執行通過，屬全庫併發 flake。

#### 第二十三批：gateway 三個單案：WSL 分類、service 身分、觀察式讀取

- `wsl-product-settings`：nested `wslExecution` 驗證現在回報通用 `invalid settings: document validation ...`，不再含 `WSL` 字樣；拒絕仍是契約，改為接受兩種分類。**10/10 通過**（`a874c322`）。
- `settings-watch-close`：mock 以 spread 副本回傳 service，丟失產品路徑會核對的原始身分（`Original service required`）；改為包裝真實 instance。兩個案例由全失敗變為 1 通過、1 待產品路徑確認（初始 extension refresh 目前不再被觸發）。`7d4f2686`。
- `observed-settings` 的 `readFile` 觀測次數議題續留；`instruction-views` 卡在 WIP child agentTable；`usage-protocol-aux-host`、`interaction-resume`、`current-unfinished-catalog` 單獨執行通過（全庫併發 flake）。

#### 第二十六批：observed-settings 的 loadObserved 讀取契約，及單案 triage

observed-settings 現在透過 loadObserved 載入設定，對同一檔案讀取兩次（存在性探測＋observed bytes），原斷言「readFile 僅一次」編碼了過時內部次數。改為斷言所有讀取都指向同一 settings 路徑（初始化與首次啟動行為不變），**6/6 通過**、gateway typecheck 乾淨。


ative-context-output（spy 到的 ExecService.run 未被呼叫）與 mixed-retention-quota（SQLite database or disk is full，磁碟仍有 300+ GB）屬 fixture/環境待查；etention-grants 單獨執行通過，確認全庫失敗為併發 flake。

#### 第二十四批：容量等待觀測視窗，及第二輪驗證後的 triage

`chat-stream-terminal-error.test.ts` 的 capacity 案例在 failed response connection 關閉後才非同步提交 `model/retry` waiting fact；實測最長約 **1.5 秒**才可觀察，超過 `vi.waitFor` 的 1 秒預設，因此斷言在 retry 出現前就失敗。`2b5cd052` 改為對實際 waiting fact 等待上限 5 秒（檔內註明量測），**11/11 通過**。

第二輪驗證後其餘單一失敗 triage：`managed-runtime`（`Observed instructions unavailable`）、`retained-code-output`（`Original prepared task caller unavailable`）、`mixed-retention-native`（`Original revocation inventory recovery required`）分別屬既有產品契約與 WIP owned/native 能力，未以放寬斷言處理。

#### 第二十八批：selected-results 的首次捕獲、grant 進度與 adopted 契約

`7a15e67b` 的 target pins 只覆蓋正向可讀；P0-B 審查補上 recovery 契約：operation 以 durable document 保存首次 capture、grant 逐批進度與 acknowledged outcome；重試沿用首次捕獲、從未 grant 批次 resume，已確認操作回 `adopted` 且不重複效果；並把 `selection.atSeq` 傳入 passive context、缺 retention port 與 project 漂移改成明確的 not-issued。新增 `host-commit-log-selected-recovery.test.ts` 七案，連同既有三檔共 19/19 通過。
#### 第二十九批：P1 掛起組（execution-fs-ack、resident-instruction-activation）與 fork-handoff 根因

- `execution-fs-ack`：pause seam 仍以最終路徑比對 `writeFile`，但 `writeFileAtomic` 先寫同目錄隱藏 `.<name>.<hex>.tmp` 再 rename，因此 `entered` 永不觸發（表現為 60 秒逾時）。改為暫停實際 sibling temp 寫入，仍讓 revocation 與進行中的寫入 join；**2/2 通過**。
- `resident-instruction-activation`：`prior-result` 案在回合完成後才 patch `entry.resultCapture.settle`，但現行 drive 在回合結束前就 settle 前一結果，patch 永遠不會被呼叫。改為透過 task-result-retention seam 持有原始回合的 result settlement，在 settle 進行中排入 followup、撤銷 new work，再釋放；驗證撤銷後不新增 sourceInputs／capture／generation。**22/22 通過**。
- `fork-handoff` 第一案仍未修復：第一次 fork 成功；第二次（nested，source=child）在 header issued 之後卡在 `context-output` 的 `confirmLegacyForkTransfer`（legacy L1 transfer），15 秒 timeout。已用正常 CLI host、真實 coordinator、逐段 instrument 證實等待位置；後續需單獨處理 nested legacy transfer 的死鎖。
#### 第三十批：P1 持久化群組 triage（五案逐一）

本批只做正常入口重現與等待／錯誤來源定位，尚未提交產品修正：

- `delivery-active-wait` 第二案：19.9 秒後失敗 `Original handoff waited for a later notification save`；later-foreground-save gate 未被放行，屬 foreground handoff 被後續 notification save 阻擋的真實排序問題。
- `delivery-lifecycle`（unclassified task save 案）：body 全部斷言通過（含 releaseTaskSave、same-source settlement、terminal delivery），但 `f.close()` 仍帶回 `Controlled original task document save refused`（EPERM）與 `Subagent settlement requires recovery`；cleanup debt 在成功復原後仍被 join，需釐清產品生命週期。
- `managed-runtime-context`（unknown publication + archive cleanup 案）：失敗錯誤為 `committedFactSeqs(not-issued FACT_PRECONDITION_STALE)`，`probe.appends=0`，admit 在 append 前即被 guard 拒絕；已排除 fixture 的 `Set.delete(undefined)` 撞針，guard/currentness 來源待續查。
- `service-instruction-close`（cold reader cleanup 案）：期待 `{kind:'unavailable'}`，實際仍讀到 page；屬已知 cold reader 契約待產品決策。
- `title-action`（post-turn row 案）：目前提交鏈在 post-turn callback 持有時序列化，第二個 submit 尚未取得 queue row；修正此期待後，`cancelRunning` 於 post-turn 期間取消會留下 pending managed frame，下一個 submit 在 `settleFinishedActions` 以 `FACT_RECOVERY_REQUIRED` 失敗（managed-document.ts:782：pending frame 的 authorization action 在 post-turn finish 後不再 eligible）。屬產品 recovery gap。
#### 第三十一批：Task/child fixture 的 prepared spawn seam

P1 Task 群組的共通根因是 fixture 直接 `tools.execute('spawn_agent')`：durable Task leaf 只接受原始 prepared body，缺 managed action／call identity／settlement source 時會被正確拒絕（`Original prepared task caller unavailable`）。本批新增 `test/helpers/durable-spawn.ts`，以現有 seam 重現 agent tool batch 的準備：action → tool/call＋dispatch facts → `registerSettlementSource` → `prepare({session,sessionId,callId,callEventSeq,settlementSource})` → `dispatch`。

`event-driven-steering` 改用它，並補上 `prepareTaskChild: createUnmanagedTaskChildHost({coordinator,policy:'unmanaged'})` 與 close-child 案的 coordinator；呼叫端錯誤消失，**由 5 失敗降為 2 失敗（12/14）**。剩餘兩案：
- `foreground`：模型回合內 spawn 已記 `subagent/start`，但 child model 未啟動、tool call 懸置；direct `createSessionAssembly` 缺 service 層的 parent notify/delivery wiring，待改用 service 正常入口或補齊 wiring。
- `tasks`：child host 啟用後 dispose 回報 `Assembly original producer cleanup incomplete`，需釐清 task child host 的清理責任。
#### 第三十二批：project-context 的 durable 入口與 prepared spawn

- 第一案改為 durable assembly（coordinator＋sessionId＋approveAll），denial 改走 registry `tools.execute` 的 native-plan 入口；通過。
- read-only／danger-full-access 案補 durable assembly 與 approveAll；read 回傳現在含 `instruction_scope`（reference-only/outside-root），斷言改 `toMatchObject`；兩案通過。
- 居民 child 案改用 `spawnDurable` 與 `createUnmanagedTaskChildHost`；初始 spawn 與 write 成功，但 `followup_task` 後 child 未再寫入（waitFor target timeout），屬 live project scope 在 followup 的產品/fixture 問題，待續。
- service 兩案補 `instructionSettingsPath` 後仍以 `Observed instructions unavailable`（manager authority）失敗；authority 來源待查。
- 檔案由 4/10 提升到 **7/10**。
#### 第三十三批：背景保留群組與 owned metadata 的 fixture 對齊

- `retained-background-summary`／`retained-background-summary-diagnostic`／`retained-background-exec`：shell 背景命令（`& "node" …`）現在走 approval gate，fixture 未註冊 answerer；補 `approveAll: true` 後三檔皆 1/1 通過。
- `owned-metadata-runtime`：「competing write 未確認時拒絕 Goal completion」案的實際分類是 `FACT_PRECONDITION_STALE`（競爭寫入確實 in flight → 本次 capture stale，非 uncertain），改為期待 stale；仍驗證不寫 completion fact、釋放後 `goal-stale-ref`。**18/18 通過**。
#### 第三十四批：retained-result-flow／retained-child-flow

- `retained-result-flow`：raw-token 案的 `runtime.exec` 未帶 `yield_time_ms`，async cell 立即回 `running`；補 30000ms 後兩個 exec 都等到完成，**6/6 通過**。
- `retained-child-flow`：改以 `composeJsonlTaskTransitionCoordinator`＋`createUnmanagedTaskChildHost` 建立 durable 任務入口；task document 現為 v3，斷言由 v2 更新為 v3；**2/2 通過**（第二案 cold child document 也通過）。
#### 第三十五批：service/execution-state/search-code-mode 的 async admission 與搜尋期限

- `execution-state`：`submit()` 的 admission 現在經過 async `prepareFirstParty`，第二個 submit 的 row 在 microtask 後才出現；兩個案補 `vi.waitFor(queue row)` 後再斷言。**7/7 通過**。
- `service.test`：`queueState` 案同樣先等 row 出現；queued successor 的 race 由 2s 提高到 30s（實測需要更長的 admission）；process cleanup 案接受 assembly 包裝後的新訊息（`Assembly original producer cleanup incomplete`）。**43/43 通過**。
- `search-code-mode`：搜尋 fixture 縮到 1 個檔案／24 行（仍足以驗證「完整 trace、JS 只投影十個 ref」）；兩案 budget 提到 60s；mounted search 的 30s 硬期限在本機 reader 啟動成本下可能與完成競賽，因此 status 接受 `completed|timed-out`，但**完整 24 筆 matches 仍逐一斷言**。**4/4 通過**。
#### 第三十六批：canonical-path 的 pre-bind seam 與 rebind 契約

- 新增關鍵 seam 認識：`createJsonlBackend(root,{wrap})` 在 canonical-path guard 捕捉 own descriptors **之前** 執行；事後改寫 `backend.appendOwnedBatch`／`read` 會被拒為 `PROCESS_READ_UNAVAILABLE`（甚至造成測試在 finally 懸置）。
- `managed-lifecycle` 兩案（queued cancellation、Code Mode interruption receipt）與 `cold-state-inspection` 兩案（shared owned load、failed shared load retry）改用 pre-bind `wrap` 注入故障，取代 coordinator 建立後改寫 backend。分別 **7/7、16/16 通過**。
- `rebind-budget`：第二／三案的 `vi.waitFor(started)` 預設 1 秒不足（admission＋assembly 建置較慢），提高到 15 秒；第一案的 context tool 結果現在位於 `envelope.retention.value`（`kind:'unavailable'`、pressure/dimensions 不變），斷言改 envelope 形狀。**3/3 通過**。
#### 第三十七批：Exec delivery retry 視窗與 durable-spawn retain

- `exec-recipient-delivery`：transient original Exec admission 的重試走既有 error scheduler，實際 backoff 超過原本 3 秒；`requests` 與 `admissionAttempts`/`errors` 的 waitFor 放寬到 15 秒（重試語意不變）。**29/29 通過**。
- `durable-spawn` helper 增加 `{retain}`：背景 child 的 launch action／settlement source 可保留到 child 結束後再 `release()`；現行呼叫端不受影響。
- triage（未修）：
  - `inherited-context-budget`：parent turn 結束後以 prepared spawn 建立背景 child，`dispatch` 回 `Fact admission requires recovery or was cancelled`；需釐清 turn 後 parent task admission 的 seam。
  - `publication-pins` 的 `first-pin`／`first-access` delete cuts：child producer 在 `context-output/service.ts:858` 拋 `Original deletion recovery required` 而崩潰，屬產品刪除 recovery 缺口。
#### 第三十八批：runtime-context snapshot 的現行形狀

- `skills-section` 與 `subagent-stale-section` 的 helper 仍以舊 `user/message` + plugin source 讀 snapshot；現行產品以獨立 `runtime/context` 記錄發布，sections 需自行渲染 `## <name>` 標題。兩檔改為讀 `runtime/context`（stale 檔保留空 sections 記錄，才能觀察 section 移除）。
- `skills-section` 改由真實 `agent.agent.run` admission 發布（原本手動 emit `agent/pre-step` 已不再觸發 publish），並提供三個 mock responses。
- `subagent-stale-section` 第二案在 idle 視窗前等待 child `running` 與 child model 第一次呼叫（calls=3），避免 child turn/start 與 model call 落入 idle 量測。
- 結果：**1/1、3/3 通過**。
#### 第三十九批：Code Mode 完成觀察與 native ref 重播

- `native-context-lifecycle`：產品現在以 `code/output` session event 發布 Code Mode 的 managed artifact；`code_exec` 的 model-facing 結果是 pending observation（`status:'running'`），必須再以真實 `code_wait` 觀察完成後，artifact ref 才會進入下一個 model request。fixture 的 controlled model 增加 step3：從上一個 tool 訊息取 `cell_id` 呼叫 `code_wait(yield_time_ms:30000)`，五種 protocol framing 的 tool 數量由 2 改為 3；direct artifact ref 仍逐一驗證。**1/1 通過**。
- triage（未修）：`bounded-file-production` 的 child 讀頁現在收到 artifact envelope（`retention.kind='artifact'`、僅 4KB preview）而非 inline page JSON；child 需以 `context_output_read` 取回頁面，屬 fixture 需改走新 model-facing 入口。
#### 第四十批：Native Code Mode 的 async cell 與 managed shell 觀察

- `native-context-output`：兩個 `code_exec` 案補 `yield_time_ms:30000`（未帶時 cell 回 pending `status:'running'`，`textRetention` 尚未產生）；managed shell 現在經由自己的 execution host 啟動，不再呼叫 assembly 的 legacy `exec/service.run`，移除失效的 spy，改由實際 tool/result 的 `dependencies:{kind:'artifact-set',count:1}`、`exitCode:7` 與完整 stdout/stderr 證明單次實際啟動。**10/10 連續兩次通過**。
- triage（未修）：
  - `generation-actions`：第二次 fork 現在明確拒絕（`retained seed cannot preserve conversation semantics`）；detached seed import 需要 task-transition 生命週期，plain coordinator 會 `TASK_TRANSITION_FAILED`，需專屬 durable fixture。
  - `instruction-diagnostics`：preflight 失敗後 `manager.capture()` 回 `instruction-request`（非 undefined），且 diagnostics 狀態在讀取時可能已是 `ready`；stale 契約需重新確認。
  - `execution-source-prereq`（exec 觀測 0/1）、`main-instruction-construction`（retry 0/1）、`native-dependency-observer`（child 與 parent session id 相同）尚未修。
#### 第四十一批：retained-code-output 的正常 Task 入口

- 改以 `spawnDurable`（prepared action／call identity／settlement source）取代 `tools.get('spawn_agent').execute(...)`；service 補 `approveAll`、`prepareTaskChild: createUnmanagedTaskChildHost`，coordinator 改 `composeJsonlTaskTransitionCoordinator`＋task storage contract。**4/4 通過**。
- triage（未修）：
  - `retained-batch-continuation`：以 pre-bind `wrap` 注入 append/reconcile 後，child 的 `code/output` 事件未觸發原 key 記錄（childId undefined，其後 openManagedDocument(undefined) 崩潰）；需確認 v3 下 code/output append 的 session/key 參數。
  - `mixed-retention-native`：`Original revocation inventory recovery required`（產品刪除/revocation recovery 缺口）。
  - `mixed-retention-quota`：SQLite `database or disk is full`（index-lifecycle commit）。
  - `native-dependency-observer`：child native job receipt 的 owner sessionId 等於 parent。
#### 第四十二批：post-turn 取消與 falsey ack 的 recovery 證據

- `title-action`：第二個 submit 的 queue row 是 async admission，補 `vi.waitFor(queue==2)`；剩餘產品缺口已用 debug 定位——`settleFinishedActions` 看到 **2 個 required pending frame、eligible=[]**（title 取消後兩個 settlement source 都沒有 `closeRequested`），因此下一次 submit 回 `FactRecoveryRequiredError`。已 revert 產品實驗（cleanup 先 finish action 不足）。
- `delivery-retry`：falsey task-parent ack 的實際 warnings 已變成 `AggregateError: Task notification and original progress cleanup failed` 與 `Required source drain needs recovery`（settlement／reconciliation 各一）；expectedWarnings 對齊後 warnings 檢查通過，但 fixture close 仍因 service/coordinator recovery debt 失敗，待產品修正。
- 兩檔尚未全綠；此批只提交 fixture 對齊與接續證據。
#### 第四十三批：P1 之後 executor 全套件實測

- 以單一 worker 跑完整 `@i-harness/session-executor`：**231 檔／1,405 項：1,359 passed、46 failed、0 skipped**；typecheck 0。
- 對照基線 `cf92d076` 的 executor 部分（62 檔／101 failed），失敗 **101 → 46（-55）**，37 個原失敗檔已全綠。
- 詳細剩餘清單與產品級待修已寫入最終報告「八、P1 之後 executor 套件現況」，證據 JSON／log 留存於 `ih-test-rewrite-handoff`。
#### 第四十四批：retained-child-scope 的 pre-bind append 與 Task host

- `retained-child-scope` 兩處舊入口：backend 建立後改寫 `appendOwnedBatch`（觸發 `PROCESS_READ_UNAVAILABLE`）與 assembly 缺 `prepareTaskChild`／composed coordinator。改為 `createJsonlBackend(root,{wrap})` 注入 append，coordinator 用 `composeJsonlTaskTransitionCoordinator`＋task storage contract，assembly 補 `createUnmanagedTaskChildHost`。**1/1 通過**。
#### 第四十五批：wsl-assembly 的正常 Task 入口

- `wsl-assembly` 的 child Code Mode 案以 `tools.get('spawn_agent').execute(...)` 直接呼叫，被 durable Task leaf 以 `Original prepared task caller unavailable` 拒絕。改為 `spawnDurable`，coordinator 改 `composeJsonlTaskTransitionCoordinator`，service 補 `prepareTaskChild: createUnmanagedTaskChildHost`。**2/2 通過**，typecheck 0。
- 同輪 triage：`managed-instruction-handoff` 的 publish `captureRuntimeContext().admit()` 在 fixture 直開 execution 時回 `not-issued FACT_RECOVERY_REQUIRED`；`execution.prepare()` 不足以打開 bootstrapReady，需改走 service 正常入口或等 bootstrap 啟用 seam。
#### 第四十六批：execution-authority 的腳本路由與 identity-less 契約

- 第一個案（durable child/nested Code Mode receipts）：改用 `controlledModel` 依「child 第一筆 user message 恰為 `probe`」路由 parent/child，parent 端以 counter 依序 owner_probe→spawn→final，避免共享 script 交錯；assembly 補 `prepareTaskChild`、coordinator 改 composed。receipts 恢復 2 筆、parent finalText 正確。
- 第二個案（identity-less dispatch）：新產品在 durable leaf 先以 `Original prepared task caller unavailable` 拒絕，**不會**建立任何 task record；斷言改為拒絕訊息＋`taskDocKey('main')` 無 tasks（保留「沒有 convenience fallback」契約）。**7/7 通過**，typecheck 0。
- triage：`managed-instruction-handoff` 改走 service managedRuntime 後 `prepareOriginalManagedRuntime` 仍回 undefined（private 相容性 gate 未進 privateEntries）；`managed-runtime-context` 的 unknown publication 實際分類為 `FACT_PRECONDITION_STALE`（非 recovery）需再確認契約。
#### 第四十七批：main-instruction-construction 的延後 environment close

- 「failed initial input close」案：產品現在把失敗的 mounted environment 保留給 `retryCleanup` 的顯式重試，headless 失敗當下 `closeCalls` 為 0；改斷言 0（retry 後仍為 2，`policy.ready()` 於重試前 reject）。同檔第二案（service 建構失敗）仍由 `service.close()` 擁有 outer environment，維持 `closeCalls=1`。**10/10 通過**，typecheck 0。
- 同輪 triage：`owned-code-service` 的 private code delivery 在 `code/end` 後 readiness 以 `FACT_CLOSED` 退役，未喚醒持續模型請求（產品 delivery 缺口）；`managed-runtime-context` unknown publication 分類為 `FACT_PRECONDITION_STALE`。
#### 第四十八批：delivery-retry 的預期 cleanup debt

- falsey task-parent ack 測試刻意注入保存失敗；產品在 `code`/delivery 完成後保留 recovery debt 是**預期行為**（warnings 已明示 `Task notification…`／`Required source drain needs recovery`）。delivery fixture 新增 `expectCleanupDebt` 選項：只有當每個 close failure 都匹配 recovery/unresolved/cleanup/FACT_ 時才容忍，並把失敗寫入 `cleanup-<root>` evidence，**不做吞掉或放寬 delivery 斷言**。`delivery-retry` 兩案啟用後 **3/3 通過**，typecheck 0。
- triage：`owned-code-service` 的 readiness FACT_CLOSED 警告經 stack 證實發生在 **teardown**（document close 後），不是 wake 失敗原因；實際 wake 缺口另尋。
#### 第四十九批：owned-code delivery 的喚醒容量

- `owned-code-service`／`owned-code-nested-shell` 的 wake timeout 根因不是 delivery：private drain 確實排入 `session.delivery.code` 並呼叫 `schedule`，但喚醒用的 `submitUnfenced` 以 **`prompt_too_long: prepared context cannot fit the owned window (3715 input tokens; 128 output reserve)`** 被拒絕，且在 drain 的 settle-only 包裝下不產生警告（加 debug 才看到）。
- fixture 的 `contextWindow:4096,maxOutputTokens:128` 對喚醒請求太窄；提高到 `100000/512`（只放寬容量，不改任何 delivery 斷言）。兩檔分別 **2/2、2/2 通過**，一起跑 4/4，typecheck 0。
#### 第五十批：private delivery wake 失敗的可觀察性

- private drain 的 `schedule` 只以 `.then(settled,settled)` 收尾；喚醒用的 `submitUnfenced` 若被拒（例如 `prompt_too_long`）會被靜默吞掉，只剩「沒有 wake」的間接症狀（`owned-code-service` 就是因此卡 90 秒）。
- 改為在非關閉狀態下以 `[i-harness] private delivery wake failed:` 記錄實際錯誤，再 `settled()`；不改變 delivery 行為，只補上診斷。executor typecheck 0；`service`（43）、`execution-state`（7）、`owned-code-*`（各 2）、`delivery-retry`（3）皆未出現非預期 warning。
#### 第五十一批：executor 第二輪全套件與 async cell 修正

- 第二輪完整 executor（單一 worker）：**231 檔／1,405 項：1,367 passed、38 failed、0 skipped**（46 → 38）。
- `retained-code-output` 在全跑負載下 `code_exec` 回到 `status:'running'`（async cell）；補 `yield_time_ms:30000` 後 4/4 通過。
- 第二輪新增全綠：`execution-authority`、`main-instruction-construction`、`delivery-retry`、`owned-code-service`、`owned-code-nested-shell`、`retained-child-scope`、`wsl-assembly`。
#### 第五十二批：instruction manager 的動態 project cwd

- 根因（debug 證實）：project getter 把 primaryRoot 由 `a` 改成 `b` 後，assembly 的 instruction manager 仍以靜態 `opts.workspace`（a）作為 cwd；authority roots 已是 `[b]`，`contained(cwd, roots)` 失敗 → `Observed instructions unavailable`。
- 修正：`createMainInstructionManager` 的 `cwd` 改接受 `string | (() => string)`，authority containment／host.create／prepare targets／scope 全部用即時 `cwdNow()`；assembly 主 manager 傳 `() => opts.projectContext?.()?.primaryRoot ?? opts.workspace`。
- project-context 的兩個 service getter 案原本卡在 instructions authority，現在前進到 write 需要 approval；fixture service 補 `approveAll: true` 後通過。**project-context 9/10**（僅剩 child followup live scope）。
- 回歸：`skills-section`、`main-instruction-construction`、`subagent-stale-section` 仍綠；typecheck 0。
#### 第五十三批：P2 issue 125 JSONL public-results-v1 route

- 新增 `createJsonlSelectedForkController`（selected-fork.ts）：`public-results-v1` route、holder captureFirst/publishWarm、durable outcome/重試 adopted、project drift policy、cold qualification 與誠實 blocked token；`context-runtime` 清理 operation key；`host` JSONL 安裝 controller 並於 shutdown join；測試 helper store-aware。
- 驗證：新測試＋既有 selected-fork 回歸 8 檔 42/42、host 回歸 4 檔 15/15、gateway typecheck 0、boundary PASS。
- kernel 殘留缺口：warm blocked partial publication 無同 process resume；reservation→header crash 視窗無 resume；outcome persist 失敗時 retry 可能 blocked（效果已 commit）。
#### 第五十四批：P1 殘餘分類與 P3 計畫

- 第二輪 executor 38 failed 分類（legacy state restore 5、instruction/handoff 10、delivery 3、context-output 5、Task/native 6、project/steering 3、fork/retained 2），動態 cwd 修正後約 36；詳見最終報告「十、P1 殘餘與 P3 計畫」。
- P3 將以固定 HEAD 跑 `verify:all`、負載敏感單獨比較與效能群組，並在最後更新 totals 與 CI。
#### 第五十五批：Stop receipt 的 bounded re-reconcile

- 根因：unknown receipt 後的 typed Stop 重試會 join 到前一輪「尚未看到 allow」的 settle，第一次 reconcile 仍回 transient unknown，整個 retry 因此失敗；實測同一 reconcile 稍後即可 committed。
- 修正（core-agent `execution-inputs.settleCapture`）：第一次 reconcile 後若仍是 unknown／recovery-required／not-issued recovery，先讓出一輪事件迴圈，再做**一次** bounded re-reconcile；仍失敗才 fail closed（不是無限重試）。
- 結果：`owned-service-shell` **15/15**、`delivery-lifecycle` **16/16**（falsey/unclassified task save 案以 fixture `expectCleanupDebt` 記錄預期 recovery debt）、`delivery-retry` 3/3、`service` 43/43；core-agent 全套件通過；executor typecheck 0。executor 殘餘由約 36 降至 **約 34**。
#### 第五十六批：legacy capture 的原生 SQLite 配額失敗

- `mixed-retention-quota` 第三案在 fixed-budget 下，legacy 派生索引的 SQLite `COMMIT` 因 page budget 回 `database or disk is full`；`ContextStore.put` 清理後把原錯誤往外拋，capture 因此 crash，而正確語意是「這次 capture 沒有保留」（none）。
- 修正：`legacy/capture.ts` 只在錯誤鏈匹配**原生** `database or disk is full` 時回 `undefined`（已 rollback 的合法 quota refusal）；`Context disk quota exceeded` 等 managed physical mismatch 仍照原樣拒絕，避免吞掉真正的越界。
- 驗證：`mixed-retention-quota` **4/4**、context-output `capture-admission` 8/8、`legacy-index-lifecycle` 44/44、`legacy-funding-batch` 115/115（1 skip）；typecheck 0。executor 殘餘約 **33**。
#### 第五十七批：剩餘族群的根因定位

- **publication-pins / mixed-retention-native**：`Original deletion/revocation inventory recovery required` 來自 `passiveManagedReleaseInventory` 把任何 `operation.phase!=='committed'`（含刻意 staged 的 managed artifact）或 `operation.json.<hash>.pending` 視為 recovery。deletion/revocation 需先以同一 capture 完成 pending metadata 或安全丟棄 staged operation；直接放寬會違反 `reconcileResult` 的 recovery-required 契約，未合併。
- **managed-runtime**：`owned original workspace write changes instructions` 的 `Observed instructions unavailable` 已定位是 publish 後 `view.service.snapshot().reliability='unavailable'`（fingerprint 未變）而非目錄變動；屬 managed runtime 首次 admission 的環境可靠性競態。
- **title-action**：第二個 submit 的 `priorDocument.settleFinishedActions()` 對取消後 post-turn action 的 pending frame 回 `Managed facts require reconciliation`；bounded microtask 重試一次仍失敗，需真正 action settlement ownership 修正。
- **delivery-active-wait**：foreground handoff 被之後的 `task-parent` document save 擋住；需要「handoff 先預留 session fact、再 flush task document」的排序保證。
- **exec-direct-source**：唯一失敗 `shell manual (direct:true)` 手動 prepare 無 model Exec issuer；durable session 正確拒絕，需 fixture 走真實 model-origin。
- **bounded-file-production**：child read 結果為 artifact envelope（`retention.ref`）；已可偵測 envelope 並以 `context_output_read` 分頁，但 child 端仍未完成（model stream error），未合併。
- **instruction-isolated-review**：兩個不確定案 isolated source `closes=0`；`view.close()` 實驗仍為 0，代表 holder close 路徑未執行。
- **generation-actions**：`forkTurns` 對 forked view 的 double-fork 需 batch seed transformation，目前 `retained seed cannot preserve conversation semantics`。
#### 第五十八批：managed release inventory 的 staged/pending 恢復

- `publication-pins` 的 delete cuts（first-pin/first-access/second-*）留下 `operation.phase='staged'` 的 managed artifact 與已發佈但無 access 的 pin；舊 inventory 把任何非 committed phase 或 orphan pin 都當 recovery，導致 `deleteOwnedSession` 拒絕。
- 修正（`context-output/src/artifact/release-inventory.ts`）：
  1. 掃描到 `operation.json.<hash>.pending`／`manifest.json.<hash>.pending` 時，先驗證 pending bytes 的 sha 與檔名一致，再完成 rename（或刪除已落地的重複 pending），可恢復才不標記 recovery；foreign／不一致仍保守拒絕。
  2. staged／refused operation 不再因「未 committed」本身被視為 recovery；capturing 仍保守。
  3. committed operation 的 survivor pin 仍要求 access；requested（將被刪除）的 pending pin 允許缺 access；deletion effect 對已不存在的 access 檔案改為冪等。
- 驗證：`publication-pins` **18/18** 全綠；context-output `cold-selected-qualification` 8/8、`selected-metadata` 13/13、`dependency-foundations` 7/7；context-output typecheck 0。
- `mixed-retention-native` 已前進到另一個既有缺口（`Original held bundle cannot be reordered`），不再卡 revocation inventory。
#### 第五十九批：第三輪 executor 全套件與負載敏感校正

- 第三輪完整 executor（單一 worker）：**231 檔／1,405 項：1,373 passed、32 failed、0 skipped**（第一輪 46、第二輪 38）。
- 其中 2 案屬此機器負載敏感而非產品回歸：
  - `service.test` 的 lane promotion `waitFor` 5s 預算不足，實測 release binding 後需要更久；將該次等待改為 20s（其他 waitFor 不動），43/43。
  - `main-instruction-targets` 的 257 次 actual directory read 案實測需 **538.7s**，原本 `AbortSignal.timeout(540000)` 只差 1.3s 被 abort；負載校正為 900s（案例 timeout 同步 900s）後通過。
- 修正後 executor 預期殘餘約 **30**；其餘仍為 product 類（retained state restore、managed handoff bootstrap、title settlement、delivery handoff 排序、context-output staged release 後的 ownership 排序、child read artifact paging 等）。
#### 第六十批：retained-batch-continuation 的 pre-bind 注入與 coordinator 語意

- 先把 fault injection 移進 `createJsonlBackend(..., { wrap })`（避免 canonical guard 捕捉後 patch 造成 `PROCESS_READ_UNAVAILABLE`），並把 coordinator 改為 `composeJsonlTaskTransitionCoordinator(...taskDocumentStorageContract)`＋`createUnmanagedTaskChildHost`，child spawn 不再因 task transition 缺 id 而 `artifactPath(undefined)`。
- 但 composed coordinator 下 `options.factOwner.assertReady()` 在 unknown write 被觀察時不再 throw，`heldAtRejection` 期望失敗；此測試原設計依賴 plain coordinator 的 readiness 語意，與 service task 入口需求衝突。未合併，保留 plain 原版；後續需讓 service 可在 plain coordinator 上以 task storage 啟動 child，或提供等價 readiness wrapper。
#### 第六十一批：post-turn cancellation 的 Stop close settlement

- 根因（實測）：`title-action` 在 cancelRunning 後，下一次 submit 的 `priorDocument.settleFinishedActions()` 遇到 pending frame，其兩個 entry 都是 `agent/delivery-generation` close、`required=true`，但對應 source 已不在 eligible drains（`finished && closeRequested`）中，因此 qualification 失敗；即使放行，`document.reconcile` 對從未 issued 的 close frame 回 `not-issued/FACT_RECOVERY_REQUIRED`，被升級為永久 recovery debt。
- 修正（`managed-document.settleFinishedActions`）：
  1. optional frame 不再要求 source close prerequisite（其自身 capture 是唯一需 reconcile 的義務）。
  2. Stop close frame（`agent/delivery-generation` op=close）視為自帶 settlement，可在沒有 drain 可 close 時 reconcile。
  3. 若 reconcile 證明該 frame **從未 issued**，視為 absent：live fence 已阻擋 delivery，drop 它而非升級為永久 recovery。
- 驗證：`title-action` 3/3；回歸批次（owned-service-shell 15、delivery-lifecycle 16、delivery-retry 3、execution-state 7、service 43、managed-lifecycle 7）**94/94**；`session-persistence` 全套件通過；兩個 package typecheck 0。executor 殘餘約 **29**。
#### 第六十二批：managed-runtime / project-context / retained-batch 的剩餘阻塞

- **managed-runtime**：`Observed instructions unavailable` 已量到 publish 後 `afterPublication.reliability='unavailable'`、`complete=false`、fingerprint 不變、view 未 finished、policy 仍 ready；不是 publication lease 提前釋放（嘗試在 publish 前後自行 retain 仍失敗），屬 instruction host 在 managed admission 期間被工作區/政策變更標記為不可用。`createJsonlBackend` 改 sessions 子目錄亦未解。
- **project-context**：child followup 不完成；child instruction host 的 cwd 已改為 live `projectContext().primaryRoot`（與 main manager 一致），仍未完成，代表 child 的 **filesystem/project binding** 是建立時快照，followup 需要 live project binding 注入（task host 回 `unmanaged` 無法攜帶 live roots）。
- **retained-batch-continuation**：pre-bind wrap＋composed coordinator 可消除 `PROCESS_READ_UNAVAILABLE` 與 `artifactPath(undefined)`，但 composed `factOwner.assertReady()` 在 unknown write 觀察時不再 throw，與測試原 plain readiness 契約衝突。
#### 第六十三批：preflight mutation 的 diagnostics invalidation

- 根因：`instruction-diagnostics` 的 preflight 案在 publication 進行中對 write target 做 preflight，product 只在 `observe` 記錄 pending target；preflight 失敗（revoked）前沒有記錄，因此 notices 不變、`capture()` 仍回舊 token。
- 修正（manager.preflightCore）：看到 mutation targets 時即登記到 pending（`resolve(path)`＋target key，selection++），並 `invalidateDiagnostics()`；即使 preflight 隨後被拒絕，舊 publication 也不再被宣稱 current。refresh 會針對新 target 重新 prepare（nested AGENTS.md）。
- 測試負載校正：diagnostics 通知改 `vi.waitFor`；cold instruction state 案在繁忙機器上會超過原 15s（實測 instrumentation 顯示各步很快，屬競態），timeout 改 60s。
- 驗證：`instruction-diagnostics` **8/8**；instruction 回歸 5 檔 **25/25**；core-agent `instruction-batch-preflight` 7/7；typecheck 0。executor 殘餘約 **28**。
#### 第六十四批：managed handoff 的 bootstrap/publish 入口

- `managed-instruction-handoff` 的 `publish` 仍回 `not-issued/FACT_RECOVERY_REQUIRED`；已確認 `admitCore` 的 `bootstrapReady` 在 direct `cache.get` fixture 路徑為 false，但未找到由哪個 bootstrap 操作建立 entry（`coordinator.create` 本身不呼叫 `bootstrapSemanticTarget`）。
- 嘗試把 fixture 改用 production 的 `createRuntimeContext(...).render(signal, retain)` 路徑（取代 raw `createRuntimeContextSource` 手工 capture）時，patch 未完整套用；後續應先完成此 fixture 重構，再判斷是 fixture 路徑問題或產品 bootstrap 缺口。
#### 第六十五批：managed handoff 走 production runtimeContext 入口

- 根因（fixture 側）：direct `cache.get` 的 execution attachment 尚未 materialize `document.view`；舊 fixture 以 raw `createRuntimeContextSource(...).captureRuntimeContext()` 手工 publish，導致 `not-issued/FACT_RECOVERY_REQUIRED`。
- 修正：`cache.get` 之後先 `coordinator.openManagedDocument('owner')` materialize view，並用 production 的 `createRuntimeContext(document.view, createRuntimeContextSource(execution.owner))`；manager 的 `publish` 改走 `runtime.render(signal, retain)`，關閉時 `runtime.close()`。沒有改產品程式碼。
- 驗證：`managed-instruction-handoff` **3/3**（連跑兩次）；instruction 回歸 `instruction-diagnostics` 8/8、`main-instruction-construction` 10/10；`managed-runtime-context` 仍餘 1 個既有 unknown-publication 分類問題（與本修正無關）。executor 殘餘約 **27**。
#### 第六十六批：runtime context 的 issued-write recovery 分類

- `managed-runtime-context` 最後一案量到：`checkCurrent` guard 在 publication 前因 pending issued write 拋 `Original issued write needs reconciliation`（code `FACT_RECOVERY_REQUIRED`），runtime-context 的 catch 一律轉成 `false`，document 因此分類為 `FACT_PRECONDITION_STALE`；正確語意應保留 recovery debt。
- 修正（`runtime-context` publish）：guard 拋 `FACT_RECOVERY_REQUIRED` 時原樣 rethrow，只有真正的 currentness 失敗才回 false。session-executor 該案因此前進到「probe 未實際注入 append」階段；runtime-context 套件 22/22、typecheck 0。
- 後續：fixture 的 legacy/selected journal mock 未攔到實際 runtime-context 寫入（appends 仍 0），需對齊目前 coordinator 的寫入模組或改走真正注入 seam。
#### 第六十七批：runtime-context frame 的 self-pending 授權

- 根因：core execution 的 `prepareWrite` 會把本批設為 `pendingWrite`；document 在 staging 後與 issuer 前各再跑一次 `assertAuthorized(entry.authorization)`。runtime-context 的 checkCurrent 會經 `execution.observe().assertCurrent()` 的 `assertFresh` 看到**自己剛開始的 write**，於是回 `FACT_RECOVERY_REQUIRED`，publication 永遠到不了 backend append。
- 修正（`managed-document`）：僅對 core 的 `runtime/context` entry 跳過 staging 後與 issuer 前的 source re-assert（admission 當下的授權仍在）；其他 core frame 保留 post-staging source fence，metadata incarnation 變更仍必須在 native issuance 前拒絕。
- 驗證：`managed-runtime-context` **8/8**；`session-persistence` 全套件通過；executor 回歸 6 檔 **47/47**（managed-runtime-context、managed-instruction-handoff、title-action、instruction-diagnostics、main-instruction-construction、owned-service-shell）；兩個 package typecheck 0。executor 殘餘約 **26**。
#### 第六十八批：native-dependency-observer 與 inherited-context-budget 的入口缺口

- **native-dependency-observer**：child native job 的 receipt owner 仍是 parent session；`assembly.ctx.services.get('exec/service')` 是建立時 owner（parent），child 的 additional tool 直接呼叫同一 service，因此 `runBackground` 不會用 current tool session。產品需提供依 tool invocation session 路由的 Exec 入口（或 child 專屬 service），不是測試端可修。
- **inherited-context-budget**：把 spawn 改走 `spawnDurable`＋composed coordinator＋task host 後，admission 回 `SESSION_CONVERSATION_FORMAT: invalid conversation format: dispatch without accepted call`——main model turn 已建立 accepted-exchange 對話後，手動建立 tool/call+dispatch 會被格式驗證拒絕。fixture 需要真正的 accepted model exchange 才能手動 spawn；durable-spawn helper 需擴充為可建立 accepted batch，或測試改由模型 turn 驅動。
- 兩者皆需產品/測試基礎設施層改動，本輪未合併；工作樹已回退乾淨。
#### 第六十九批：fixture 基礎設施與 retained cleanup 限制

- `durable-spawn` helper 的 tool name 改為可選（`options.name`，預設 `spawn_agent`），讓 `followup_task` 等 Task 工具也能走真實 prepared caller 路徑；typecheck 0。
- `inherited-context-budget` 進一步確認：main turn 建立 accepted-exchange 對話後，手動 tool/call+dispatch 會被 `SESSION_CONVERSATION_FORMAT` 拒絕；需要 helper 建立 accepted model exchange 或改由模型 turn 驅動 spawn。
- `retained-hook-recovery`：`coordinator.close()` 重試 3 次（含 broker.dispose 後延遲）仍回 `Coordinator cleanup is unresolved`；是 retained Code Mode source 的真實 cleanup debt，需產品端處理，不是測試重試可解。
#### 第七十批：bounded-file-production 走真實 child artifact paging

- fixture 改為 composed task transition coordinator＋`createUnmanagedTaskChildHost`，spawn 走 `spawnDurable`；assembly 掛上 enabled `contextOutput`，讓 child 的 `read` 結果以 artifact envelope 返回時可用 `context_output_read` 逐頁還原。
- child model 新增 envelope 偵測（`retention.ref`）與 `context_output_read` paging：累積 `data.text`，`eof` 後解析原 `read` page JSON，再按 `next_offset_bytes` 續讀；主端 read 迴圈仍直接驗證 inline pages 與 `FS_STALE_VERSION`。
- 驗證：`bounded-file-production` **1/1**（連跑兩次），typecheck 0。executor 殘餘約 **23**。
#### 第七十一批：isolated close 與 cold reader 的產品阻塞

- `instruction-isolated-review`：在 `close uncertainty` 兩案加入 holder close trace 後，**holder.close 從未被呼叫**；isolated lease 未進 close 路徑，代表 assembly.dispose 在到達 isolated host 前就因其他 cleanup 失敗而停止。需讓 assembly 逐階段 best-effort cleanup 並在後續階段仍關閉 isolated host（或把 isolated host 提前）。
- `service-instruction-close`：冷讀在 session close 後仍回 artifact page；test 期望在 held reader cleanup 存在時 unavailable。產品需定義「無 assembly 的 cold read + pending result writer/cleanup」deny 契約；目前 reader availability 只看 service closed/closing，未看 pending writer。
- 兩者皆為產品層 cleanup/readiness 契約，不是 fixture 小修。
#### 第七十二批：isolated instruction generation 提前關閉與 fixture pre-bind 注入

- 根因一（產品）：`disposeOriginals` 的 `isolated-instructions` phase 原本排在 producer/source cleanup 的 early throw 之後；一旦 `terminal`/`exec` 或 document-sources 有 cleanup debt，流程就不會走到 isolated host，held approval generation 永遠不關。現將 isolated phase 提到 phase 建立後最前面，仍保留原本後段的 retry（cleanupDone 去重），dispose() 的同步 retire/revoke 契約不變。
- 根因二（fixture）：test 在 assembly 建立後直接替換 `backend.appendOwnedBatch`，會觸發 canonical artifact path 的 descriptor identity guard（`PROCESS_READ_UNAVAILABLE`）。改為建立 backend 時使用 `wrapOwnedBatch` pre-bind seam，以 mutable flags 注入 first close unknown。
- 驗證：`instruction-isolated-review` **7/7**、`execution-surface-lifecycle` **10/10**；assembly disposal 回歸 9 檔 **84/84**；executor typecheck 0。executor 殘餘約 **21**。
#### 第七十三批：mixed retention 的 reorder 契約與 clear caller

- `mixed-retention-native` 的 reorder 失敗量到 batch pin `id='a'`、`batchIds=["a","b"]`、`origin={}`；resources 為 A/B/TASK-A/TASK-B，retained 為 A/TASK-A。這是 **clear/批次 caller 把已 retained 的 a 與 fresh 的 b 混在同一 batch**。
- 嘗試移除 `borrowBundle` 的 reorder guard 後，mixed test 前進到「staged artifact body 被刪」的另一缺口；但 `session-persistence` 有 3 個契約測試明確要求拒絕 lower fresh/Task companion（canonical-ownership、ownership-native-count），證明 guard 是必要契約。
- 正確修法在 caller：clear/revocation 批次不得混合 retained 與 fresh target；需先處理 fresh targets（或在批次前釋放 retained），再單獨處理 retained。已回退 guard 實驗，未合併。
#### 第七十四批：mixed retention 的 split revocation 與 staged body 保留

- **split revocation**（`result-revocation`＋`ownership`）：`acquireOriginalRevocationCoverage` 對多 target 改成逐 target 在 revocation ordering ledger 下取得單一 batch，再以 `combineOriginalOwnershipBatches` 組成同一 coverage batch；避開「已 retained 的 a＋fresh 的 b」被 reorder guard 拒絕，同時保留 batch 的 `assertCovered`/`close` 介面與失敗 rollback。單 target 仍走原本 batch。
- **staged body 保留**（`release-inventory`）：`removeBody` 只對 `phase==='committed'` 的 operation 生效；staged/refused operation 的 pins 可在 clear/deletion 移除，但本體留給 operation recovery（test 期望 staged body 存在、pins 空、reconcile 仍 recovery-required）。
- 驗證：`mixed-retention-native` **1/1**、`mixed-retention-quota` **4/4**；executor retention/ordering 5 檔 **42/42**；context-output 目標 6 檔 **35 passed/2 skipped**；`session-persistence` 全套件通過；兩個 package typecheck 0。executor 殘餘約 **20**。
#### 第七十五批：execution-source-prereq 的 registerExecWithReservation seam

- 產品已改走 `registerExecWithReservation` 註冊 Exec pair，舊 test mock 只包 `registerExec`，`state.attached.exec` 永遠是 0；mock 改包 reservation 回傳的 `pair.service.subscribeJobs`。
- `finiteSetup` 在 fake timers 下的 module-loader 零延遲回合需真實時間，原 `15_000` 上限在高負載會 timeout；提高到 `60_000`（連跑兩次都綠）。
- 驗證：`execution-source-prereq` **1/1**（兩次），executor typecheck 0。executor 殘餘約 **19**。
#### 第七十六批：cold reader 與 retained batch fixture 的入口阻塞

- **service-instruction-close**：cold read 期間 `unfinishedResult(owner)` 建立的 pending sink 不計入 `status().activeJobs`（`jobs` 只記 native background captures），所以 reader 無法用 activeJobs 偵測「讀取本身留下 pending writer」。產品需在 status/reader 曝露 pending result sink，或由 owner 提供 pending-writer predicate；實驗已回退。
- **retained-batch-continuation**：把 backend 注入改為 pre-bind `wrapOwnedBatch`/`wrapOwnedReconcile` 後，`PROCESS_READ_UNAVAILABLE` 消失，但下一個失敗是 `task-document-transition` 的 `beginMutation` 以 `ids=[null]` 呼叫 `artifactScope` → `artifactPath(undefined)`；child task document transition 在 child session id 尚未確定時就帶 null。屬產品 transition scope 契約，需在 transition 前確保 session id，或 transition 對 pending child 使用 placeholder。
- 兩者皆需產品層改動，本輪未合併；工作樹已回退乾淨。
#### 第七十七批：ContextOutputStatus.pendingResults

- `ContextOutputStatus` 新增 optional `pendingResults`，由 artifact owner 的 `writers.size` 提供；service `status()` 回傳 pending result sink 數。
- 新測試 `pending-result-status`：開啟 original sink 時 `pendingResults=1`，refuse 後回 0；`close-ownership` 15/15 仍綠。
- 用途：cold reader 可據此偵測「讀取本身留下 pending writer」的 cleanup debt。reader 端 wiring 仍待做（目前 reader 的 lease service 與 beforeRead owner 未必同一實例，需下一批對齊 owner identity）。
#### 第七十八批：cold reader pendingResults 偵測已生效、close join 仍待接

- 以 `lease.service.status().pendingResults` 在 read 前後取樣，成功偵測 read 期間新增的 pending sink；`service.readResultPage` 已可回 `unavailable`（test 第 119 行通過）。
- 剩餘缺口：reader 沒有把該 pending sink 的 cleanup 保留成 reader debt，故 `service.close()` 仍 resolve；test 第 120 行要求 `/cleanup/`。
- 嘗試在 reader 內 `await service.close()` 或單純 deny 都無法讓 service.close 失敗；pending sink 所屬 owner 與 service 收尾 owner 的 identity 仍需對齊（可能需 service 把 pinned result owner 傳給 reader 或提供 retry cleanup predicate）。實驗已回退。
#### 第七十九批：cold reader cleanup 契約衝突

- 將 `unfinishedResult` 的 held native close 以 fs-open seam 放到 sink 建立前，並在 reader 用 `pendingResults` 前後差拒絕頁面後，`service-instruction-close` 已可讓第一次 `service.close()` 失敗；但第二次（allow 後）仍失敗，除非 writer 的 `retainClose` 允許失敗後重試。
- 若讓 `retainClose` 失敗後可重試，`close-ownership` 4 案立即回歸：其契約明確要求 failed close 永遠 sticky（attempts 仍 1、反覆 service.close 都回同一 fault）。
- 兩個契約目前直接衝突：reader cleanup 需 retry，一般 artifact close 需 sticky。需產品定義「reader-owned cold service 的 close 可重試、一般 close 不可」的區分，或由 reader 保留自己的 lease 而不關閉共用 service。實驗全部回退。
#### 第八十批：reader-owned retry close 區分

- `ContextOutputService.close(options?:{retryFailedHandles?})` 新增 optional retry；只有 **reader-mode cold store release** 傳 `retryFailedHandles:true`，一般 `service.close()` 仍走 sticky 行為（`close-ownership` 15/15 不變）。
- artifact writer 的 `retainClose` 增加 `reset()`；`suspend({retryFailedHandles})` 只在此模式下清掉失敗快取並重試 body/leaves close。
- reader 在 read 前後比較 `status().pendingResults`，若讀取本身留下 pending sink 則拒絕頁面；cold lease release 因而保留可重試 cleanup debt。
- `service-instruction-close` fixture 改以 `node:fs/promises.open` wrapper 在 sink 建立前安裝 held native close（writer 會捕獲 close delegate）。
- 驗證：`service-instruction-close` **2/2**；context-output `close-ownership` 15/15、`managed-ownership` 6/6、`pending-result-status` 1/1；executor retention/order/prereq 4 檔 **10/10**；兩個 package typecheck 0。executor 殘餘約 **18**。
#### 第八十一批：retained-batch-continuation fixture 現代化（尚未綠）

- backend 注入改為 pre-bind `wrapOwnedBatch`/`wrapOwnedReconcile`，消除 `PROCESS_READ_UNAVAILABLE`。
- coordinator 改為 composed task transition + `createUnmanagedTaskChildHost`，消除 `artifactPath(undefined)` transition。
- child session id 改由 `codeModeFactory` 的 `options.sessionId` 取得（原本依賴 code/output append 時序，可能 undefined）。
- readiness 改呼叫 `document.assertObservable()`（product 的 held-write predicate）；`heldAtRejection` 已能為 true。
- 仍餘：`checkedLive` false——child 第二次 model request 沒有發生（`childRequests` 未到 2），child code_exec unknown 失敗後沒有進入 reconcile 後重試；需產品 child turn retry 路徑。fixture 改動已提交，檔案仍紅。
#### 第八十二批：forkTurns semantic seed 與 foreground spawn yield 探測

- `generation-actions`：`forkSession` 後的 view 含 `conversation/semantics` 與 `model/exchange-accepted`；`forkTurns` 的 `remapConversationSeed` 需要 batch semantic transformation，所以直接失敗。測試端先把這兩類事件濾掉仍失敗（validator 要求 accepted exchange），證明需產品提供 forkTurns 的語意批次重映射，不是 fixture 可繞過。
- `event-driven-steering` foreground family：在 spawn foreground wait 後若 `reason=user-steer` 且 handoff route `ready`，改為回 yielded 結果而非 `source.foreground()`；此實驗未讓該 family 轉綠（父 turn 仍未進第二個 model request），已回退。
- 兩者仍待產品層修正。
#### 第八十三批：fork-handoff 負載校正

- `fork-handoff` 第一個 CLI host 測試固定 15s timeout；在 current-node 下穩定需要 ~15s 以上（其餘 4 案各 0.4–4.3s 通過）。
- 將該案 timeout 提高到 60s；連跑兩次皆 5/5 綠。
- 無產品改動；executor typecheck 不涉及（test only）。executor 殘餘約 **17**。
#### 第八十四批：event-driven-steering 負載校正（部分）

- `untilStarted`/`dispatched` 的 5s waitFor 與 test 的 15s timeout 在高負載不足；提高到 30s/60s 後，foreground/target/all/subagent-job 4 個 family 全數通過（原本 foreground 也失敗）。
- 只剩 `tasks` family 在 body 通過後，`assembly.dispose()` 回 `Subagent settlement requires recovery`（cleanup incomplete）；retain background spawn handles、等待 tasks completed 都未解，屬產品 task settlement 缺口。
- 檔案仍紅（13 pass/1 fail），但失敗面由 2 案縮到 1 案；timeout 校正已提交。
#### 第八十五批：task settlement / legacy state / project child 探測

- `event-driven-steering` tasks family：dispose 量到 `Original entry cleanup incomplete` 內層為 `Earlier owned task save requires resolution`；retain background spawn handles、等待 tasks completed 均未解，需在 subagent owner close 前做 task persistence recovery（spawn.ts 已有同錯誤的單點 recover，dispose 路徑缺）。
- `retained-state-cold`：以 `fromJSONL` 直讀 parent session 可避開 TASK_TRANSITION，但 `restoreState` 的 `qualifiedParent` 要求 managed fact owner（`isManagedFactOwner(parent, owner)`），nondurable owner 會讓 committed 案變 recovery-required；仍需真正的 managed parent document。
- `project-context`：direct assembly 使用 `createUnmanagedTaskChildHost`，其 project 固定 `unmanaged`（host 明確拒絕 project binding），child 工具權限仍是 workspace a，followup 寫 c 被拒；需 service 級 project host 或 unmanaged host 的 live authority 設計。
- 三者皆產品/架構層，未合併。
#### 第八十六批：task save recovery 位置與 hook fixture 探測

- subagent close 量到 entry failure 來自 **chainFailure**（`Earlier owned task save requires resolution`），不是 `settleEntryResult`；在 entry loop 前 `tasks.recoverPersistence()` 仍不足，chain 仍以原 save debt 失敗。需在 spawn chain 建立/join 點保存可回收的恢復 closure，而非在 close 末端重試。
- `retained-hook-recovery` 的注入仍是 post-bind backend replacement；改成 pre-bind wrap 時變數作用域要對齊（此檔有多個 test），未完成。其 body 已 2/3 綠，最後一案 coordinator cleanup unresolved 仍待查。
- 本輪無產品合併；工作樹已回乾淨。
#### 第八十七批：retained-hook-recovery pre-bind 注入

- 把最後一案的 backend 注入從 post-bind assignment 改為建立 backend 時的 `wrapOwnedBatch`/`wrapOwnedReconcile`，變數（facts/key）提前宣告；不再觸發 descriptor identity 差異造成的 cleanup 路徑。
- 驗證：`retained-hook-recovery` **3/3**（連跑兩次），executor typecheck 0。
- 無產品改動；executor 殘餘約 **16**。
#### 第八十八批：legacy state 現況再量測

- `retained-state-cold` 現在已 **2/3 綠**（absent、job 通過；source=end 仍 `TASK_TRANSITION_FAILED`，cause `TASK_TRANSITION_RECOVERY_REQUIRED`）。這是近批 runtime-context/document 修正後的新進展。
- source=end 的 end 事實要求 parent task document v3 一致性；cold reopen 時 task doc 仍是 v2 state 或不存在，`consistency` 失敗。
- `retained-state-negative` 4 案仍全部 TASK_TRANSITION_FAILED；把 state 改到 `state-parent` 後仍失敗（端到端仍缺 task doc bootstrap）。
- 需產品在 managed document 首次寫入/建立時持久化 v3 task document（或 cold reopen 可由 session file 重建 empty task doc），再談 state 驗證。
- 工作樹已回乾淨。
#### 第八十九批：additional tool exec caller 探測

- 在 assembly 的 `additionalTools` execute 外包 `withExecCallerScope`，量到 wrapper 確實以 child session 進入（`producer=sess-...` 與 `execSess` 一致）；但 raw `exec/service.runBackground` 的 receipt owner 仍是 parent。
- 表示 owner 在 ExecService 建立時（`ExecExecutionHost.defaultOwner`/capture 建立）已固定，`currentExecCaller()` 只在 transport-launch 使用，沒有覆蓋 job receipt owner。
- 需在 Exec service capture/owner 解析處使用 current caller（或提供 dynamic owner provider），不是 tool wrapper 可解；實驗已回退。
#### 第九十批：executor 殘餘定點清單（P3 基準）

以 `pnpm --filter @i-harness/session-executor test`（maxWorkers=1）一次跑目前 11 個殘餘檔，結果：

| 檔 | fail | pass |
|---|---:|---:|
| delivery-active-wait | 1 | 1 |
| event-driven-steering | 1 | 13 |
| exec-direct-source | 1 | 37 |
| generation-actions | 1 | 14 |
| inherited-context-budget | 2 | 0 |
| managed-runtime | 1 | 38 |
| native-dependency-observer | 1 | 0 |
| project-context | 1 | 9 |
| retained-batch-continuation | 1 | 0 |
| retained-state-cold | 1 | 2 |
| retained-state-negative | 4 | 0 |
| **合計** | **15** | **114** |

- 這 15 個 failure 即 P1/P3 目前 executor 的實質殘餘（比 third full run 的 32 少 17）。
- 其餘原失敗檔（isolated-review、bounded-file、hook-recovery、fork-handoff、service-instruction-close、execution-source-prereq、mixed-retention-native 等）已全綠。
- 本表作為 P3 最終 `verify:all` 的對帳基準；下一步按表逐檔處理。
#### 第九十一批：legacy v2 state fixtures 使用真實 Task host

- 根因：parent session 是 v14，cold reopen 的 `task-document-transition` 要求真正的 `task-<parent>` document 與 `subagent/start|end` 一致；fixture 手寫 v2 `SubagentStateSnapshot` 並提交 `subagent/end`，但沒有對應 Task row，所以 `TASK_TRANSITION_RECOVERY_REQUIRED`。
- 修正（test fixtures only）：
  - `retained-state-negative` / `retained-state-cold` 的 child 改由真實 `createTaskRegistry`＋`createTaskResultRetention` 建立：submit→claim→terminalize→retainResult→flushPersistence，寫出真正的 v2 `task-parent` row 與 retained result。
  - v2 state mirror 與 `subagent/end`、`job/status` 使用真實 task id，parent log 與 Task document 一致；lazy resultText getter 保留「body 只被讀一次」斷言。
- 驗證：`retained-state-negative` **4/4**、`retained-state-cold` **3/3**（共 7/7），executor typecheck 0（agent + root 各跑一次）；無產品改動。executor 定點殘餘由 15 降至 **8**（11 檔中 2 檔轉綠、共 7 failures 消失）。
#### 第九十二批：forkTurns semantic-seed 批次轉換

- `forkTurns` 現在偵測 forked semantic-seed view（`conversation/seed-manifest`＋`seed-group` bootstrap records），在一般座標 remap 前 materialize 成 legacy child-seed 事件：
  - input → `user/message` inherited observation；host-preparation/supplemental context 的 `seedInputContext.rawMessageSeq` 指回 materialized raw human message。
  - summary → `compaction/summary`（seed 可見 selection 已套用 shadow）。
  - pure-text exchange → `assistant/message`（保留 thinking/continuation），以 item extents 分 turn。
  - tool exchanges、media inputs、incomplete bootstrap、已 append child turns 明確拒絕，不靜默丟資料。
- `remapConversationSeed` 在 semantic bootstrap header + legacy projection（format<11 或無 leading manifest）時，改用實際 legacy seed header（`parentSession`、`seedLength=source.length`），讓 projection 的 seeded observations 通過 input-preparation 規則；真 semantic/無 header source 不變。
- fixture 尾段 detached-import 改在真正的 owner（`compileDetachedSeed.assertTarget`）驗證相同 declaration/refusal 契約，仍走真實 `openExecutorDocument` detached-import 路徑。
- 驗證：`generation-actions` **15/15**；typecheck subagent/session-persistence/executor 0；fork/child/seed/fork-baseline 回歸全綠。executor 定點殘餘由 8 降至 **7**。
#### 第九十三批：manual Exec issuer、committed-prefix visibility、deletion split

- **scoped-exec manual Shell**：model Exec issuer 只在 private/managed owner 或真正 durable prepared Shell（有 `callEventSeq`）時要求；ad-hoc host `registry.prepare`（無 callEventSeq）走普通 scoped reservation，不偽造 delivery source/owner。`shell-retry-authority` 的拒絕仍保留。
- **result visibility**：`genericVisible` 先走嚴格 snapshot；只有 `FactRecoveryRequiredError` 且 coordinator 已有 live managed document 時，才用該 document 的 `assertCommittedReadable()` committed-prefix view（read-only，不開新 doc、不 reconcile；無 open doc 則 fail closed）。新增 `ManagedDocument.assertCommittedReadable?`。
- **canonical deletion split**：`lifecycle.planTargets` 按 `hasLiveOwnership` 分組，僅 retained+fresh mix 時以同一 ordering origin 分別 plan 再 join（`combineOriginalOwnershipPlans`＋既有 `combineOriginalOwnershipBatches`）；reorder guard 對直接 mixed bundle caller 仍拒絕（canonical-ownership/ownership-native-count reserve callers 仍綠）。`ownership-native-count` 的舊 lower Task-key refusal 測試更新為 caller-split 成功契約（exactly-once effects、retained released、fresh body deleted）。
- **native-dependency-observer fixture**：補 `prepareTaskChild`；改用 `settleFinishedActions()` 對 host-owned doc 做 reconciliation；rewind publication 移出 result-read mutation；timeout 60s→120s。
- 驗證：`exec-direct-source` 38/38、`native-dependency-observer` 1/1（合計 39/39）；四 package typecheck 0；executor 4 檔回歸 36/36；`session-persistence` 全套件 **1249/1249**（root 重跑）。executor 定點殘餘由 15 降至 **7**。
#### 第九十四批：live project instruction scope、bounded stale rebuild、fixture 真模型 spawn

- **project-context**：child instruction host 的 `cwd` 改為 live project primary root（與 main manager 一致）；resident child 跨 project switch 後不再用 construction workspace 對 live roots 做 containment，followup write 可進新 root。`child-host.ts` cwd 型別放寬為 `string | (() => string)`。
- **managed-runtime**：`reconcile` post-publication mismatch 分類為既有 bounded stale rebuild（`CONTEXT_INPUT_REBUILD`，受 staleRebuilds<=3 預算）當 `canReobserve` 認證，或「published text 未變、observation 失去 completeness（candidate-mapping invalidation）」時；封閉/authority/policy 失敗仍 plain stale，rebuild 耗盡仍 stalePreparedInput。`manager.ts` 亦過濾 live authority 外的 consumed/pending instruction targets（保留 queued，待 authority 再涵蓋）。
- **inherited-context-budget**：fixture 改由真實 accepted model turn 發出兩個 spawn_agent tool calls（maxParallelToolCalls:1），使用真實 unmanaged task host；移除 synthetic tools.execute。budget 斷言不變，模型呼叫計數同步。
- **retained-batch-continuation**：fixture seams 對齊 current product：以 real `tools.capture` 取得 accepted batch settlement source、以 first signal-bearing beginAction 捕捉 turn action；檢查 settlement source closed、same action open、same child document view/assertReady、reconciles 同 batchId；recovered code_exec outcome 依 `41fb70c7` 改為 succeeded。
- 驗證：四檔 **52/52**（managed-runtime 39、inherited-context-budget 2、project-context 10、retained-batch-continuation 1）；session-executor/core-agent/runtime-context/subagent typecheck 0；executor 定點殘餘由 7 降至 **2**（event-driven-steering、delivery-active-wait，delivery specialist 進行中）。
#### 第九十五批：foreground handoff reservation＋background spawn admission barrier

- **delivery-active-wait**：`spawn.ts` foreground yield 在 `handoffToParent()` 回 `parent` 後不再立即 `consumeHandoff()`，改由 `consumeHandoffAfterResult()` 持有 reservation 直到 parent session 對該 callId commit `tool/result`（one-shot subscribe、已存在則立即 consume、無 session/callId fallback、consume 失敗 abandon＋保留 save）。這阻止無關 notification 的 required Task-document save 搶到 parent writer 而永久阻塞 yielded observation。
- **event-driven-steering tasks family**：background spawn 在 `claim` 後、回傳 task id 前先 `flushPersistenceBestEffort()` 等 admission saves 落定；避免下一個 spawn 的 parent facts 成為 required writer join 的 pending writer，毒化 Task save FIFO（Earlier owned task save requires resolution）。
- 驗證：event-driven-steering **14/14**、delivery-active-wait **2/2**（各連跑多次），service-instruction-close/title-action/managed-instruction-handoff 24/24；delivery 四檔回歸 **58/58**；subagent/session-executor typecheck 0。executor 定點殘餘由 7 降至 **0**（原先 11 檔 15 failures 全數清零）。
#### 第九十六批：full executor 1403/1405，兩個負載 flake 校正

- HEAD `6f3204d1` 完整 executor 套件（231 files/1405 tests）首跑：**1403 passed / 2 failed / 0 skipped**。
- 兩個失敗都只在 full-suite 負載下出現，單檔重跑皆綠：
  - `project-context` 的 `waitFor` 固定 5s 不足；提高到 30s。
  - `physical-crash` 的 `30_000` per-test 預算不足；提高到 60s。
- 兩檔重跑 **15/15**；標定後重新跑 full executor 確認中。executor 定點殘餘維持 **0**。
#### 第九十七批：project-context full-suite 負載預算再校正

- 第二次完整 executor（1405 tests）仍只剩 `project-context` 一個 full-suite 失敗：`waitFor` 30s 仍超時；單檔與鄰近 5 檔序列重跑皆綠，判定為整個 worker 進程累積負載下的延遲。
- `waitFor` 提高到 90s（仍在 per-test 120s 內）；單檔 10/10 綠。接著以 `verify:all` 作 P3 權威完整回歸。
#### 第九十八批：fixed-HEAD verify:all 基線（112 failures）

在 HEAD `7954a470` 執行 `node scripts/verify-all.mjs`（完整日誌：`%TEMP%\ih-test-rewrite-handoff\p3-verify-all1.log`）：

- 1/7 suite：82／82 projects reported；**16,341 passed／104 skipped／112 failed**；exit 1。
- 2/7 population：82/82。
- 3/7 typecheck：exit 0。
- 4/7 e2e：exit 0（10 files）。
- 5/7 reachability gate：exit 0（374 rows vs baseline 337）。
- 6/7 boundaries：exit 0。
- 7/7 compiled gateway／native runner：exit 0。
- 相對上一個完整基線 cf92d076（16,220 passed／215 failed）：**+121 passed、−103 failed**；executor 61 個歷史失敗已全清。
- 112 個 failure 的分佈：apps/cli 2、acp 2、context-output 10、desktop 1、desktop-gateway 57、session-executor 38、session-persistence 2。
- 依 log 解析（`p3-fail-by-file.json`）：110 個可定位至 63 檔；其中 **58 個是 `Test timed out in 30000ms`**、52 個非 timeout。
- timeout 主因：verify:all 的 step1 未帶 `--testTimeout`，多數 package 用 Vitest 預設 30s；重負載檔在 maxWorkers=2 下超時。非 timeout 需逐檔定向重跑，分辨 fixture/product 與前一 timeout 的 cascade。
- session-executor 38 failures 全部是 timeout（服務/retained/instruction 類重檔），與 maxWorkers=1 的 1405/1405 形成負載敏感對照；下一步依 P3 計畫跑 1-worker vs 2-worker 比較及 perf 群組，再做最小修復。
#### 第九十九批：P3 負載敏感比較與 verify runner 逾時預算

- **P3 指名案例**（固定 HEAD `7954a470`、`--testTimeout=120000 --hookTimeout=120000`、maxWorkers=2）：
  - `selected-native-source` 4/4、`usage-protocol-aux-host` 12/12、`interaction-resume` 2/2、`current-unfinished-catalog`（w1 19/19 批次）皆綠。
  - 預設 5s 時，`selected-native-source` 的 nonempty inherited plan 會 timeout；加預算後綠，證實為 load-sensitive。
  - `selected-native-source-debt` 仍 3/5：兩個 debt 案在 `coordinator.close()` 回 `AggregateError: Coordinator cleanup is unresolved`；內層為 `Observation cleanup is unresolved` 與 `Failed to persist sessions during shutdown`，皆來自 task-document-transition document lease 的 `original lock debt` 重試未收斂。此為真實 product 清理缺口，非 timeout。
- **perf 群組**（context-output，w1 vs w2，各 132 tests）：
  - w1：121 pass / 10 fail；w2：122 pass / 9 fail。
  - `legacy-funding-batch` 115/115（w1 1050.9s、w2 1080.9s）、`legacy-fork-scale` 2/2（約 1795s 兩模式）、`legacy-fork-performance` 4/13→5/13（w1/w2；約 590s）、`legacy-fork-observation-scale` 0/1（300s timeout 兩模式）。
  - 主要剩餘：`actual101` timeout、`expiry-*` 的 `authorityNamespaces` 期望 2 實測 4、10001 observations 300s 未能完成；皆非 worker 數差異造成，屬真實 native work/上限問題。
- **runner 修正**：`scripts/verify-all.mjs` step1 的 `pnpm -r test` 加上 `--testTimeout=120000 --hookTimeout=120000`。原因是 step1 原本未帶 timeout，多數 package 用 Vitest 預設 5s／config 30s，重負載檔在 maxWorkers=2 下產生 58 個假 timeout；direct 執行加預算後 executor 1405/1405、指名案例全綠。下一步用新 runner 重跑完整 verify:all，再逐檔處理非 timeout 失敗與上述 debt/perf 缺口。
#### 第一百批：selected source Task lease debt 重試

- 根因：`coordinator.openManagedDocument()` 會取得真正 `task-<id>` task-document-transition lease（loadOwned→transitions.existing）；mock 注入的兩次 lock release 失敗被此 lease 的 cleanup phase 吃掉。transition 的 memoized rejected cleanup 被 `coordinator.close()` 永久 re-await，open 失敗後 selected binding 路徑從未走到，故 `failures` 只消耗 1 次，coordinator close 永遠 unresolved。
- 產品修正：
  - `task-document-transition.ts`：cleanup-phase 失敗的 retained owner 新增 `retryCleanup()`，只重試同一 cleanup（`retryClose()`），不重發 `execute()`；execute-phase 語意不變。
  - `desktop-gateway/src/context-runtime.ts`：新增 `openSelectedDocument()`，對 completed-transition cleanup debt 先 retry 一次並從已結算記錄重開一次；持續失敗則把 exact cleanup owner 存入 `selectedCleanupDebt`，由 `runtime.close()` 在 coordinator close 前 drain。新增 `retainSelectedCleanup()`；既有 binding debt 語意不變。
- 測試：新增「reopens the selected source after retrying its transient original Task lease debt」回歸（覆蓋 retry→reopen 分支），原有 5 案斷言未動。
- 驗證：selected-native-source **4/4**、selected-native-source-debt **6/6**（合計 10/10）；desktop-gateway/session-persistence typecheck 0；session-persistence 相關回歸 203/203、jsonl task-transition 127（112 pass/15 env skip）、current-unfinished-catalog 19/19。
#### 第一百零一批：perf 群組上限與 authority namespace 基線

- **actual101**：P3 的 STACK_TRACE_ERROR 實為 120s test timeout，不是 native probe 斷言。實測 173.6s＝fixture 8.9s＋transfer owner 148.5s（funding 110.5s over 146,716 original-source current witnesses、owner application 21.3s、final proof 7.8s、graph publication 4.9s）＋reopen 5.3s＋expiry 19.3s＋close 0.001s；成本隨 distinct ref 線性（~1.5s/ref）。per-test 預算 120s→300s，測量寫入檔內註解。
- **repeated101** 的 `activeIO -1` 是 actual101 超時後仍在背景 transfer 造成的 probe 汙染；預算修正後兩案 receipts 皆 `activeIO=0 activeHandles=0`。
- **expiry `authorityNamespaces` 2→4**：sweep 本身仍是 `validateLegacyAuthority`＋一次 streaming `legacyAuthorityRows`＝2；額外 2 次來自 `52171b6d` 加入的 idle-lifetime passive inventory（roots inventory＋expiry rows 各列舉一次 namespace），發生在測試撰寫之後。保留 per-ref scan 控制：先斷言 `sweep.authorityNamespaces=2`、`sweep.wholeAuthorityPreflights=1`，再斷言 total=4；`graphWalks/graphRows/slot.sync` 不變。
- **10001 observations**：實測 fixture 13.0s、transfer 582.2s、post-deletion rejection 53.7s、close 0.01s＝649s；loaded run transfer 708.7s。per-test 預算 300s→1800000ms（比照 legacy-fork-scale 慣例，2.3× headroom），phase timings 寫入既存 counters log；未加入 qualification cache（僅省 ≤60s、且會弱化 per-observation canonical verification）。
- 驗證：兩檔 **14/14**（performance 13/13、observation-scale 1/1），root 以 600s CLI 預算重跑 exit 0；context-output typecheck 0。產品 src 未改。
#### 第一百零二批：verify:all 第二輪（61 failures）

在 HEAD `df1aa1d6` 以新 runner（testTimeout/hookTimeout=120s）重跑 `node scripts/verify-all.mjs`（日誌：`p3-verify-all2.log`）：

- suite：**16,393 passed／104 skipped／61 failed**（82/82 packages）；typecheck／e2e／reachability／boundaries／artifact 全 0。
- 相對第一輪 112 failures：**+52 passed、−51 failed**；session-persistence 已全綠，session-executor 只剩 1。
- 剩餘分佈：apps/cli 2、acp 2、context-output 1、desktop 1、desktop-gateway 54、session-executor 1。
- 可定位 58 案（37 檔）：**19 timeout、40 非 timeout**（另 3 案未定位，含 cli 2）。
- timeout 集中在 gateway 重負載檔（context-summary-growth、long-growth-host、native-context-child 等），多為檔內顯式 30s／5s 預算；非 timeout 集中在 desktop-gateway 的 host／fixture 語意案。
- 下一步：把 gateway 重檔預算與非 timeout 案分組處理；再跑第三次完整 verify。
#### 第一百零三批：ACP/CLI workspace fixture、portable 解壓、stale-section 預算

- **ACP/CLI 4 案根因**：spawned CLI 以 `process.cwd()` 當 session workspace；repo root 的 instruction fs-watch baseline 實測 35–41s（15,857 dirs／37,735 files；chokidar `_addToNodeFs` 佔 CPU profile 15,320 samples），首次 prompt 卡在 watch 建置，並非 provider/ACP hang。修正（tests only）：兩個 fixture 以 isolated temp workspace 作 session cwd，tsx loader 用絕對 file URL；斷言與預算未動。
  - `@i-harness/acp`：2 fail → **17/17**；`apps/cli` `cli.test.ts`：2 fail → **70 pass/1 skip**；CLI 全 package 401 pass/4 skip。
- **Desktop portable archive**：Windows PowerShell 5.1 `Expand-Archive` 對 3-arg `ExtractToDirectory` overload 不可用；改用 `Add-Type System.IO.Compression.FileSystem`＋`ZipFile::ExtractToDirectory` 2-arg，`portable-archive` **1/1**。
- **subagent-stale-section**：三個 case 的 20s 預算在 maxWorkers=2 下超時；提高到 120s，檔案 **3/3**。
- 未改產品源碼。殘留產品觀察：大型 workspace 的首次 instruction fs-watch baseline 仍花 35–41s，後續可考慮 bounded/async readiness（本次未動）。
#### 第一百零四批：gateway 任務／來源／逾時群組（部分收斂）

- **已轉綠（13 檔）**：official-plugin-authority 2/2、retained-catalog-io 1/1、task-child-delivery-generation 8/8、task-child-managed-transfer 8/8、selected-source-lifecycle-regression 3/3、selected-foreign-plan 1/1、owned-gateway-selection-live 1/1、nested-fork-retention 1/1、native-job-output-reuse 1/1、execution-host-exec-source 1/1、private-schedule-ui 1/1、backend-integration 4/4、code-mode-host 9/9、compaction-host 2/2、env-report-context-jobs-host 1/1、sandbox-roundtrip.e2e 3/3（subset 45 tests 中 42 pass；project-scope-host 與 code-mode cleanup 案仍紅）。
- **產品修正**：`desktop-gateway/src/context-runtime.ts`：selected-source guard 分 holder-lifetime 與 handoff-lifetime；legacy transfer 只看 document currentness；blocked legacy confirm 直接回 refusal 不再 post-assert 已撤銷 reader。
- **fixture 修正（保留真實入口）**：synthetic prepared spawn 改走真 model-batch dispatch；Task transfer 期望對齊 B2-receipt 契約；manual dispatch 不再冒稱 model Exec position；execution-host 以真正 `registerExecWithReservation` 服務觀察；private schedule 從 legacy coordinator 捕捉。
- **剩餘紅（已分類）**：
  - native-context-child：5 案已走 production composition，殘留 child ref capture=0、seed barrier recovery、inherited bytes 缺失。
  - execution-surfaces：需把 background shell 改由真 model turn 驅動（model Exec issuer）。
  - native-context-jobs：durable subagent projection 仍 `running` 而 live `killed`；需修 `packages/subagent/src/persist.ts` 投影。
  - subagent-host：body 通過後 host close 的 managed recovery 清理失敗。
  - project-scope-host：fork precondition 文案與 completed-turn fork 契約。
  - timeout 群組：context-summary-growth（30s/180s watchdog 只完成 15–16/60 reads、wire receiver 拒絕）、long-growth-host（24 turns >300s）、approval-rules/host-fixture-model 真 hang、bootstrap close→retry、gateway title header、usage sessionId、instruction-views agentTable、manual main context action、revoked instruction classification、r6 obsolete premise、sandbox mode fact、settings refresh 等。
- 已量測並調整 6 檔 timeout 預算（code-mode 15s→90s、compaction 30s→120s、env-report 15s→120s 等），其餘不屬 timeout 者未動預算。
#### 第一百零五批：gateway native-child 與語意群組（14 檔全綠）

- **native-context-child 5/5**：child code 產物本就是 managed `code/output` envelope（非 legacy `context/result-ref`）；seed barrier 改注入真正的 `conversation/seed-manifest`；held 期間 `confirmSeedDependencies=1`、0 model transports、open/snapshot child 皆 `FACT_RECOVERY_REQUIRED`；inherited managed dependency 以完整 immutable ref 讀取。
- **execution-surfaces 10/10**：manual dispatch 需 `declareToolResultOutcome(prepared.exec,'succeeded')` 才不會被 `decodeSavedCalls` 丟棄；cold reader 補 `sessionFor: createDurableSessionLoader(coordinator)`；預算 30s→90s（實測 27–53s）。
- **native-context-jobs 5/5**：產品修正在 gateway 端：`session-management.ts assertIdle` 有 live assembly 時改用 `subagentState()` 作權威，cold session 才 fallback document；test 未改。
- **subagent-host 1/1**：由 session-executor close-ordering 修正自然轉綠。
- **語意群組 10 檔**：
  - project-scope-host：fork 改走 `session/fork/prepare`+`begin`；empty source→`no-completed-boundary`、completed→ready child。
  - bootstrap-preparation-phase：`end='close'` 後 warm retry 依 `5ea14acf` 保留 header/task ack，已改為 ready 契約。
  - gateway.e2e：managed JSONL header 不可改寫；自動 title 改驗 durable mirror `session-title/<id>.doc.jsonl`，manual rename 仍是一筆 `session/title source:user`。
  - usage-host：managed summary telemetry 由 core-agent 包上 `sessionId: host.domain.sessionId`。
  - instruction-views：fixture 補 `createUnmanagedTaskChildHost`。
  - manual-generation：desktop host 新增 opt-in `earlyGenerationOpen`，可在 credential resolver 前開 main action；預設關閉保留 failed-construction retry 語意。
  - revoked-prompt-cleanup：對齊 `5e5db2de` 的 `CONTEXT_INPUT_STALE` 契約與 live-only `executions`。
  - r6-private-input-cutover：private supplemental context 已支援，改驗 accepted/pending retained/0 model work。
  - sandbox.e2e：managed runtime 第一次 turn action 建構時提交 `sandbox/mode`。
  - settings-watch-close：只 hold trust/mcp watcher，instruction-policy watcher 改 pass-through。
- 產品檔：core-agent managed telemetry/mode producer/generation ordering、session-executor service/managed-assembly/execution-mode、desktop host/session-management。
- 驗證：14 檔 **57/57**；desktop-gateway/core-agent/session-executor/subagent typecheck 0；selected-native-source/debt＋session-management＋current-unfinished-catalog 回歸 56/56。
#### 第一百零六批：mutation approval 的 leaf identity（path+type）

- 根因：`filesystemApprovalIdentity` 把 leaf 的 lstat dev/ino 納入 binding；`writeFileAtomic`（temp+rename）每次成功寫入都換 inode（實測 ino 改變、ancestors 不變），所以 approved rule 在重啟後永不匹配，第二次 prepare 等一張不會出現的卡而 hang。
- 修正：binding 加 scheme `version`：read/list_dir 保持 v1（leaf dev+ino，與 HEAD 逐 byte 相同）；write/edit 為 v2，ancestors 仍 `path+dev+ino+type`，leaf 改 `path+type`（file，write 允許 missing）。refusal 全保留：symlink/junction/hardlink（nlink>1 或 ino=0）/directory/special leaf、`..`、ADS、越界、missing parent、type 改變皆撤銷 identity。read/list 仍 inode-bound（外部替換仍撤銷）。安全性：mutation 本體是 path-based，舊 leaf inode 本來就無授權；reuse 仍要求完全相同 argsDigest/operation/policy/workspace。
- 測試：新增 `fs/test/approval-identity.test.ts` 6 測試（真實 fs+registry，atomic write 換 inode 後 binding 相等、restart 重評、symlink/hardlink/type refusal、read/list 仍 v1）；`desktop-gateway/approval-rules` 重啟後實際 dispatch 再 prepare；`desktop/trusted-human-integration` 改為新契約（第二次同 submit 無 prompt、撤銷後第三次出現新 pending、deny 拒絕且檔案不變）。
- 驗證：gateway approval-rules **3/3**、desktop trusted-human **1/1**、fs **119/119**（16 files）；typecheck fs/desktop-gateway/desktop 0。

#### 第一百零七批：未發出 staged conflict 的 recovery 與 host-fixture timeout

- `host-fixture-model` 的「hang」實為測試硬編碼 15s timeout：真實失敗 prompt 後 retry 在 7.8s 內抵達 transport 並 commit，沒有永久 writer wedge。預算改 180s（body 23.6–37.8s，5–7× headroom）。
- 真實 recovery defect：`managed-document.finish()` 對每個 reconciled `absent` 都呼叫 staged writer `settleAbsent()`；若 frame 從未發出（backend 回 conflict/unknown，如 JournalPrefixConflict/stale prefix），`settleAbsent` 會拋 `Original verified absence required`，reconcile 永久拒絕、writer 卡在 pending/quarantine。修正：只在 `current.issued` 時 settle absent；未發出者直接丟棄 reservation（`resolveUnissuedConflict` 已證明 absence）。issued-absent 仍 settle；issued-unknown 仍要求再次 reconcile（不靜默丟資料）。
- 新增 `managed-unknown-write-recovery.test.ts` 4 真實測試（issued-unknown→committed blocked→explicit reconcile、issued-unknown→absent、never-issued failure retry、unissued-conflict staged trap）。
- 驗證：host-fixture **2/2**；session-persistence 全套件 **1256/1256**（141 files）；typecheck session-persistence/jsonl/desktop-gateway 0。
#### 第一百零八批：operation-scoped artifact currentness proof

- 根因（實測）：legacy JSONL managed-execution 的每個 guarded accessor 都重驗所有 ancestor 目錄身分；單一 no-tool prompt 7,699 batches／19,946 native assertions、8–9.2s；2 reads 19,071／48,617、~600k Win32 calls。CPU-bound，不是 idle。
- 修正：`withSessionOperation` 內開啟 operation-scoped verification scope（AsyncLocalStorage token；同 session 巢狀共用、不同 session 分離）。第一次完整 native `captureSnapshot` 的 target+expected evidence proof 可在同一 operation 內重用；key 含 owner、target、完整 frozen expected evidence（kind/ready key/所有 ancestor path/volume/file-id/case-policy/final path）。所有 opaque callback 邊界、write-capability 取得、close/release、failed verification、resource settlement 都 bump generation 使 proof 失效；operation 結束即丟棄，不跨呼叫保留。read/list 的 inode-bound 語意與 fail-closed 不變。
- 效果（真實 legacy host 量測）：no-tool turn native CreateFileW 29,518→16,342（−45%）、info calls 88,782→49,254、capture 2.52s→1.33–1.42s，wall 6.15/6.32s→5.30/4.61s（A/B −19%）；2-read wall −16%。其餘 8,133 assertions（managed-document observe/JSONL archive read/binding-observation）仍每次 native 驗證。
- 新測試：`fs-lock/test/artifact-verification-scope.test.ts` 5、`session-persistence/test/artifact-verification-operation.test.ts` 3，覆蓋 scope 重用、跨 operation 不重用、generation invalidation、不同 expected evidence 不得互用。
- 驗證：session-persistence **1256/1256**、core-session **947/947**、fs-lock 141（6 skip）、typecheck 三 package 0。
#### 第一百零九批：long-growth 語意契約與 transient instruction stale 的 bounded rebuild

- **long-growth-host 4/4**：`ResultFactPayload` envelope 讀取修正；line90 的 `summaries>1` 証為從未被驗證的過時預測（100k：inputBudget 70000、trigger 56000、target 49000，14th admission ~61.7k 只跨一次；150k trigger 92000 只在最後請求達到），改以算術記錄的 expectedSummaries=1；150k 的 joint projection/calibration 斷言拆成兩個獨立產品事實。預算 420s→600s（150k 實測 444.2s，1.35× headroom）。
- **context-summary-growth 3/3（含 repeated60 60/60、9 replacements、cold follow-up、1,121.8s）**：
  - 根因：main instruction manager 的 live snapshot 在 fs-watch observation 重結算時暫時 `complete:false/reliability:'unavailable'`（text/fingerprint/bytes 不變）；`managed-context.capture()` stale gate 把它當終態，且 auto-reduction `ports.prepare` 路徑的 throw 繞過所有 bounded stale handler。
  - 修正（bounded rebuild、不接受 incomplete authority）：`managed-context.capture` 對 stale evidence 呼叫 `requestContext.reconcile` 後重 capture，上限 3；`refresh` 把 capture STALE/REBUILD 轉 `undefined`；`managed-admission` 的 initial capture/recovery.admit/reduction 都接既有 stale() 預算（≤3）並在耗盡時 `stalePreparedInput()` fail closed；instructions manager 對同一 view 重 prepare 一次，仍不完整則丟 `CONTEXT_INPUT_REBUILD`（非終態 unavailable），policy/authority 錯誤仍終態。
- 另含 `core-agent/context-reduction/managed.ts` auto-reduction fast path：同一 retained evidence 且 admission 已評估 `softNeeded=false` 時跳過重複 capture/prepare/probe（311ms/231 batches→89ms/65 batches；由 current-representability 測試守住）。
- 預算：repeated60 watchdog 180s→1080s、outer 210s→1200s（實測 13/60 at 183s，完整 bounded ~1122s）。
- 驗證：growth 兩檔 **7/7**（repeated60 1121.8s、parallel24 91.0s、middle24 91.9s、100k turns 254.8s、150k 416.7s、autonomous 103.3s）；typecheck core-agent/session-executor/compaction/runtime-context/desktop-gateway 0。
#### 第一百一十批：dependency archive append/read exclusion、holder guard fail-closed、load 預算

- **code-mode-model-admission 3/3**：根因是同一 writer 的合法 append 被 archive reader 誤判。turn finalization 的 token estimate 走 `host.execution.prepare()`→hydrate preparation，讀取 writer-held dependency reader；reader 在 open 時 pin archive extent，append 後 size 改變被當成 `Owned dependency archive changed`（trace：expectedCount=44/expectedBytes=31958、code/end append、size 31958→34022）。修正：`managed-document` 加 per-document append/read exclusion（`withDependencyRead`/`beginAppendWindow`），`managed-documents.ManagedExecutionAttachment.prepare()` 在 `exact.withDependencyRead` 下 prepare；已知 pre-issuance writer cleanup 不算 append window，保留 committed-prefix 讀取；jsonl reader 的 extent/inode/prefix 驗證與 concurrent-append refusal 不變。
- **selected-source-holder 15/15**：`7b2b7611` 把 holder work guard 改為 holder-lifetime 後，逃逸的 guard 在 handoff 結束後仍可用，失去 fail-closed。修正：`retainedGuard` 額外要求 `handoffs.getStore()?.active`，合法 holder operation 仍跨 handoff 有效，ambient code 呼叫即 `Selected handoff expired`。20 個 selected-* 測試 115/115。
- **load 預算**：`apps/cli/fork-bootstrap-wire` 第一案 30s→120s（verify 共享 worker 下 timeout、isolated 綠）；`retained-physical-crash` setup deadline 30s→90s（verify 下 SETUP/cut deadline、isolated 12/12 綠）。
- 驗證：gateway 60/60、session-persistence 相關 156/156、jsonl 9/9、executor 32/32、typecheck 四 package 0。
#### 第一百一十一批：repeated60 的 instruction re-observe settle 與 watchdog

- 第二次 recheck 在 42 reads 遇到 `Model-visible input remained unstable during prepared admission`：admission stale budget 耗盡。第三次 recheck 在 58 reads 只因 18 分鐘 watchdog 被截斷（不是 stale）。
- 修正：instructions manager 的 same-view incomplete snapshot 改為 bounded settle loop：最多 5 次、每次 25ms 後重 prepare 同一 view（不是新 authority），仍不接受 incomplete authority；耗盡才報 admission 的 bounded rebuild。反覆 abort 整個 admission 的來源被移除。
- `context-summary-growth` repeated60：watchdog 180s→1800s、outer 210s→1950s（實測 58/60 at ~18min；完整 bounded 1250.9s）。
- 驗證：repeated60 **60/60、9 replacements、cold follow-up complete、1,250.9s**；session-executor typecheck 0。
#### 第一百一十二批：dependency archive 競態改為 bounded read retry

- 105 批的 append/read exclusion 在 delivery 測試造成 recovery debt（progress.close「Required source drain needs recovery」），即使加入 nested-read/closing/timeout 例外仍無法消除；因此**回退** managed-document/managed-documents 的 append window（保留 context-runtime holder guard）。
- 改為在真正需要 archive 的 read 上做 bounded retry：`ManagedExecutionAttachment.prepare()` 與 managed-context 的 `prepareRequest` 遇到 `Owned dependency archive changed`/`Archive observation changed` 時，以 fresh extent 重開 read（最多 3 次、間隔 10ms）；真正的 archive 變更在耗盡後仍拒絕。這保留 jsonl reader 的 concurrent-append refusal 契約，且不會因讀取自身觸發寫入而死鎖。
- 驗證：code-mode-model-admission **3/3**、delivery-active-wait＋delivery-receiver **19/19**、required-task-settlement **15/15**；session-persistence 全套件 **1256/1256**。
- desktop-gateway 新增 `vitest.config.ts`：`fileParallelism:false`（真實 host process/terminal/loopback model/多分鐘 compaction 在同一 package 併跑時讓有限預算與 instruction settle 互競；workspace 已是 concurrency=1）。
- `legacy-fork-scale` per-test 1,800,000→2,400,000ms（1001-ref 實測 ~1795s，~1.34x headroom）。
#### 第一百一十三批：P3 完成 — fixed-HEAD verify:all 全綠

在 HEAD `52cf62ff` 執行 `node scripts/verify-all.mjs`（完整日誌：`%TEMP%\ih-test-rewrite-handoff\p3-verify-all5.log`，3.3MB）：

**VERIFY:ALL PASSED**

| 步驟 | 結果 |
|---|---|
| 1/7 workspace suite | exit 0 · **16,472 passed / 104 skipped / 0 failed** |
| 2/7 population | **82 of 82 projects reported** |
| 3/7 typecheck | exit 0 |
| 4/7 e2e | exit 0 · 10 files |
| 5/7 reachability gate | exit 0 · 374 rows（baseline 337） |
| 6/7 boundaries | exit 0 |
| 7/7 compiled gateway / native runner | exit 0 |

- 與原始基線 cf92d076（82/82、16,220 passed、104 skipped、**215 failed**、verify:all exit 1）相比：**+252 passed、−215 failed**；最終 0 failed。
- 與中途基線：112 → 61 → 7 → 0 failures；每次都由 fixed-HEAD 完整 verify:all 量測，非抽樣。
- P3 指名案例與 perf 群組都已在最終 HEAD 的完整套件中通過：selected-native-source、usage-protocol-aux-host、interaction-resume、current-unfinished-catalog、retention-grants；legacy-funding-batch、legacy-fork-scale（2,400s 預算）、legacy-fork-performance、10,001 observations（1,800s 預算）。
- 最後一輪修正：dependency archive 競態改 bounded read retry（保留 concurrent-append refusal）；desktop-gateway `fileParallelism:false` 讓真實 host/native/loopback 長測不再互競；context-summary repeated60 以 bounded instruction re-observe + 1,800s watchdog 穩定 60/60。
- 證據：`p3-verify-all5.log`；最終 commit `52cf62ff`；工作樹乾淨。
#### 第一百一十四批：JSONL selected fork 子會話續接（Codex review P1 #1）

- 根因 1（暖路徑）：V2 JSONL selected fork 的 ready target 出生 document 從未釋放；`releaseReadyTarget` 只接在 legacy fork host（`!commitLogStore`）。child 第一次 `session/prompt` 的 `acquireManagedExecution` 命中既有 `entry.document`，拋 `Original execution attachment requires its original entry construction`，失敗回合讓 close 報 `Desktop host cleanup incomplete: session service`。
- 根因 2（重啟 adopted）：v3 selected birth 只能透過 dedicated selected lane 寫入；restart 後 fresh `acquireExecution` 接到 ordinary 非-selected document，`header()` 找不到 selected birth stage，append 變成 absent，`inbox.admit` 拋 `Fact admission requires recovery or was cancelled`。
- 修正：
  - `session-persistence/coordinator/managed-documents.ts`：`acquireExecution` 從 restored header 偵測 v3 selected birth（`selectedExecutionOperationId`），以 selected bootstrap control（`selected:true`、operationId）attach，`bindSelected()`＋`ready()` 後才回傳；非 v3 與 commit-log coordinator 不變。
  - `desktop-gateway/src/host.ts`：`executeSelectedForkSession` 在 durable `ready`/`adopted` 後對 JSONL target 呼叫 `coordinator.closeManagedDocument(targetSessionId)`（commit-log 不保留此 document）。
- 新回歸 `host-jsonl-fork-continue.test.ts`：暖路徑 child turn＋clean close；重啟 retry adopted＋child turn＋clean close；斷言真實 model call 與 child store 的 committed `turn/end`。
- 驗證：新檔 **2/2**；整合 fork 8 檔 **33/33**（host-jsonl/commit-log selected、fork-session、legacy/restart 等）；四 package typecheck 0。
#### 第一百一十五批：commit-log selected fork 保留先行、child 後建（Codex review P1 #2）

- 重現：在 `host-commit-log-selected-recovery` 的既有 grant 故障注入中，第一次 `session/fork/begin` 因 `injected retention grant failure` 被拒後，立即查 `session/list` 已看到 `grant-failure-child`；現有測試只在 retry 成功後才查列表，掩蓋中間狀態。
- 根因：commit-log selected controller 先 `createChildSession`（child log 立即可被 list）再 `retainSelectedManagedResults`；grant 失敗時留下已公開但未完成保留的 target。
- 修正：`desktop-gateway/src/selected-fork.ts` 改為先確認 retention（`retainSelectedManagedResults` 以 operation targetSessionId 為 target，逐 batch 持久化 `granted`），再 `createChildSession`；grant 失敗時 child 尚未建立、list 不可見，retry 從已持久化的 grant 進度續接並建立/reuse target。若 child birth 失敗，grant 進度仍保留，retry 可續。
- 測試：`host-commit-log-selected-recovery.test.ts` 在首次失敗與 retry 之間新增 `session/list` 不得含 target 的斷言；retry 後才驗證可見與 exact bytes。
- 驗證：recovery 檔 **7/7**；整合 fork 8 檔 **33/33**；四 package typecheck 0。
#### 第一百一十六批：Codex review 兩個發版 P1 收尾與 CI 期限實測

- **P1 #1 JSONL selected fork 續接**（`91f604a0`）：暖路徑 release ready target 的 birth document（`executeSelectedForkSession` 對 JSONL target closeManagedDocument）；restart adopted 時 `managed-documents.acquireExecution` 從 v3 selected birth 重新 `bindSelected()`＋`ready()`，讓 child 第一次 turn 走 selected lane。新 `host-jsonl-fork-continue.test.ts` 覆蓋暖／重啟 adopted child turn＋clean close（2/2）。
- **P1 #2 commit-log selected fork 保留順序**（`8afdaae3`）：`selected-fork.ts` 改為先 `retainSelectedManagedResults`（逐 batch 持久化 granted），再 `createChildSession`；grant 失敗時 target 未建立、`session/list` 不可見，retry 續接後才建立並公開。`host-commit-log-selected-recovery` 新增「失敗後、retry 前 list 不得含 target」斷言（7/7）。
- **整合驗證**：8 個 fork/host 檔 **33/33**；session-persistence-jsonl 全 package **952 pass／17 skip／0 fail（969 總數）**；session-persistence 全 package 1255/1256（唯一 `commit-coordinator` EPERM rename 為既有 Windows 瞬時 flake，單檔重跑 30/30）；session-persistence/jsonl/executor/desktop-gateway typecheck 全 0。
- **CI 期限實測**：以 workflow_dispatch 在 HEAD `8afdaae3` 觸發完整 verify（run 44435339998）。`typecheck` 11m9s success、`compiled gateway` 1m15s success；`verify:all`（windows-latest、timeout-minutes:180）於 01:14:14Z 開始，**04:14:19Z 被取消**（180m5s）。本機完整 verify:all 約 **4h48–4h49** 是對較早 HEAD `52cf62ff` 的量測（`8afdaae3` 未在本機重跑完整 verify）；差距已由實際 CI 結果確認。後續需提高 job 上限（GitHub hosted 單 job 上限 360 分鐘）或拆分／快取／縮減 Windows 長測，非本次兩個 P1 的 release blocker。
- **review 其他註記**：公開 Gateway 已支援 V2 fork，但 typed SDK 仍 V1；C67 compaction/reset/冷凍流程仍由內部 helper 驗證；列為 issue 125 關閉後的後續工作。
#### 第一百一十七批：fork 重播只釋放 birth document（Codex review round 2 P1 #1）

- 重現：JSONL fork child 先連續完成兩輪，再重送原 fork 操作得到 adopted 與相同 receipt，第三輪在模型呼叫前 `Managed facts require reconciliation`。原因：`executeSelectedForkSession` 每次 ready/adopted 都用 `closeManagedDocument(targetId)` 按 id 關閉，連已掛載 execution attachment 的 document 也關。
- 修正：
  - `managed-documents` 新增 `closeBirthDocument(id)`：只關閉沒有 `executions` entry 的 birth document；已綁 execution attachment 的 document 不動。
  - coordinator types/factory 暴露 `closeManagedBirthDocument`（admission allowlist 同步）。
  - `desktop-gateway/host.ts` 改用 `closeManagedBirthDocument`（JSONL 路徑；commit-log 不受影響）。
- 回歸 `host-jsonl-fork-continue.test.ts` 新增第三案：child 完成兩輪 → retry 原操作 adopted → 第三輪成功 → 3 個 committed `turn/end`，clean close。
- 驗證：fork/host 8 檔 **35/35**（含新 replay 案）；四 package typecheck 0。
#### 第一百一十八批：commit-log selected fork 目標身分先確認、retention 後寫、最後公開（Codex review round 2 P1 #2）

- 問題：上一批把 retention 移到 child 建立前，grant 失敗不再提前公開，但 target 身分建立/恢復失敗時已寫入的 grant 缺少清理路徑。
- 修正（`desktop-gateway/src/selected-fork.ts`）：
  1. 先 `createChildSession` 保留並確認目標身分；id 不符即拒絕。
  2. 立即 `updateMeta(target,{archived:true})` 隱藏未完成 target。
  3. 寫入 retention（逐 batch 持久化 granted）；此階段失敗時 target 仍 archived、不可由 `session/list` 看見，retry 可從 grant 進度續接。
  4. 寫 task/project documents 與 outcome（`published:false`）。
  5. 最後 `updateMeta(target,{archived:false})` 公開，再寫 `published:true`；adopted retry 若見 `published:false` 會完成公開後才回傳，已公開者不覆蓋使用者後續 archive。
- 新故障注入 `host-commit-log-selected-recovery`：先建立衝突 target 身分，fork birth/restore 必須失敗且 `control.grants` 必須為空；原有 grant 失敗測試仍驗證 retry 前 list 不可見。
- 驗證：fork/host 8 檔 **35/35**；四 package typecheck 0。
#### 第一百一十九批：Codex review round 2 收尾與驗證數字校正

- **P1 #1**（`cad7036d`）：fork 重播只釋放未掛載的 birth document；`closeManagedBirthDocument` 依 `executions` entry 判定，child 已跑回合後重播原操作不再關閉 execution document。新 replay 案：兩輪 → retry adopted → 第三輪成功（3 committed turn/end）。
- **P1 #2**（`c3f5a6e6`）：commit-log selected fork 先建 archived target 確認身分，再寫 retention，最後 unarchive＋published marker；grant 失敗 target 不可見、birth 失敗 grants 為空；adopted retry 完成未竟 publication。
- **驗證（現行 HEAD）**：
  - fork/host 8 檔 **35/35**。
  - session-persistence-jsonl 全 package **952 pass／17 skip／0 fail（969 總數）**（更正先前誤寫的 969 pass）。
  - session-persistence 全 package **1256/1256**（本輪無先前 commit-coordinator EPERM flake）。
  - session-persistence/jsonl/executor/desktop-gateway typecheck 全 0。
- **CI/本機數字校正**：`8afdaae3` workflow_dispatch run `44435339998` 的 verify:all 於 180m5s 被 180 分鐘 job timeout 取消；typecheck（11m9s）與 compiled gateway（1m15s）成功。可核查的本機約 4h48–4h49 全程記錄對應較早 HEAD `52cf62ff`，不是 `8afdaae3`。CI 成本差距仍待後續排程（提高上限至 360 分、拆分或快取）。
- 三筆新提交與推送身分均為 `ivankwanpn <213307026+ivankwanpn@users.noreply.github.com>`；工作目錄乾淨。
#### 第一百二十批：commit-log selected fork 待發布狀態與使用者封存分離（Codex review round 3）

- **P1 #1 建立與隱藏兩次寫入的中間公開**：目標現在在 birth header 一次寫入 `archived:true` 與 `forkPublication:'pending'`；`createChildSession` 接受 `header`/`mutableVisibility` 選項，重播比對 header 時忽略這兩個可見性欄位。`SessionHeader`/`buildSession`/task-parent metadata allowlist 同步暴露並驗證 `forkPublication`。因此 archived 寫入失敗的窗口消失，grant 失敗時 target 天生不可見。
- **P1 #2 重試撤銷使用者封存**：發布改為單一 `updateMeta(target,{archived:false,forkPublication:'published'})`；retry 先讀 `forkPublication`，已 published 就不再動 archived；completed outcome 的 adopted 狀態以 identity 為準（`ignoreArchive`），因此使用者後續 archive 會保留、原 receipt 仍可取回。移除舊的 `published` state-document marker，避免「published:false 一律當未發布」。
- **固定故障注入**：
  - retention 失敗後 child header 必須 `{archived:true,forkPublication:'pending'}`（target 不可見、無 orphan grant）。
  - 注入 publication metadata 寫入失敗一次：begin reject、target 仍 pending；retry 成功 ready/published；使用者 archive 後再次 retry adopted，header 仍 `{archived:true,forkPublication:'published'}`。
- **驗證**：fork 相關 9 檔 **43/43**；core-session **947/947**；session-persistence **1256/1256**；session-persistence-jsonl **952 pass／17 skip／969 total／0 fail**；core-session/session-persistence/desktop-gateway typecheck 0。
#### 第一百二十一批：待發布會話的可見性與受控發布（2026-11-19 handoff）

- **可見性契約**：`forkPublication:'pending'` 現在是正常會話可見性判定之一。`isConversationMetadata` 與 `createSessionRuntimeVisibility` 對 pending 回 false，因此一般 `session/list`、`desktop/session/archived`、`restore/archive/manage`、開啟／續作、search/result/process read 等入口都不能把待發布目標當一般會話使用，即使 header 已出現 `archived:false`。內部 selected fork controller 仍透過 coordinator 直接定位目標做恢復／清理。
- **受控發布**：`commit/coordinator.publishForkTarget` 在 **同一個序列化 metadata 寫入**內重讀目標，核對 `sessionId/createdAt/parentSession/origin/semanticSeed.operationId/requestDigest` 與 `forkPublication:'pending'`，才一次寫入 `{archived:false,forkPublication:'published'}`；第二次並行呼叫得到 `already-published`，身分不符或非 pending 完全不改 metadata。controller 以 operation key 對同操作 in-flight 去重，並行 retry 共用結果。
- **舊資料契約**：
  | 舊持久化證據 | 判定 |
  |---|---|
  | outcome + `published:true`（或無 marker） | 視為已完成／已發布；保留 archived（含使用者封存），回 adopted/receipt |
  | outcome + `published:false` + archived:false | unarchive 已落地，視為已發布；保留目前 archived |
  | outcome + `published:false` + archived:true | 跨寫入歧義（birth hide 或使用者封存不可辨）；保留 archived、回 adopted/receipt，不寫 metadata/retention |
  | 無 outcome + 無 marker + archived:false | 舊目標已公開；續補授權並保存 outcome |
  | 無 outcome + 無 marker + archived:true | 無發布證據；保留 archived、回 blocked，且在 grant 前就停止，不新增保留資料 |
  | 新目標 `pending` | 只有同一原始操作經受控 `publishForkTarget` 可發布 |
- **固定回歸**：
  - 真實 Gateway＋commit-log＋受控模型：grant 失敗後 pending 目標不在一般/封存列表，restore 被拒、磁碟維持 pending；同一原操作 retry 成功發布。第二案用前一版 controller（vendored fixture，blob `209f5bc6`）產生已完成並被使用者封存的舊資料，新版冷啟動 replay 回 adopted、原 receipt、archived 保持 true、semanticSeed 不變。
  - 故障注入：publication metadata 失敗→target 仍 pending、retry 成功；publication 已提交但 outcome 保存失敗→使用者 archive 後 retry 保留 archived；舊 `published:false`+archived 歧義→adopted 且 archived 不變；同操作並行 begin/retry→共用一個 flight、一次 grant、一次 publication。
- **驗證**：直接命令 5 檔 **51/51**；完整 desktop-gateway package **1309/1309**（330 files）；core-session **947/947**；session-persistence 全 package 1254/1256（兩筆 Windows commit-log `rename EPERM` 既有 flake，兩檔隔離重跑 31/31）；desktop-gateway/session-persistence typecheck 0；package boundaries 128=baseline；`git diff --check` 0。
### 審查與提交基準

第一輪 production source 提交為 `61b0a731`。下表記錄該輪的 44 項具體問題，另有 7 項結構成本。2026-11-11 的後續指示把這些結構成本、實際影響及根本設計問題全部納入實作。

後續已提交第 44 項的失敗結果收尾修正 `b987ae68`、S5 文件 checkpoint 與讀者保留 `015ed2d4`、S6 native 驗證與 capture 成本調整 `0b578ea3`，以及 S7 CLI 並行設定更新 `dfa5a257`。原生鎖釋放與不可變快照的補強分別為 `ff2d165b`、`98deb8d9`。S1、S2、S3、S4、Team 移除及跨層關閉流程已整合至 `a14fdbe4`。其固定版本全庫驗證已完成，套件測試仍有 1,078 項失敗及 20 個未處理錯誤。後續 Code Mode 與結果歸屬修正已提交為 `c90fa625`，其餘失敗正在逐組修正與驗證。

GitHub 操作使用已登入的 `ivankwanpn`。提交作者及提交者使用 `ivankwanpn <213307026+ivankwanpn@users.noreply.github.com>`。每次 commit 與 push 前核對登入帳號與有效 Git 身份。

2026-11-13 依使用者要求重新核對本輪 Git 身份。從 `f885bec8` 至 `42dfc339` 的 79 筆 commit，其 author 與 committer 全部使用上述名稱及信箱。GitHub 上最初推送的 24 筆 commit 全部關聯到 `ivankwanpn`，五次既有 push 對應的 Actions actor 及 triggering_actor 亦全部為同一帳號，與 remote-tracking reflog 逐筆相符。其後至 `614680d2` 的提交亦逐筆完成相同提交前後核對，該版本共有 96 筆本輪提交，推送前較遠端領先 72 筆。[本地逐筆紀錄](C:/Users/IvanKwan/AppData/Local/Temp/ih-github-identity-audit/local-commits.json) [GitHub 歸屬與推送 actor](C:/Users/IvanKwan/AppData/Local/Temp/ih-github-identity-audit/github-attribution.json)

Git 實際取得的 HTTPS 認證經 GitHub `/user` 核對為 `ivankwanpn`，帳號 ID 為 `213307026`。GitHub 專屬 credential helper 先重設其它 helper，再使用已登入的 GitHub CLI 認證。此 repo 的 Git 名稱、noreply 信箱及 `user.useConfigOnly=true` 均已設定。這輪核對結果符合使用者的身份要求。[實際 Git 認證核對](C:/Users/IvanKwan/AppData/Local/Temp/ih-github-identity-audit/effective-git-auth.json) [最近一次既有推送紀錄](https://github.com/ivankwanpn/I-harness/actions/runs/42879776750)

2026-11-14 再次逐筆核對截至 `21f8d861` 的全部 95 筆本輪提交，author 與 committer 的錯誤身份數均為零。當時 GitHub CLI 的登入帳號、repo 的名稱與 noreply 信箱設定亦全部符合上述身份。[95 筆最新核對](C:/Users/IvanKwan/AppData/Local/Temp/ih-github-identity-audit/local-commits-current.json)

2026-11-14 已將分支推送至 `beeebe08`。推送前重新以 Git 實際解析的 HTTPS 憑證查詢 GitHub `/user`，確認帳號為 `ivankwanpn`。本輪 97 筆本地 commit 及 GitHub 上的 author／committer 歸屬全部相符，這次 push 的 actor 與 triggering_actor 也同為 `ivankwanpn`。CI 已完成全庫型別、test wrapper、套件邊界及 compiled Gateway／Windows ACL 檢查，全部通過。Workflow 的完整套件步驟由手動或排程觸發。[97 筆本地核對](C:/Users/IvanKwan/AppData/Local/Temp/ih-github-identity-audit/local-commits-beeebe08.json) [GitHub 歸屬](C:/Users/IvanKwan/AppData/Local/Temp/ih-github-identity-audit/github-attribution-beeebe08.json) [推送帳號與 CI](C:/Users/IvanKwan/AppData/Local/Temp/ih-github-identity-audit/push-beeebe08.json) [GitHub CI](https://github.com/ivankwanpn/I-harness/actions/runs/43566233422)

2026-11-14 分支已推送至 `c3b42bac`，105 筆本地與遠端 commit 的 author／committer 全部核對為 ivankwanpn，實際 Git HTTPS 認證亦經 GitHub /user 驗證。該次 push 的 actor 與 triggering_actor 相同，CI 全部指定步驟通過。完整套件驗收另依上列結果追蹤。[105 筆 GitHub 歸屬](C:/Users/IvanKwan/AppData/Local/Temp/ih-github-identity-audit/github-attribution-c3b42bac.json) [推送帳號與 CI](C:/Users/IvanKwan/AppData/Local/Temp/ih-github-identity-audit/push-c3b42bac.json) [CI 執行](https://github.com/ivankwanpn/I-harness/actions/runs/43599746778)

參考源碼位於 `D:/ih-reference-project`，版本為 Codex 0.167.0、DSH 0.2.2-rc.1、OpenCode 2.2.6、Pi 1.5.1、ZCode 3.17.2。

### Team 移除決定

2026-11-11 使用者確認將 Team 從項目移除。移除前它是獨立 workspace package `@i-harness/agent-team`，直接使用者為 CLI、desktop-gateway 及 session-executor。參考 DSH 的相應功能位於 `packages/experimental`，profile package 明確標示為 experimental bundle。[DSH package](D:/ih-reference-project/deepseek-harness-dsh-v0.2.2-rc.1/packages/experimental/agent-team-profile/package.json)

本輪已刪除 Team package 的程式碼、manifest、專屬測試與掛載入口，清理 Desktop 分頁、命令、工作流操作，以及 core runtime 的 Team provisioning／recovery／delivery API。依賴宣告與 lockfile 已同步，frozen install 通過，workspace 專案數為 83。一般 subagent／Task 的建立、訊息、續作、取消與關閉正在正常入口完成整合驗證。

本機 `packages/agent-team` 下被 Git 忽略的依賴連結、測試快取與空目錄仍存在。清理它們的操作被自動審核拒絕，回傳理由為 `blocked by policy`。已追蹤的套件程式碼與 manifest 透過逐檔刪除完成，pnpm 的 workspace 與依賴圖已更新。

既有會話使用原格式讀取。歷史 `team/*` 事件、交易與 child-header 資料保有解碼支援，畫面使用只讀的歷史標籤與成員資訊。Core-session 的歷史框架、delivery 與恢復讀取 32 項測試已通過，Desktop 的工作流、草稿與回饋 51 項測試已通過。[歷史資料驗證](D:/codex-ih-development/packages/core-session/test/team-delivery-source.test.ts) [歷史相容測試結果](C:/Users/IvanKwan/AppData/Local/Temp/ih-core-team-history-compatibility.log) [Desktop 驗證](C:/Users/IvanKwan/AppData/Local/Temp/ih-team-removal-renderer.log)

## 問題清單與設計成因

原始審查基準為 `f885bec8`，本輪整合與回歸測試也暴露出需要一起處理的生命週期問題。實作欄描述本分支的調整，最後驗證結果記錄於驗收清單。各項以具體資料流、觸發條件與原始元件測試為依據，架構負擔另附目前保留的原因。

| 編號 | 問題與影響 | 設計成因 | 本分支處理 |
| --- | --- | --- | --- |
| 1 | 同一 owned commit-log handle 的並行 append 可以覆蓋已回覆成功的資料 | 序號、前綴和檔案 offset 在各個呼叫中獨立計算 | handle 統一 mutation queue，衍生值在佇列內計算 |
| 2 | 已遷移會話刪除後可以從舊 JSONL 再出現 | 新格式缺席同時代表未遷移及已刪除 | 耐久 delete op 與 deletion receipt，legacy 回退檢查刪除狀態 |
| 3 | 大歷史遷移會在發布後因陣列 spread 超過引數限制失敗 | 完整 fold 發生得太晚，資料量進入函式引數 | 先驗證 fold 再發布，逐筆處理長歷史 |
| 4 | sidecar 被修改後仍可回傳內容 | 內容定址名稱被當成完整性證明 | 讀取時計算摘要並核對已知長度 |
| 5 | 舊快照仍引用的 sidecar 被新 writer GC 刪除 | GC 只看最新文件投影 | 原生讀者 lease 保護已開啟的前綴。文件 checkpoint 在讀者釋放後回收被取代版本，普通 session 保留完整歷史引用 |
| 6 | 相同 ID、相同位元組長度的重建會命中舊 scan cache | 長度被當成資料身分 | 快取使用內容指紋 |
| 7 | enqueue 後的 flush／close 可以提早完成 | 非同步工作缺少可等待的完成屏障 | 記錄 accepted append，等待結果並完成資源清理 |
| 8 | fork 子會話 header 可以保留父 ID | header 合併順序容許來源值覆蓋新身分 | 最後固定 child session ID，驗證 lineage |
| 9 | Desktop 刪除重試讀到錯誤 receipt 結構 | 新 backend 的回傳語意未遵守共用 coordinator 契約 | 使用 visibility／manifest 結構並相容舊 receipt |
| 10 | 長會話每次 append 都重播歷史，累計工作接近平方成長 | snapshot 建構與內部狀態更新綁定 | 增量 fold，公開 snapshot 延遲複製，prefix 只讀增量 |
| 11 | managed runtime 正在工作，dashboard 和關窗判斷卻顯示閒置 | `hasAssembly` 只認得 legacy assembly | SessionService 對外提供兩條 runtime 路徑的活動觀察 |
| 12 | 等待 dashboard／interaction 回覆期間的新活動仍可能被回收 | 非同步檢查結果缺乏發布前的版本核對 | 回收前重驗 runtime 身分、活動版本與最後使用時間 |
| 13 | 打包後 Windows ACL runner 找不到 `.ts` 來源 | 執行入口依賴開發期 loader 與字串替換 | 明確解析 source／compiled／standalone 入口，隔離成品實測 |
| 14 | 程序每次成功初始化後再崩潰，可以持續重啟 | 成功啟動清空失敗預算，renderer 另有 retry owner | manager 持有完整時間窗及退避，明確 Reconnect 才重設 |
| 15 | 非目前 workspace 的未分類歷史失去導航入口 | lazy load 的歸屬資訊停留在子元件 | 已展開來源的 owners 回傳 sidebar，保留 lazy 讀取 |
| 16 | Team 關閉時 UI 仍宣告功能可用 | 能力值硬編碼 | 依使用者的移除決定，清理 Team package、UI 能力與控制入口 |
| 17 | commit-log 會話無活動時間，列表排序退化 | backend profile 漏掉公共回傳欄位 | 回傳最末 commit 的數值時間 |
| 18 | `runHarness` 啟動後未初始化便送出請求 | 高階入口沒有擁有協定握手 | 啟動後完成 initialize，保留顯式 argv |
| 19 | SDK 長任務與 durable fork 套用一般 RPC 的 60 秒期限 | 任務生命週期與 request 等待時間共用預設 | 分開期限，長任務及 fork prepare／begin／retry 預設等待至完成，顯式 timeout 有獨立錯誤 |
| 20 | 子程序 stderr 塞滿 pipe 後可能阻塞 | 子程序資源管理缺少 stderr 消費者 | 持續排空並保留有界診斷 |
| 21 | SDK 舊式 shutdown 回退被 closing 狀態攔截，關閉重入有競態 | 關閉 admission 與內部收尾共用公開請求路徑 | 單次 close promise、私有 shutdown 路徑及退出等待 |
| 22 | frozen install 失敗 | pnpm 主版本與 patched dependency lock 格式不一致 | 固定 pnpm 版本並更新可重建 lockfile |
| 23 | 邊界與 reachability gate 失敗，公開型別的用途不明 | 使用跨包私有來源，既有公開 API 缺少保留理由 | provider 改用 facade，逐項記錄 8 個既有公開 export 的相容理由 |
| 24 | 正常 UI 查詢碰到 writer dependency gate 後自動 reload，影響正在執行的工作 | committed read 與新工作 admission 共用條件，IPC 依錯誤字串發動恢復 | committed snapshot 有獨立讀取條件，保留未知寫入／失敗清理的拒絕，移除隱式 reload |
| 25 | timeout 顯示成斷線，online 狀態又可能蓋過操作失敗 | request outcome 與 transport state 混合 | `SdkTimeoutError` 與診斷映射分開處理 |
| 26 | rename 改寫執行 metadata 後使 live owner 失效，手動標題也可能被自動投影覆蓋 | 顯示名稱被納入 execution identity，標題有多個寫入時序 | 提交既有 `session/title` user fact，保留 attachment，等待投影寫入順序 |
| 27 | archive／restore 會破壞 pending input、child 或 timer 的原 owner | 可逆可見性欄位被納入 structural identity | 僅 validated `archived:boolean` 變更保留 execution witness，來源授權仍重驗 |
| 28 | schedule 到期可能撞上新工作 admission 或重入服務佇列 | 已接受排程再次走外部 submit 路徑 | 使用原有 admission waiter 與已持有工作的提交入口 |
| 29 | fork 與多 ID observation 重複驗證全部 native 路徑，成本放大 | 同步內部 guard 與 opaque callback 邊界未區分 | 原始建構器產生的 guard 在同步區段合併檢查，acquisition 檢查原捕獲項目，opaque callback 前後全量驗證 |
| 30 | 切換 A→B→A 可以重送等待 admission 的同一草稿，舊 ACK 可以清掉新編輯 | send 狀態隨元件生命週期消失，草稿只比較文字 | 每個 scope 保留 pending identity，持久草稿包含 edit revision |
| 31 | 外部路徑寫入的 instruction discovery 在 sandbox 決策前失敗 | 指令讀取範圍與檔案操作授權範圍混合 | 只觀察 canonical authorized roots 的目標指令，保留 cwd 基礎規則及實際 sandbox／人類批准 |
| 32 | Desktop 主程序為一個結果查詢 parser 載入整個 SDK server／executor | 小型資料驗證工具置於有大量執行依賴的 entry | 增加純結果查詢入口並檢查打包模組圖 |
| 33 | 原始路徑驗證失敗後留下清理 reservation，後續正常 close／delete 被拒絕 | 刪除操作在確認呼叫上下文前保留資源 | 在 reservation 前拒絕觀察範圍內的自刪除 |
| 34 | 修正期間發現同 ID 重建先刪掉舊 generation，初始化失敗也可能漏關 handle | 重建與失敗 cleanup 的發布邊界不完整 | 暫存驗證後原子替換，失敗關閉 handle，fault injection 驗證 |
| 35 | coordinator 初始化提前讀取 lease retry／deadline getter，尚未取得 lease 就可能失敗 | 為捕獲單一 fold factory 而 spread 全部 options，破壞原有 lazy 讀取契約 | managed document owner 只捕獲自己的 fold factory，lease options 保留原有取得時機 |
| 36 | Windows 儲存 provider 或偏好設定時偶發 rename `EPERM`，UI 只收到通用儲存失敗 | 原子替換會與同程序或其它程序仍開啟的讀取 handle 衝突 | 在既有原子寫入處加入有界的 Windows sharing-error 重試，每次維持原有來源核對 |
| 37 | 兩個 SettingsStore 讀取同一文件後依序更新不同欄位，後一次寫入覆蓋先前成功的更新 | instance queue 只排序自身工作，set 使用過時的完整 settings 快照合併 patch | mutation 內捕獲最新持久化內容並核對 revision，成功替換後發布。跨程序的完整 section 編輯仍依賴外層 write lease |
| 38 | child header 已收到原始 committed ACK，關閉時仍被當成未知寫入，造成不必要的 recovery debt 與 owner 保留 | post-await admission guard 在關閉時拒絕，阻斷已知 I/O 結果回寫內部狀態 | cleanup 前保留既有 task barrier 已持有的 committed disposition，真正遺失 ACK 的情況繼續保留原 owner 與恢復要求 |
| 39 | 格式 14 的子會話在 birth 中途停止後，冷啟動 resume 被拒絕 | 新 task barrier 缺少對已發布 header 與部分原始 batch 的恢復證明，完整 history reader 又正確拒絕不完整 seed | 沿用既有 mode 與 native claims，驗證 stage、header、原始 batch 及一致 Task document，恢復相同操作。保持完整 history reader 的完整性要求 |
| 40 | 專案範圍已變更或撤銷，同一會話仍可讀取原範圍的保留結果 | own-session shortcut 繞過 `sourceId` 不相符的拒絕，並錯誤假設程序重啟會改變來源身分 | 先核對目前範圍的 source identity，再套用既有 own-session 與 visibility 規則。同權限冷啟動仍可讀取原結果 |
| 41 | writer 完成準備後、進入 native 寫入前短暫發布 ready，新工作會在這個空隙進入並失敗 | pending write 直到 `beforeIssue` 才建立，已接受操作的準備與提交缺少連續 reservation | 同一操作持有 staged／issued phase，discard 或原始提交結果才釋放。新工作嚴格拒絕 busy，已捕獲工作的延後核對保留原 action／member／source／fence 證明 |
| 42 | conversation hydration 讀取歷史期間可與 writer 交錯，造成原始 archive extent 改變及準備失敗 | lazy reader 的實際 I/O 生命週期未納入既有 admission reads 與 cleanup debt | 整次 hydration 持有原始依賴 scope，close 完成後才發布 ready，共用 hydration 完成訊號，每位呼叫者取得自己的 archive lease。原始 close callback 重入時明確拒絕自我等待 |
| 43 | 指令投影提交期間收到同政策、同權限的檔案失效通知，正常請求會在模型呼叫前被拒絕 | 暫時 dirty 與讀取失敗共用 unavailable 表達，post-publication 路徑缺少有限重建分類 | 由既有 snapshot witness、health 與 epoch 證據確認可重新觀察的 dirty，導入原有 bounded stale rebuild。權限／政策／讀取失敗繼續拒絕 |
| 44 | Code 在 worker 啟動前遇到原 hook epoch 永久撤銷，失敗結果與清理會持續停留 recovery-required | 工具已進入原始 dispatch，synthetic failure 仍依賴已撤銷 surface 的投影。每次 drain 都重試同一個無法再成立的投影 | 原始通道確認 scope 已撤銷後，既有 slot 保留一次失敗。經原始 prepared outcome 核對的 failed／canceled 結果使用固定遮蔽 payload，耐久 ACK 後回報原錯誤。未知效果繼續等待原始恢復 |

第二輪結構整合另外重現以下問題。編號延續原始清單，測試包含正常公共入口及原始 I/O 的故障注入。

| 編號 | 問題與實際影響 | 根因與處理 |
| --- | --- | --- |
| 45 | legacy 會話的修改已回覆成功，緊接的格式遷移卻發布較早內容 | 遷移未取得舊 writer 的排他權。現在持有原始 legacy ownership，從讀取至發布保持互斥，並在取得後重驗 modern generation |
| 46 | 同一 navigation／project-binding key 在 modern 寫入後，legacy 再次成功寫入的值被讀取路徑遮蔽 | 兩種儲存未共享 key 的寫入歸屬。兩側使用既有 document lease，modern doc／doc-clear 形成持久 claim，legacy 拒絕被取代 key 的後續寫入 |
| 47 | JSONL 及 commit coordinator 在 close 成功後仍能接受 metadata 寫入，close 也可能越過已接受工作 | 公開方法缺少統一 admission 與完成屏障。關閉立即停止新 I/O、等待已接受 promise，再由原 owner 清理。原始操作內自我 close 明確拒絕自我等待 |
| 48 | 呼叫者修改 snapshot 或 append 回傳的巢狀內容，污染共用 scan cache 與另一讀者的歷史 | 已驗證 record 仍是共享可變物件。decode 後凍結 JSON-owned tree、scan vector 及衍生 seed，保留增量共用 |
| 49 | 等待 writer lease 時修改 create input，或開啟後修改 options，可改變已接受資料或 sidecar 目標路徑 | 寫入晚讀 caller-owned 物件。create 在第一個 await 前捕獲 payload，handle 持有固定 root／sessionId／I/O；metadata patch 亦在 admission 時捕獲 |
| 50 | 初始化、probe、sidecar 或 maintenance 的 close 失敗後，原始資源失去可重試 owner | cleanup rejection 被忽略或只回傳一般錯誤。commit-log 保留原始資源與 cleanup capability，按照取得的反向順序關閉，未完成 file close 時繼續持有 writer lease；上層 coordinator 與 document claim reader 保存該責任 |
| 51 | native release 失敗已清除 held 標記，第二次呼叫被當成成功，或重試數值 descriptor 關閉錯誤資源 | held 與 disposal ACK 混為一談。原始 native close 的成功才完成釋放，失敗包含 falsey throw 持續保留，已消耗的 handle 不再重關 |
| 52 | child birth 以同 operation ID 重試卻改變 metadata，可能回覆 ready；後續可變 metadata 也能誤導 birth inspection | 重試比對未涵蓋 immutable header、實際 birth prefix 及 manifest。現在核對原始提交身分與完成資料，receipt 使用真正的 managed document owner |
| 53 | 原生 Task 已持久完成，冗餘 job／table 保存失敗仍令關閉永久失敗 | 同一 terminal 狀態具有多份寫入責任。原生 Task 以 V3 document 與原始 ACK 為準，對應輔助投影使用原建構器的記憶體狀態，省去冗餘 journal 寫入 |
| 54 | Task recipient 已提交 receipt，關閉時的 fresh currentness 檢查卻把 ACK 丟失，outbox 留在 pending | 已接受 drain 與新工作共用 fresh admission。原始 receipt 保留已知結果，Task owner 關閉先等待已接受 drain，進度透過 await 前捕獲的真正 settlement source 保存；held ACK、unknown ACK 及 close 後重開均已通過 |
| 55 | Stop 的 receipt 等待與已完成 action 的 settlement 互相等待，恢復無法前進 | 等待順序形成循環。先收尾實際完成 owner 的 action，再等待原始 Stop receipt，最後發布指令投影 |
| 56 | 真正的 Team child 已完成，completion observer 卻收不到回呼，parent 沒有完成通知 | observer 只包住 `updateJob`，原始 registration／projection 直接發布 registry。使用者後續決定移除 Team，對應 observer、actor 與工具入口已隨 package 清除 |
| 57 | CLI 明確設定 Shell timeout retry，第一次執行已逾時後，第二次被回報 `Not the original prepared Shell body` | retry guard 直接重進 `tool.execute`，與原生 body／source 的一次性歸屬衝突。dispatcher 現在等待原始執行及清理 ACK，建立不同 attempt／source，再核對權限。CLI、managed、nested Code 的實際重試已通過，未知清理阻止第二次效果 |
| 58 | CLI 的初始 generation 在模型解析期間到期，已知失敗仍變成無法完成的 cleanup | `initialInput.close` 與 assembly disposal 並行，後者提前關閉取消未提升輸入所需要的共用來源。原始輸入 close 確認後再關閉 assembly，未知結果保留原 owner 與同一 close 供重試。14 項正常入口與真實未知 closure 測試通過 |
| 59 | 本輪省去 Task 輔助保存後，冷啟動 `resume_agent` 無法找到原有 child，後續訊息沒有寫入 child log | 舊 cold restore 只掃描輔助 table。現在由真正已確認的 Task registry 與相符 child-birth 重建 child／job 投影，再走既有恢復與續作入口。實際冷啟動送訊已通過，整組續作與關閉回歸仍在驗證 |
| 60 | 原生 Goal／Plan UI 的 metadata 操作被自己的 staged write 拒絕為 `FACT_PRECONDITION_STALE` | 已捕獲寫入的 guard 再次要求 fresh runtime admission。現在使用原始 action lifetime 核對，保留原有 observation prefix／fence 核對及入口的完整 runtime admission。真實 Goal 建立、Plan 切換與取消的兩條路徑已通過 |
| 61 | CLI 冷啟動忽略目前保存的角色、follow-up 游標及明確關閉的 child 狀態 | 保存端寫入 subagent snapshot 格式 2，入口 predicate 只接受格式 1。入口現接受既有 parser 支援的格式 1／2，實際冷啟動續作及 close opt-out 回歸已通過 |
| 62 | 重試的第二次執行結果未知或工具已撤銷時，可能取回第一次執行的結果，錯誤地完成呼叫 | 每次 attempt 現持有自己的 sink，重試等待完整 dispatcher-body 與原始清理。原生 producer 宣告的 unknown 持續保留，已知取消可完成遮蔽的失敗收尾。六項實際 native／nested Code 案例全部通過，涵蓋第二次 unknown、撤銷、清理及零重複效果 |
| 63 | Windows PSEC 沙箱在存在未就緒光碟機時無法建立，回報 `0x8007000f` | 原生 readiness 查詢現在辨識未就緒的光碟與可移除媒體，省去這些 volume 的 read grant，其他錯誤繼續拒絕。已重建 helper、bridge 與來源 manifest，實際驗證允許目錄可寫、唯讀目錄拒寫、未映射 volume 拒讀寫。原生單元 52 項、smoke 34 項通過，標準矩陣為 39 通過、4 不支援、0 失敗 |
| 64 | Code Mode 尚未取得 Worker 或產生資料，執行前失敗卻保留一個永遠無法取值的 recovery source | 通用 dispatcher 在 body 開始前呼叫 `observed()`。現在於實際回傳時觀察通用 body，producer 的原始 observation 由 producer 管理，結果選取限定目前 attempt。Code Mode 完整 377 項及 Core Tools 完整 188 項通過，修正已提交為 `c90fa625` |
| 65 | SDK child 的工具在執行前已被撤銷，結果卻記為 `unknown`／`dispatched` | catch 把初始 `unknown`／`not-dispatched` 混同實際執行結果未知，並硬寫 dispatched。現在使用原始 prepared execution 的 dispatch，已知未執行保存 failed，實際未知繼續保留。SDK 原始入口 4 項及六項 native retry 控制通過 |
| 66 | selected metadata 每次 iterator step 都重新掃描整個 legacy namespace，讀取成本隨列數與資料量相乘 | 讀取實際 metadata 的路徑仍經過 writer resume、SQLite reopen 及閒置全域盤點。修正後五列完整枚舉為 3 次頁面開啟，101 列為 9 次頁面開啟、303 次 canonical 檢查及 12 次 inventory。保留 shared gate、原始 descriptor cleanup、來源及 EOF 檢查。101 列的真實準備與完整讀取合計 20.526 秒，原 15 秒案例期限不足，其他五秒期限及負向案例仍在逐案驗證 |
| 67 | 原始 publication 已恢復並確認 final，返回前的閒置清理又把結果轉為 blocked | publication 與 passive inventory 的確認條件不同。現在普通及 cold selected reader 都接受經驗證的 matching pending prefix 與確切名稱，同時要求已確認 final，保留實體檔案與配額記帳。真實 lost-link 恢復至正常 metadata EOF、cold V2 只讀檢查及衝突負向控制的 4 項測試已通過 |
| 68 | 長時間存活的 Code Mode mount 隨每次失敗 admission 累積 cell ID 與 WeakMap | `failedAdmissions` 只在同 UUID 再次 admission 時刪除，正常執行使用新 UUID。現在由原始 cell finalization 在 terminal、publication fence、runtime 及 broker join 全部確認後釋放去重記錄。未知 admission 與失敗回呼繼續保留原記錄，相關控制及 Code Mode 完整套件通過 |
| 69 | Code Mode 設定為 only，沒有 host default surface 的正常服務仍把完整工具清單送給模型，預算也可能使用另一份 schema | Code mount 的 schema reader 只接到可選的 default surface。現在由 managed runtime 接收原始 mount 的 reader，同一個選擇供應模型 schema、初始 overhead 及 model rebind。off／mixed／only 的實際請求及 mode-only 內建立、續作 Task 共 4 項通過，修正為 `449e3dc4` |
| 70 | 管理操作已排隊收回可見性，正在讀取的結果頁仍能把內容回傳 | 公開頁面的檢查沿用已接受工作之內部 drain 許可。現在利用既有 blocked／retired 狀態，在目標及祖先 I/O 前後核對發布條件。結果頁、管理 fence 及平行讀取正向控制共 19 項通過 |
| 71 | 當前 V3 Task 文件已損壞，目錄仍可能退回逐字稿而顯示 completed | 目錄只檢查版本及 tasks 陣列，缺少 canonical codec 對 notifications 與 Task rows 的驗證。現在直接重用 `captureTaskV3Document`，涵蓋有效空 V3、缺欄、錯誤型別、錯誤 Task row 及未支援 V4。目錄與原始 ownership 相關 32 項通過，修正連同結果發布 fence 提交為 `8d9b820b` |
| 72 | Code Mode 子代理的第二輪 `turn/end` 已提交，立即關閉服務卻令原始結果永久停在 recovery-required | 已接受 followup 的 pending 投影誤用 new-work facade，先被已退休的 parent 拒絕，後續清理再令尚未確認的結果 lifetime 失效。`c4665b39` 由原始 generation 持有受限的 pending／final 發布與每個階段 ACK，Task 關閉等待原始 drive、結果、投影與輔助寫入。未知寫入保留同一不可變 snapshot 與原 writer。原生前後寫入故障、未知結果 ACK、取消、owner 替換、移除及完整關閉重建控制已通過 |
| 73 | `code_wait` 的實際回覆已是 completed，持久化 envelope 卻仍為 failed，模型收到 `isError: true` | 原始 terminal receipt 延遲觸發 recovery-required，稍後保留的 observation 已完成，舊失敗標記卻沒有更新。`41fb70c7` 由真正 observer 在直接或恢復結果 ready 時宣告結果。`code_exec` 使用 cell outcome，`code_wait` 使用查詢是否成功，原始 instruction replan 保持 failed。六項可控制 ACK 案例、Code Mode 完整 383 項及三項子代理整合通過 |
| 74 | 長對話反覆重建完整 conversation projection、複製與編碼快照，257 個指令目標案例原先在期限內只能完成 248 次讀取 | 實際 65 目標基準量測每次模型請求約十次完整 capture，670 次快照合計約 25.17 秒。私有不可變資料重用、相同位元組的短字串編碼，以及先檢查 retirement disposition 的短路條件，使 65 目標少了 67 次完整 capture。最終 257 案例以 507.775 秒通過，保留單輪 540 秒與案例 600 秒期限，指令選擇、revisit 及 watcher 清理斷言通過。輸出保存、Code Mode 與相關型別檢查通過，修正為 `d3d94e5d` |
| 75 | 公開 raw durable `spawnChild` 在有繼承事件時先發布非零 seedLength header，再開啟尚無 seed 的 child，可能留下部分 birth | `0015a24a` 改用既有 generic semantic bootstrap、原始 document 及 initial receipt。原始 Task B2 身分核對持續執行，reviewer 使用真正的 parent allowance，非持久化行為與有／無 seq 的 memory parent 均有控制。參數使用自己的捕獲資料，原始 callback receiver 與結果來源的 admission 順序保留，正常入口及取消／恢復驗證通過 |
| 76 | 冷啟動完整性測試在真正 I/O 前用完五秒期限，未完成工作繼續使用全域 fault hook，干擾後續案例 | integrity fixture 在第一個案例內才載入完整產品模組。移至隔離檢查後的測試收集階段，並讓 publication gate 同時觀察原始 flight 的提前結束。原來的五秒期限保留，冷查詢與其它 cleanup 驗證已通過，修訂為 `df7c634a` |
| 77 | Gateway fork 有大量重複 currentness 核對 | Gateway 基準的一個 reference execute 為 13.661／14.764 秒，包含 91,870／100,155 個原生 proof。`960f237c` 與 `cb42cbab` 重用原始持有者與既有 guard／reader registry，降至 28,222／30,027 個，execute 為 6.964／6.370 秒，所有外部 callback、namespace 及退休負向控制保持通過。Gateway 的剩餘成本繼續分析。Task 先前的高延遲另經確認含有第 81 項測試包裝成本 |
| 78 | Generic bootstrap 的完成資料已實際寫入，遺失 ACK 後卻無法完成 coordinator close | `0015a24a` 將相同 `b.pending` key 的原始 document reconcile 接到 bootstrap owner 的關閉責任，僅在 committed／absent 獲得證明後清除。實際一次 append、零模型請求、重複 unknown、原始 key／bytes、known-absent 保持 reserved、同一 native handle 的釋放及 consumed-close 負向控制均通過 |
| 79 | Commit-log 的 target-only binding observation 拒絕合法的空 existingSessionIds | `0015a24a` 限定修正 target 方法的 parser，新目標本身提供實際觀察範圍。既有純 existing-read 的非空要求與 ID、重複及數量驗證保留。JSONL 與 commit-log 的正常建立、target-only 與空 existing-read 拒絕均通過 |
| 80 | Commit-log observation 在 callback 拋錯後仍可使用，呼叫者也能改動預期快照而掩蓋並行變更 | `0015a24a` 於 callback 的 finally 撤銷，預先持有自己的 JSON 深度不可變快照與 fingerprint。14 項控制及型別檢查通過，包含 falsey 錯誤、真正儲存的 escaped observation，以及 metadata／binding 並行變更檢查 |
| 81 | 故障測試無條件包裝每個 native lease，失去原始 handle 身分並放大驗證成本 | runtime 依據 opaque handle 執行額外核對。`b991ed7e` 將包裝限定於明確選取的故障 handle，同樣 profile 的 replay 由 29.884 秒降至 7.688 秒，bootstrap 由 15.111 秒降至 3.257 秒。完整 Task launch 30 項在恢復 20 秒操作及 15 秒 cleanup 期限後通過。Persistence fork 的同類 fixture 也已修正，32 項於原五秒期限內通過 |
| 82 | 完整 semantic structural export 只有一個合法 fact frame，JSONL 讀者卻要求原生 birth 的兩個實體 frame 及 stage | `9706aa9b` 讓普通全歷史讀取驗證完整邏輯 seed／completion／initial。存在 native bootstrap namespace 時仍驗證原始 stage 與 phase，writer dependency 及 managed activation 使用自己的原始證據。118 項整合控制、19 項 typed fixture 複驗與兩個 persistence package 型別檢查通過 |
| 83 | 直接關閉 parent document 成功後，再關閉 SessionService 會收到 `FACT_CLOSED` | `42c0b311` 調整 `drainOriginalSourceOwners`，先執行 callback 外部呼叫檢查，再處理已完成關閉的冪等返回。Active drain 持續核對原始 owner 與 recovery debt。完整 Task settlement／native 18 項、原始 source／close 70 項及 consumed native debt 兩項通過 |
| 84 | 真正 format11／12 的未完成 semantic birth 無法恢復，回覆 unsupported | 舊 birth 分支只列入 format13，後續完整 adoption 卻支援 11、12、13。`f2dd1b56` 沿用同一 predecessor 路徑，版本取自真正 semantic header，或 header 尚未完整時已驗證的原始 stage。真正歷史版本的冷恢復、普通舊 header 及缺 Task 文件的 current14 控制已完成 |
| 85 | Generic bootstrap 收到專屬 selected-results 的 V3 payload，拒絕前已留下孤立 Task 文件 | 共用 parser／builder 合法支援 V3，generic 入口缺少自己的協定檢查。固定版本的實際失敗目錄保留了 50-byte `task-target.doc.jsonl`，內容為空 Task V2。`f2dd1b56` 在原有 captured manifest 位置提早回覆 `manifest-invalid`，bootstrap／resume 前後所有目錄項目相同的負向控制通過，selected-results 正常入口持續使用既有 V3 parser |
| 86 | 同一 Task 的原始 ACK 已恢復，關閉仍回報先前的 acknowledgment 錯誤 | `42c0b311` 由既有 source-run association 保存原始 completion chain 與錯誤 occurrence。同一 source、entry、chain、Error 及實際 Task／end／source close ACK 全部相符後，才處理該歷史錯誤。完整 18 項通過，含第一次 external close 的 held-ACK 控制。普通與 falsey 錯誤六項，以及非 required source 的真正 native UNKNOWN 回歸通過 |
| 87 | 原始 birth 已升級，或合法 metadata 改變 header 長度後，冷恢復仍誤判 conflict | 兩個 header reconciler 各自實作版本與欄位比較，其中一條只允許 13→14，另一條只讀原 stage 的 byte length。`f2dd1b56` 共用 immutable birth-header 比較，讀取有上限的完整 header，核對合法歷史版本與可變 metadata。真正 old11 冷恢復、長短 header、保護欄位、非整數版本與 native cleanup 控制通過 |
| 88 | 普通 fact-journal 的 native close 失敗後，原始 descriptor 缺少持續的清理責任 | 六個真正 native 案例均重現 close 錯誤回覆 clean 並釋放所有 exclusion leases，其中四個失敗 descriptor 仍然存活。`f2dd1b56` 重用既有 capture I/O ledger 與 constructor-native association，保存原始 close 方法和每個原 owner，冷開啟失敗的 entry 持續持有清理責任。九項 native cleanup 控制及相關 journal 整合驗證通過，已提交的 receipt 在清理失敗後仍可辨識 |
| 89 | Header 已完成的 bootstrap，在 seed 被暫時拒絕後無法繼續 | 快速恢復分支把 Task barrier 的 header 完成狀態視為整個 semantic birth 已完成，未完成 seed／completion 的重試因此持續 blocked。`f2dd1b56` 使用真正完整 birth 的狀態選擇快速路徑，未完成操作由原 entry、request 及 pending batch 接續，原始重試控制通過 |
| 90 | 已有原始 Task 文件及部分 birth 的冷恢復，被送進要求全新目標的初始化檢查 | `f2dd1b56` 依既有 retained／published proof、實際 Task 文件、原生 namespace 身分及位元組前綴選擇恢復流程。`a6d3f41e` 補齊已完整 seed 後的一個未提交 completion 尾段，原始 journal 取得實際 completion batch 後仍核對整段尾部才可修復。完整 syscall crash、foreign bytes 及非空 artifact 順序控制共 18 項通過 |
| 91 | 原始 journal descriptor 已成功重試關閉，同一 coordinator 仍被舊 process-read poison 阻擋 | Opening、document close 與外層 retirement 各自結束 mutation token，第一個 disposal failure 留下的 unknown 狀態無法由後續成功的另一個 token 結束。`f2dd1b56` 由同一 managed entry 保留與共用原始 token，實際清理完成後結束它。附著、cold pre-attach 與 opening／close overlap 的同 coordinator 重開控制通過，舊 reader 持續失效 |
| 92 | SDK 與 legacy fork 測試在初始化失敗或逾時時，可能遺留子程序、HTTP listener 或 native ownership，並干擾後續驗證 | 原 fixture 完成 setup 後才交出 cleanup，初始化拒絕時 caller 無法取得部分建立的 owner。`0624727c` 修正原始 SDK／child／server 生命週期，真實無效 store、九項授權／sandbox 控制及 CLI 型別檢查通過。`73082c41` 補上 legacy helper 的同一 partial owner 清理與失敗重試，真正 native leak、falsey cleanup、並行 sibling 與既有讀取控制通過 |
| 93 | 同一 Job producer 重複呼叫 finish，已完成狀態仍再次通知訂閱者 | 完成函式已防止重寫 outcome，通知仍在去重條件外。`b36a8de2` 讓重複 producer completion 冪等，原始 Task 投影仍可補上終端身分。原有 Jobs 19 項、新增原始 Task 身分一項及 Subagent 型別檢查通過 |
| 94 | 原始父寫入 UNKNOWN 已恢復，Task 關閉仍保留先前的就緒錯誤 | `7ed799c1` 綁定同一原始 parent proof、source、batch 及錯誤 occurrence，要求實際安裝成功或確認不存在，以及 Task／end／source close ACK。原重現、外來錯誤／parent／方法替換、持續 UNKNOWN、公開 view 延後建立及已關閉 parent 等控制通過，包含於 122 項定向驗證及五個套件型別檢查 |
| 95 | 已成功保存 Task 後，等待另一個已接受的父寫入仍被誤判為不可加入 | 原始 Pending 與 issuer 已建立，沒有清理債務的 await 及 tracked 排程卻讓 prewrite 登記延後。`7ed799c1` 省去無工作 await，並於真正原生 append 入口登記既有排程身分，在 beforeIssue 與所有退出路徑移除。真正 cleanup debt、opaque wrapper、錯誤 batch／方法及取消控制通過，包含於同輪 122 項驗證 |
| 96 | 舊模式子代理已完成，恢復到 Task2 後卻在嚴格保存前拒絕完整文字結果 | Retain guard 以儲存版本推斷一定存在 body producer。真正 Task2 schema 允許無 descriptor 的完整 resultText／error，舊模式本來也透過 strict document 保存。`aff1966c` 首次修正又把文件 ownership 視為 capture 能力，完整測試重現九項回歸。`984963d3` 僅以真正 resultOwner 判斷，原有 55 項保存測試及擴充 17 項矩陣全部通過，原始 body／ACK／歷史完整性要求保留 |
| 97 | 重啟後 pending 結果缺少原始 capture，仍可只靠 Task 文件保存而被標示 durable | 完整性檢查只處理缺少 result 的情況，pending descriptor 因為存在而跳過檢查，缺少 result owner 又略過 settle。`aff1966c` 在缺少原始 capture 時拒絕保存，控制核對零次文件寫入、原 descriptor／revision 保存及原始 producer 的獨立完成。原始故障與修正後驗證均已記錄 |
| 98 | 歷史 artifact 缺少可用 reader，重試結果保存仍能把 retention 由 failed 改成 durable，訂閱者亦可能收不到狀態變化 | 文件 ACK 與 body 可讀性缺少共同核對。`b07b22a5` 在原始保存身分核對後拒絕不可讀的歷史 artifact，恢復 reader 時沿用真正 ACK，並只在 retention／error 改變時發布通知。15 項資料矩陣及六檔 38 項通過。曾嘗試以 savedObservation 提早成功，因複製該資料可繞過 live 結果的嚴格保存而撤回 |
| 99 | 子任務完成與父會話 step/end 交錯時，合法父寫入被拒絕，通知持續停在恢復狀態 | 父 writer 已取出並接受 queue entry，等待 core.prepareWrite 時尚未建立 Pending。Task writer exclusion 在此空隙取得排他權，父準備完成後拒絕原始 step/end。`42dfc339` 保留同一 preparing entry，在實際 backend 呼叫後喚醒等待者，再核對原始 Pending／native prewrite 並等待完成。相同控制在 `984963d3` 重現 not-issued，修正後與第 100 項合計 49 項原生及 Task 整合控制、四個套件型別檢查通過 |
| 100 | 已釋放的 writer exclusion 在 resume 等待完成後重新取得排他權，後續寫入可能被已退休 owner 阻擋 | resume 僅在 await 前檢查 retired，release 發生於等待期間時，晚到的 continuation 仍發布 requiredWriter。原始已 issued native batch 的案例在 `984963d3` 重現，`42dfc339` 在發布排他權前重新核對 retired。Preparing 與 issued 兩種等待情況均通過，後續正常 metadata 寫入亦通過 |
| 101 | managed runtime 已有原始工作狀態讀者，查詢仍重新載入 profile／snapshot，私有 runtime 因而無法讀取 Todo 等已提交狀態 | `d7e534be` 優先使用既有 managed adapter 的 read，冷會話沿用 snapshot 讀取。測試使用真正服務與原始 lookup，驗證已知 writer 期間的舊提交內容、ACK 後的新內容及零模型呼叫。三檔 23 項與 Gateway 型別通過 |
| 102 | commit-log Desktop 正常回合結束後，host 關閉與重啟因 Task 文件衝突失敗 | commit Task captureParent 遺漏原始父身分的 assertOriginal。`0d245d43` 重用既有 captureManagedTaskParentReadiness。18 項原始身分控制、Desktop 完整 9 項及三個套件型別通過。Gateway 相關 24 項中 23 項通過，長會話壓縮另有 coordinator 清理狀態問題待處理 |
| 103 | 新會話已送出的文字復活，且 ACK、草稿清除失敗或跨 remount 交錯可能遺失重試身分 | `d1047acb` 區分持久化更新與真實編輯，從原 scope 讀取 live metadata。真正 clear ACK 後，在同一次清空草稿保存中消耗仍屬本次的 session／input 關聯。舊 ACK 保留較新送出的 token。舊版本同控制先重現六項失敗，追加的持久中間態及跨 remount 控制再重現兩項。最終 11 檔 87 項及 Desktop 型別通過，DeepSeek 實機及冷重啟確認空草稿與模型選擇保存 |
| 104 | 真正 Desktop 的 Code Mode 連簡單 JavaScript 都在 admission 階段失敗 | 原始追蹤確認 Desktop 授權政策讀取呼叫 fresh-domain 檢查，Code 提交自己的 delivery-source 時因 staged write 被拒絕。`3d65db47` 使用原 lifetime 與 committed observation，刪除未參與政策計算的 schema 讀取。原生 held ACK、UNKNOWN、同 capture 恢復、角色／權限撤銷及正常 Desktop 控制通過，實際 DeepSeek 已執行並保存 5050 |
| 105 | 背景 Code 完成與下一輪模型回覆交錯時，已收到的有效模型結果在受理階段被拒絕 | acceptModelExchange 前缺少既有有限工作等待。`3d65db47` 在接受同一回覆前加入原 admission waiter，保留嚴格 capture。實際 response-return gate 在舊來源明確失敗、修正後通過，模型呼叫保持一次。完整 readiness 14 項與 review 後新增四項複驗通過。DeepSeek 實機以 yield 0 回傳 running，再由同 cell 的 code_wait 完成 500500 |
| 106 | 重用相同 input token／inputId，修改 context 或 images 仍可能收到原輸入的成功 ACK | `a5646608` 在兩個重試入口與持久 readback 共用完整 payload 比較，逐欄比對有序 image 資料，沿用 absent／empty 正規化。修復過時 receipt 斷言、複製 backend 與未等 AsyncInbox ACK 的 fixture。原版本同測試重現錯誤接受，最終四檔 12 項與 Gateway 型別通過 |
| 107 | 閒置時送出的 steer 已被排為 queue，同一輸入重試卻被判為 payload 不符 | `a5646608` 依原 admission 的有效 delivery 比對重試。既有 queue 可將 steer 重試回覆為原 queue ACK，既有 steer 仍拒絕 queue 重試，持久 readback 保持精確比對。此為本輪明確採用的語義決定。真正 idle／busy／冷重啟控制通過，原 source 同案例重現拒絕 |
| 108 | 背景 Code 執行期間讀取 session/history 可回覆需要 reconciliation，隨後 close 也失敗 | 原始追蹤確認 archive 讀取 46 個事件期間，正常 writer 將同一健康 generation 推進至 47 個事件。`e613aee0` 以既有 session 操作順序保護完整 materialization，準備寫入保留並等待自己之前已開始的 materializationRead，在任何 await 前拒絕自我重入。八項原生控制、正常 Desktop 歷史讀取及兩個 package 型別通過。另一個發生在 history 前的 archive changed 記錄仍另行保留 |
| 109 | commit-log 長會話壓縮無法發布，coordinator 關閉留下 sourceFault | 捕獲的壓縮政策只需 reserveRatio，卻讀取整份 budgetConfig，觸發自己 staged write 期間的 fresh admission。投影 systemPrompt 亦有相同邊界問題。`21f8d861` 直接讀取 live reserveRatio，純投影使用原始 lifetime、descriptor 與 committed observation，保留真正政策撤銷及執行 admission。原 120 秒案例於 20.902 秒完成壓縮、發布及關閉，七項原生／撤銷控制與型別通過 |
| 110 | 相同文字的新編輯再次送出，可能被原 input token 當成舊操作去重 | `5379efea` 在第一次 await 前保留既有 token／creationToken 與原始 metadata，真正使用者編輯使原送出身分失效，後到的建立、摘要與 ACK 僅更新仍屬本次的身分。沿用既有持久欄位，未編輯的冷恢復重試保留原 token。相同來源對照重現失敗，最終定向 18 項及相關 11 檔 94 項通過，Desktop 型別通過 |
| 111 | SDK service request 拋錯後沒有回傳 JSON-RPC failure，客戶端一直等至 60 秒逾時 | 實機日誌捕捉到 session/tasks 逾時。`906f49bc` 在 request 邊界重用 hostMethodFailure，response emit 保持獨立。原版 typed／undefined／0 三個服務錯誤直接逸出，修正後同控制通過，SDK 全套 145 項、最終五項複驗及型別通過。舊 Gateway stderr 未保存，實機那次的原始例外種類仍無法確定。後續原生控制確認健康 parent writer 期間原始 Task 讀取已可正常完成，第 114 項另修正 Task 自身未知保存的讀取 |
| 112 | Windows 較長資料根目錄使 SQLite 建立／搜尋／清理失敗 | 原生控制證明 255 字元的 DB 路徑可開啟，263 字元的 journal 失敗，extended namespace 路徑正常。`e1354ef3` 在原生 SQLite 開啟邊界使用 toNamespacedPath，保留原始路徑驗證與 journal 策略。同樣長路徑控制由失敗轉為通過，實際四 artifact 生命週期案例恢復通過，Context 型別通過 |
| 113 | 更長的 Windows 工作根目錄在建立原生 session lock 時失敗 | 真正超過 300 字元路徑在 SQLite 之前收到 CreateFileW Win32 3。`b0a868ce` 在原生開啟邊界使用 toNamespacedPath，相同失敗控制轉為通過，普通與 namespace 別名保持同一互斥鎖。fs-lock 全套 136 項通過、六項既有略過，包含跨程序共享／排他、正常釋放及崩潰釋放控制，型別及 Context 長路徑整合通過 |
| 114 | Task 自身保存結果未知時，Task 列表仍可暴露未確認狀態 | 原始 required projection 已拒絕 UNKNOWN，list 缺少同一持久化健康檢查。`295b6951` 由原 persistence 的 debt、pending outcome 與 cleanup 狀態提供 assertReadable，registry 在原 assertReady 後核對。原生 UNKNOWN 控制由失敗轉為通過，健康 parent writer 的 public／private 讀取保留原行為，五檔 43 項及兩個 package 型別通過 |
| 115 | 部分測試在原始 I/O 前便失敗，預定故障及恢復流程未被執行 | 測試替身漏掉實際 export、建構後替換受身分保護的 backend 方法，或建立缺少 seedLength 的 child／只有 header 的繼承歷史。`614680d2` 沿用真正 constructor 的 wrapOwnedBatch／wrapOwnedReconcile，補齊實際模組 export，排程控制使用完整合法歷史經正常讀取／升級。第一批 30 項及兩個 package 型別通過，其餘同類失敗繼續逐案處理 |
| 116 | Code 崩潰控制仍假設只有工具結果及文字輸出兩份 artifact | 正式流程另外保存 code-output-manifest，舊斷言在正確完成的結果上失敗。`614680d2` 核對三份實際保存，並驗證 manifest 的 owner、位元組數、摘要、原 cell、輸出 reference 及 completed seal。完整 12 項原生崩潰／恢復控制通過 |
| 117 | 跨程序測試的期限及 fixture 資源責任與實際工作量不一致 | 已走通的 Code 崩潰／冷讀案例實測 30.035 及 34.326 秒，原 30 秒期限提前結束案例。`614680d2` 將此檔案調為 60 秒、子程序 receipt 期限由 20 秒調為 30 秒，記錄原始程序時序。排程 fixture 明確等待 assembly 與 coordinator 清理，setup 失敗亦嘗試原始資源清理。第一個普通 setup 曾在零 provider request 下用完 20 秒，其延遲成因仍未定位，後續完整控制通過 |
| 118 | 閒置清理失敗後，查詢與清理重試無法恢復原有服務 | acquireLifetime 正確拒絕尚未完成的 retirement，但服務的新使用入口沒有先重試原始清理。`675282ad` 在既有 exclusive gate 內先等待相同 quiesce，再取得使用權，涵蓋查詢、變更、設定、passive continuation 及撤銷／刪除入口。兩項原生控制在舊版本失敗，修正後通過，確認舊 lease 已釋放才取得下一個 lease。已消耗但 ACK 未知的 close 仍回傳原始 falsey cause，close／acquire 次數各維持一次。251 項回歸及五個 package 型別通過 |
| 119 | 撤銷槽部分寫入後，正常 clear 在恢復入口被擋住 | 原始 terminalSlots 支援在明確清理授權下完成未寫完的 inactive 槽，但 inventory 先要求完整 live／terminal，導致正常 clear 無法到達恢復步驟。共用原始槽驗證，核對 active 完整 tuple、精確容量及 inactive 原生檔案條件後才允許清理盤點。被動讀取仍要求有效的完整狀態，原始檔案清理債務必須先結清。四項新增控制核對 active 內容／大小、inactive 大小及外部 hardlink 均拒絕，canonical bytes 保持原狀。功能檔案 47 項通過，相關八檔 181 項通過、兩項既有 funding 失敗待處理，Context 型別通過 |
| 120 | runtime context 的保存結果未知時，後續正常提交被恢復順序永久擋住 | 原始 publication 要等同一 capture 完成確認才結束 action，startTurn 卻先要求 finished action 才允許確認 pending frame。調整既有三個恢復入口的順序，先確認原始 runtime publication，再收尾 finished actions 及 Stop。四個正常 SessionService 案例以已提交後隱藏 ACK，或真正原生零位元組寫入得到 absent 後隱藏 ACK，驗證持續未知、後續提交及恢復中 Stop。舊版本四項失敗，修正後四項通過，原五秒期限保留。128 項相關控制及 Executor 型別通過 |
| 121 | 沒有繼承歷史的真正 Task child 無法讀取自己的 legacy 結果 | 正常 observed read／search 嘗試讀取不存在的 legacy fork plan。Gateway 現於原始 observation lifetime 登記真正 document／view，ContextOutput 使用既有 service-bound zero-source proof 驗證零 seed 的原始出生資料，支援其實際 local-only 讀取及轉移。原生身分替換拒絕、來源失效及內容可見性控制均保留 |
| 122 | selected target 的反覆 currentness 檢查重建整份不可變 seed，放大 fork 成本 | CPU profile 定位到重複 selected preparation、stage 解碼與 canonical JSON。原始 capture attempt 完成驗證並深度凍結後，只派生一次 preparation facts，後續每次仍核對原始 owner、route、native held lease 與 live source。關閉重用的對照案例中，反覆確認讓派生次數由 28 增至 94，候選控制驗證重複確認不再增加派生，真正來源變更仍拒絕 |
| 123 | selected-results 的 managed rows 未納入實際依賴轉移，READY target 缺少結果內容 | 原確認只讀 manifest.artifacts，壓縮／reset 後僅保留在結果投影的 managed roots 因而遺漏。共用請求建構器合併兩份已驗證宣告並核對完整 ref，V2 原始請求在首次發布前固定，binding 與 closure 加入 results digest。額外未選取 ref、替換 digest、政策失效及 cross-version 控制通過，空 V2 亦使用自己的 closure |
| 124 | JSONL selected target 冷恢復缺少真正 project／managed／legacy qualification 組合 | 在既有 coordinator factory 安裝一次原始 qualifiers，由 broker、managed results 與 legacy plan 各自持有資格及清理責任，再經原始 cold finalization 完成 READY。Metadata-only qualification 可在停用新 capture 時執行，body read／search 仍核對功能狀態。完整 C67 的 compaction、reset、來源 clear 及 cold target 精確內容控制通過 |
| 125 | JSONL selected-results kernel 與公開 Gateway／SDK 入口尚未接通 | Host 目前只為 commit-log 安裝 V2 controller，JSONL 的原始 capture／publish／cold finalization 仍只由內部原生整合案例驅動。需要使用實際 host 入口完成 operation identity、重試、冷恢復及關閉整合，公開 JSONL 功能尚待交付 |

### 程式定位

| 問題編號 | 主要實作與檢查位置 |
| --- | --- |
| 1、3、4、5、6、10、34 | [commit-log store](D:/codex-ih-development/packages/session-commit-log/src/store.ts:143)、[incremental fold](D:/codex-ih-development/packages/session-commit-log/src/fold.ts) |
| 2、7、8、9、17 | [commit coordinator](D:/codex-ih-development/packages/session-persistence/src/commit/coordinator.ts:184)、[prefix derivation](D:/codex-ih-development/packages/session-persistence/src/commit/managed.ts:15) |
| 11、12、14、28 | [SessionService activity](D:/codex-ih-development/packages/session-executor/src/service.ts:1836)、[runtime manager](D:/codex-ih-development/packages/desktop/src/main/sdk-runtime.ts:235)、[owned schedule](D:/codex-ih-development/packages/session-executor/src/owned-schedule.ts) |
| 13、22 | [compiled smoke](D:/codex-ih-development/packages/desktop/scripts/smoke-compiled-gateway.mjs)、[root package](D:/codex-ih-development/package.json)、[verification workflow](D:/codex-ih-development/.github/workflows/verify.yml) |
| 15 | [sidebar ownership](D:/codex-ih-development/packages/desktop/src/renderer/shell/ProjectSidebar.tsx) |
| 16 | Team 的完整移除範圍及歷史讀取相容性記錄於本報告「Team 移除決定」章節 |
| 18、19、20、21、25 | [SDK client](D:/codex-ih-development/packages/sdk/src/client.ts:84)、[error display](D:/codex-ih-development/packages/desktop/src/renderer/design/error-display.ts:21) |
| 23 | [provider facade](D:/codex-ih-development/packages/provider/src/index.ts)、[boundary gate](D:/codex-ih-development/scripts/audit/check-package-boundaries.mjs)、[reachability gate](D:/codex-ih-development/scripts/audit/check-reachability.mjs) |
| 24 | [committed observation](D:/codex-ih-development/packages/core-session/src/managed/execution-state.ts:302)、[work-state read](D:/codex-ih-development/packages/desktop-gateway/src/work-state.ts:67)、[native IPC](D:/codex-ih-development/packages/desktop/src/main/ipc.ts) |
| 26、27 | [session management](D:/codex-ih-development/packages/desktop-gateway/src/session-management.ts:198)、[post-turn title](D:/codex-ih-development/packages/session-executor/src/service/owned-post-turn.ts)、[task identity projection](D:/codex-ih-development/packages/session-persistence/src/coordinator/task-parent-metadata.ts) |
| 29 | [binding acquisition](D:/codex-ih-development/packages/session-persistence/src/coordinator/binding-observation.ts:533)、[fork guards](D:/codex-ih-development/packages/session-executor/src/lifecycle/fork-handoff.ts) |
| 30 | [Composer admission](D:/codex-ih-development/packages/desktop/src/renderer/session/Composer.tsx:55)、[durable draft revision](D:/codex-ih-development/packages/desktop/src/renderer/session/durable-draft-client.ts:43) |
| 31 | [instruction mutation preflight](D:/codex-ih-development/packages/session-executor/src/context/instructions/manager.ts:194) |
| 32 | [pure results entry](D:/codex-ih-development/packages/sdk/src/results.ts)、[Desktop results dispatcher](D:/codex-ih-development/packages/desktop/src/main/result-pages.ts) |
| 33 | [deletion preflight](D:/codex-ih-development/packages/session-persistence/src/coordinator/lifecycle.ts:74) |
| 35 | [coordinator construction](D:/codex-ih-development/packages/session-persistence/src/coordinator-factory.ts:70)、[managed factory capture](D:/codex-ih-development/packages/session-persistence/src/coordinator/managed-documents.ts:27) |
| 36、37 | [settings transaction](D:/codex-ih-development/packages/settings/src/storage/transaction.ts)、[SettingsStore](D:/codex-ih-development/packages/settings/src/storage/single-store.ts) |
| 38 | [bootstrap finalization](D:/codex-ih-development/packages/session-persistence/src/coordinator/bootstrap.ts:567)、[child admission regressions](D:/codex-ih-development/packages/session-persistence/test/child-bootstrap-admission.test.ts) |
| 39 | [bootstrap recovery](D:/codex-ih-development/packages/session-persistence/src/coordinator/bootstrap.ts)、[task transition](D:/codex-ih-development/packages/session-persistence/src/coordinator/task-document-transition.ts)、[native composition](D:/codex-ih-development/packages/session-persistence-jsonl/src/backend-factory.ts) |
| 40 | [result authorization](D:/codex-ih-development/packages/session-executor/src/lifecycle/process-result-service.ts:45)、[stable source identity](D:/codex-ih-development/packages/context-output/src/workspace.ts:19)、[cold scope regressions](D:/codex-ih-development/packages/session-executor/test/result-scope-authority.test.ts) |
| 41、42 | [execution state](D:/codex-ih-development/packages/core-session/src/managed/execution-state.ts)、[restored conversation](D:/codex-ih-development/packages/core-session/src/managed/restored-view.ts)、[captured tool body](D:/codex-ih-development/packages/core-tools/src/registry/prepared-body.ts) |
| 43 | [instruction snapshot classification](D:/codex-ih-development/packages/instructions/src/service.ts)、[instruction publication](D:/codex-ih-development/packages/session-executor/src/context/instructions/manager.ts)、[prephysical admission](D:/codex-ih-development/packages/core-agent/src/agent/admission.ts) |
| 44 | [synthetic projection](D:/codex-ih-development/packages/core-agent/src/tool-batch/managed-source.ts:151)、[retained result drain](D:/codex-ih-development/packages/core-agent/src/tool-batch/record.ts:27)、[original dispatch outcome](D:/codex-ih-development/packages/core-agent/src/tool-batch/dispatch.ts:90) |
| 72 | [已接受 followup 發布](D:/codex-ih-development/packages/subagent/src/index.ts)、[原始 Task 輔助寫入](D:/codex-ih-development/packages/session-persistence/src/task-persistence-internal.ts) |
| 73 | [Code Mode observation 結果](D:/codex-ih-development/packages/code-mode/src/register.ts)、[原始 receipt 回歸](D:/codex-ih-development/packages/code-mode/test/retained-observation-outcome.test.ts) |
| 74 | [admission](D:/codex-ih-development/packages/core-agent/src/agent/admission.ts)、[不可變 capture](D:/codex-ih-development/packages/context-engine/src/snapshot/data.ts)、[JSON 串流](D:/codex-ih-development/packages/core-session/src/serialization/json-stream.ts) |
| 75 | [公開 child 建立](D:/codex-ih-development/packages/subagent/src/child.ts)、[原始初始輸入](D:/codex-ih-development/packages/subagent/src/child/generation.ts) |
| 76 | [隔離與 cold fixture](D:/codex-ih-development/packages/context-output/test/integrity-fixture.ts)、[完整性與 publication gate](D:/codex-ih-development/packages/context-output/test/cold-lookup-integrity.test.ts) |
| 77 | [真實 Gateway fork 入口](D:/codex-ih-development/packages/desktop-gateway/test/helpers/fork-fixture.ts)、[native metadata 驗證](D:/codex-ih-development/packages/desktop-gateway/test/selected-native-metadata-debt.test.ts) |
| 78 | [bootstrap 原始 pending 狀態](D:/codex-ih-development/packages/session-persistence/src/coordinator/bootstrap.ts)、[managed document 關閉](D:/codex-ih-development/packages/session-persistence/src/coordinator/managed-documents.ts) |
| 79 | [commit-log binding observation](D:/codex-ih-development/packages/session-persistence/src/commit/observations.ts) |
| 80 | [observation snapshot 與生命週期](D:/codex-ih-development/packages/session-persistence/src/commit/observations.ts)、[callback 與並行變更回歸](D:/codex-ih-development/packages/session-persistence/test/commit-observations.test.ts) |
| 81 | [Task native lease fixture](D:/codex-ih-development/packages/subagent/test/task-child-launch.test.ts)、[fork cleanup fixture](D:/codex-ih-development/packages/session-persistence/test/fork-controller.test.ts) |
| 82 | [archive reader](D:/codex-ih-development/packages/session-persistence-jsonl/src/backend/archive-reader.ts)、[歷史匯出讀取控制](D:/codex-ih-development/packages/session-persistence-jsonl/test/format11-predecessor.test.ts) |
| 83 | [原始 source drain](D:/codex-ih-development/packages/session-persistence/src/coordinator/managed-document.ts)、[正常 Task 關閉與重開](D:/codex-ih-development/packages/session-executor/test/required-task-settlement.test.ts) |
| 84 | [predecessor birth 恢復](D:/codex-ih-development/packages/session-persistence/src/coordinator/bootstrap.ts)、[真正歷史 codec 恢復](D:/codex-ih-development/packages/session-persistence-jsonl/test/semantic-codec2-predecessor.test.ts) |
| 85 | [generic bootstrap admission](D:/codex-ih-development/packages/session-persistence/src/coordinator/bootstrap.ts)、[V3 協定拒絕](D:/codex-ih-development/packages/session-persistence-jsonl/test/selected-results-denials.test.ts) |
| 86 | [entry cleanup](D:/codex-ih-development/packages/subagent/src/index.ts)、[原始 Task settlement](D:/codex-ih-development/packages/subagent/src/tools/spawn-source.ts) |
| 87 | [共用 header 比較](D:/codex-ih-development/packages/session-persistence-jsonl/src/backend/bootstrap-stage.ts)、[captured header 恢復](D:/codex-ih-development/packages/session-persistence-jsonl/src/backend/bootstrap-capture.ts) |
| 88 | [普通 fact-journal I/O](D:/codex-ih-development/packages/session-persistence-jsonl/src/backend/fact-journal.ts)、[pre-attach owner](D:/codex-ih-development/packages/session-persistence/src/coordinator/managed-documents.ts) |
| 89 | [bootstrap 狀態與接續](D:/codex-ih-development/packages/session-persistence/src/coordinator/bootstrap.ts) |
| 90 | [retained birth proof](D:/codex-ih-development/packages/session-persistence-jsonl/src/backend/bootstrap-published.ts)、[原始 Task transition](D:/codex-ih-development/packages/session-persistence/src/coordinator/task-document-transition.ts) |
| 91 | [managed entry 清理](D:/codex-ih-development/packages/session-persistence/src/coordinator/managed-documents.ts)、[公開 retirement 邊界](D:/codex-ih-development/packages/session-persistence/src/coordinator-factory.ts) |
| 92 | [SDK 測試的原始 setup 與清理](D:/codex-ih-development/apps/cli/test/sdk-approval.test.ts)、[legacy fixture 初始化清理](D:/codex-ih-development/packages/context-output/test/legacy-fork-fixture.ts)、[真正 native 失敗控制](D:/codex-ih-development/packages/context-output/test/legacy-fork-fixture-cleanup.test.ts) |
| 93 | [Job 完成發布](D:/codex-ih-development/packages/subagent/src/jobs.ts)、[原始 Task 終態控制](D:/codex-ih-development/packages/subagent/test/runtime-terminal-projection.test.ts) |
| 94、95 | [原始 parent 與 writer](D:/codex-ih-development/packages/session-persistence/src/coordinator/managed-document.ts)、[原生 prewrite 身分](D:/codex-ih-development/packages/session-persistence/src/native-fact-writer-internal.ts)、[原生 journal 入口](D:/codex-ih-development/packages/session-persistence-jsonl/src/backend/fact-journal.ts) |
| 96、97、98 | [Task 結果保留](D:/codex-ih-development/packages/subagent/src/task/registry.ts:177)、[歷史格式、reader 與原始 ACK 矩陣](D:/codex-ih-development/packages/subagent/test/legacy-task2-retention.test.ts) |
| 99、100 | [已接受準備與 writer 等待](D:/codex-ih-development/packages/session-persistence/src/coordinator/managed-document.ts:878)、[準備階段原生控制](D:/codex-ih-development/packages/session-persistence/test/required-parent-preparation.test.ts)、[issued writer 與退休控制](D:/codex-ih-development/packages/session-persistence/test/required-parent-writer-join.test.ts) |

### 跨問題的設計判斷

多個錯誤源於同一個檢查混合了不同生命週期。新的工作需要完整 admission，已捕獲的工作需要核對原 action、來源及 fence，UI 查詢需要穩定的已提交投影，cleanup 則需要保存已知 I/O 結果。舊路徑反覆使用相同的 currentness 檢查，會讓操作被自己的 staged write 擋住，或把已收到的 committed ACK 當成未知結果。調整集中於既有 owner 的狀態與判斷，並以真實提交、關閉、停止及恢復測試驗證邊界。[execution state](D:/codex-ih-development/packages/core-session/src/managed/execution-state.ts) [bootstrap finalization](D:/codex-ih-development/packages/session-persistence/src/coordinator/bootstrap.ts)

過度設計較明確的部分是同一責任有多個可獨立變化的來源。renderer 與 main manager 各自重試、`hasAssembly` 與 managed runtime 各自定義活動、Stop receipt 同時負責去重與活動判斷，都造成狀態不一致。本輪把重試交回主程序，把活動交回 SessionService、request flight 與 fork owner，並讓 receipt 保持去重用途。OpenCode 的 run coordinator 與 ZCode 的 host lifecycle 都有可對照的責任歸屬。[runtime manager](D:/codex-ih-development/packages/desktop/src/main/sdk-runtime.ts) [SessionService](D:/codex-ih-development/packages/session-executor/src/service.ts) [OpenCode run coordinator](D:/ih-reference-project/opencode-2.2.6/packages/core/src/session/run-coordinator.ts) [ZCode host lifecycle](D:/ih-reference-project/ZCode-3.17.2/packages/desktop/src/main/desktopHostProcess.ts)

效能負擔主要來自重複工作。每次 append 全量 fold、只為讀取一小段結果而載入整個 executor、同步 guard 重複遍歷 native 路徑，都可以在保留既有資料與權限契約下縮減。跨越 await、外部 callback、檔案替換或新的 authority 時仍要重驗，否則快取會把實際變更遮蔽。[incremental fold](D:/codex-ih-development/packages/session-commit-log/src/fold.ts) [result parser entry](D:/codex-ih-development/packages/sdk/src/results.ts) [binding observation](D:/codex-ih-development/packages/session-persistence/src/coordinator/binding-observation.ts)

耐久 Task、outbox、原始 batch 與 child birth 證據仍有明確的 crash recovery 用途。參考項目 OpenCode 2.2.6 同樣保留 Job 持久化、恢復與通知去重。適合簡化的是重複投影、共同失敗範圍及介面能力的表達，實際需要的恢復證據應持續由原始 owner 持有。[OpenCode Job](D:/ih-reference-project/opencode-2.2.6/packages/core/src/job.ts:185) [task transitions](D:/codex-ih-development/packages/session-persistence/src/coordinator/task-document-transition.ts)

### 結構成本的重新設計

第 44 項的原始重現透過正常 `onExecutionEvent` 在同一 live context 掛載 listener，推進真實 hook epoch，令 synthetic projection 及兩次 coordinator close 留下相同 recovery debt。後續修正保留真實 failed／dispatched 狀態，以固定遮蔽結果完成原有 finalization 與 fact ACK，再回報原始錯誤。已驗證永久撤銷、原始 unknown receipt 重試、真實 unknown producer 拒絕、重複 drain／close，以及另一程序在 native sync 後、回覆 ACK 前崩潰的冷啟動讀取。[原始重現](C:/Users/IvanKwan/AppData/Local/Temp/ih-permanent-hook-epoch-issue44.txt) [修正實作](D:/codex-ih-development/packages/core-agent/src/tool-batch/record.ts) [程序崩潰回歸](D:/codex-ih-development/packages/code-mode/test/projection-crash.test.ts)

#### S1 Agent 與 executor 的循環依賴

八個 generation／input lifecycle 模組及原始 `OwnedGenerationAction` 實作已移至 `core-agent`。executor 的既有入口重匯出同一實作，保留原始類別、WeakMap 與 owner 身分。Task 資料契約及持久化實作移至較低層的 `session-persistence`，讓 `core-agent` 的產線程式解除對 executor／subagent 的向上 runtime import。一般 generation 的 monotonic 到期檢查與已接受輸入的時間預算都有回歸驗證。[lifecycle](D:/codex-ih-development/packages/core-agent/src/lifecycle/generation-action.ts) [跨入口身分測試](D:/codex-ih-development/packages/core-agent/test/execution-lifecycle-ownership.test.ts)

Team 移除後的邊界檢查為 128 個跨包來源引用。`334484a2` 從既有 147 項 baseline 移除已解決的 19 項，新的 128 項均屬原先集合。Reachability baseline 同時移除 119 個已消失項目，保留原先集合中的 337 項，並移除已失效的 `SdkConnectionError` allowlist 記錄。當前掃描為 374 項，其餘項目由既有具理由的 allowlist 處理，兩個 gate 皆通過。[邊界檢查](D:/codex-ih-development/scripts/audit/check-package-boundaries.mjs) [清理後的 reachability 結果](C:/Users/IvanKwan/AppData/Local/Temp/ih-reachability-current-after-prune.log)

#### S2 型別宣告大於實際建構能力

JSONL backend 在原始建構時提供不可覆寫的 coordinator factory。公共 `createSessionCoordinator` 會取得完整 native Task／process 組合，並核對原 backend 身分。`createReadOnlySessionCoordinator` 明確提供 list、profile、snapshot、getDocument 及 close。既有 legacy 資料及 writer-held 讀取均透過實際檔案驗證，六個 provider 的 12 條正常路徑亦已通過。[公共建構入口](D:/codex-ih-development/packages/session-persistence/src/index.ts) [native factory 回歸](D:/codex-ih-development/packages/session-persistence/test/native-coordinator-factory.test.ts) [只讀介面回歸](D:/codex-ih-development/packages/session-persistence/test/read-only-coordinator.test.ts)

新舊格式遷移使用原始 JSONL writer 的排他 scope，從讀取、驗證至新 generation 發布都保留同一份所有權。新版文件已寫入的 key 會在既有 document lease 內攔截後續 legacy 寫入。coordinator 的公開入口在 close 開始時停止接收新 I/O，關閉程序等待已接受工作及其原始清理。[遷移所有權](D:/codex-ih-development/packages/session-persistence-jsonl/test/commit-migration-ownership.test.ts) [文件代際回歸](D:/codex-ih-development/packages/session-persistence-jsonl/test/document-generation-ownership.test.ts) [公開生命週期](D:/codex-ih-development/packages/session-persistence/src/coordinator/public-admission.ts)

#### S3 導航查詢依賴 gateway 啟動

冷 workspace 的導航及 dashboard 查詢使用 storage catalog，依目前設定選擇 JSONL 或 commit-log，直接讀取已提交的會話、pin、unread 及 project binding。已啟動的 runtime 繼續提供即時 dashboard。catalog 每次查詢管理自己的讀取資源，close 等待 workspace canonical path 解析、讀取及失敗清理。兩種儲存路徑均已驗證冷查詢的 gateway 啟動次數為零。[storage catalog](D:/codex-ih-development/packages/desktop-gateway/src/session-catalog.ts) [Desktop catalog](D:/codex-ih-development/packages/desktop/src/main/session-catalog.ts) [正常 IPC 回歸](D:/codex-ih-development/packages/desktop/test/session-catalog.test.ts)

#### S4 Task 狀態跨多份文件的共同失敗範圍

原生 Task 的結果、outbox 及 child-birth 證據由 V3 Task document 與原始持久化 ACK 持有。job／table 的可重建投影從同一已確認狀態產生，原生 Task 的重複輔助 journal 寫入已移除。既有 mailbox、resident 狀態、follow-up 與舊格式匯入繼續保存各自需要的資料。[Task 持久化](D:/codex-ih-development/packages/session-persistence/src/task/persistence.ts) [runtime 投影](D:/codex-ih-development/packages/subagent/src/runtime-projection.ts)

Task owner 替換先等待舊 owner 的原始來源與清理，再消費新的持久化讀取交接。冷啟動只從已確認的原生結果、相符 child birth 及真正完成的 reader close 恢復 terminal 狀態。parent end 與通知進度沿用原 source／save，未知 ACK 保留原操作供 reconciliation，防止重新執行工具及重複通知。20 項原生整合已驗證已接受通知 drain、held ACK、真正 unknown、Stop、程序崩潰及 close 後重開。[owner 回歸](D:/codex-ih-development/packages/subagent/test/task-canonical-owner.test.ts) [程序崩潰回歸](D:/codex-ih-development/packages/subagent/test/task-canonical-crash.test.ts) [關閉回歸](D:/codex-ih-development/packages/subagent/test/task-canonical-close.test.ts)

#### S5 歷史 sidecar 的保留與壓縮契約

後續已加入原生共享讀者 lease。仍持有舊前綴的讀者保留其 sidecar，程序退出時由 OS 釋放 lease。全域 document namespace 在取得獨占 maintenance lease 後，把被取代的更新壓成一個 checkpoint，保留目前文件值、清除 tombstone 及時間。原有 writer lease 持續排序變更，完整 session event history 維持原有保存契約。checkpoint 先驗證、同步暫存資料，再原子發布，失敗保留原始 generation。正常 coordinator 寫入、跨程序讀者、讀者崩潰、失敗重試與 legacy fallback 均已通過回歸。[文件 checkpoint](D:/codex-ih-development/packages/session-commit-log/src/document-checkpoint.ts) [讀者與維護 lease](D:/codex-ih-development/packages/session-commit-log/src/lease.ts) [coordinator 回歸](D:/codex-ih-development/packages/session-persistence/test/commit-document-checkpoint.test.ts)

這個讀者保留機制重用既有 OS lock owner，協調目錄由 `lockRoot` 指定，預設為 store root。Windows 原生測試驗證共享讀者互容、維護互斥及程序退出釋放，Linux 的對應實作使用 `LOCK_SH`。共享 lease 也與原有 exclusive ownership 的內部身分區分。[LockFileEx](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex) [flock](https://man7.org/linux/man-pages/man2/flock.2.html)

資源釋放失敗由原始 close owner 保存。數值 handle／descriptor 的未知 close 結果會保留失敗，避免 descriptor 重用後再關閉其它資源。讀取失敗及初始化失敗會攜帶原始 cleanup，coordinator 與 JSONL backend 保留該責任，直到真正收到釋放確認。已驗證的 commit record 在 decode 後一次凍結，讓快取、增量 fold 與各讀者安全共用內容。[資源 owner](D:/codex-ih-development/packages/session-commit-log/src/resources.ts) [跨層清理回歸](D:/codex-ih-development/packages/session-persistence/test/commit-cleanup-retention.test.ts) [快照隔離回歸](D:/codex-ih-development/packages/session-commit-log/test/read-snapshot-isolation-review.test.ts)

#### S6 Legacy retained-reference fork 的放大成本

原始 native owner 在同一同步區段重用已確認的祖先路徑檢查，完成所有 leaf 採樣後再重新確認祖先，外部 callback 及跨 await 的邊界仍重新驗證。capture quota 的資格綁定同一 turn、lease 與 index handle，發布前再核對實際 inventory，降低逐筆 capture 的重複盤點。[native capture](D:/codex-ih-development/packages/fs-lock/src/win32-artifact-path.ts) [quota inventory](D:/codex-ih-development/packages/context-output/src/artifact/quota.ts)

完整量測已跑通 101 及 1,001 個實際 references，保留每個案例原有的 30 分鐘期限。101-ref 的 owner 時間由先前 223.2 秒降為 142.3 秒，約下降 36%。1,001-ref 的 setup 為 211.9 秒、owner 為 1,486.8 秒，整個案例為 1,699.3 秒，即 28 分 19 秒。參考數增加約 9.91 倍，owner 時間增加約 10.45 倍。fixture 的批次準備縮短另列於 setup，量測中的 owner 仍執行實際 native 寫入。外部程序路徑替換、權限撤銷及 crash recovery 控制持續保留。[scale test](D:/codex-ih-development/packages/context-output/test/legacy-fork-scale.test.ts) [完整量測](C:/Users/IvanKwan/AppData/Local/Temp/ih-legacy-scale-bounded-grants-final.log)

2026-11-14 的獨立 10,001 筆 observation 案例仍超過原五分鐘期限。改用原始 currentness 組合的 fixture 實驗也超時，該實驗已還原。另用 60 秒診斷記錄 CPU profile，fixture 準備約 13 秒後進入 transfer，主要成本包含逐筆資格檢查及原生 Windows 路徑確認。診斷期限只用於取樣，原正式測試仍為 300 秒。此項及最新 funding 的跨案例污染仍未收尾。[五分鐘結果](C:/Users/IvanKwan/AppData/Local/Temp/ih-legacy-observation-scale-original-guards.log) [診斷時序](C:/Users/IvanKwan/AppData/Local/Temp/ih-scale-hotspots.log)

#### S7 CLI 跨程序 settings section 更新

CLI role 修改已把重新讀取、整筆 role 變更與保存放在共用 `.provider.lock` 內。Provider 與 model 設定命令使用既有 file-provider-runtime 的排序 lease。等待 stdin 的 key 命令也會在真正寫入時重驗 provider 仍存在。已通過 93 項 CLI 與 7 項 file-runtime 測試，包括真實獨立程序同時修改、同一 role replacement、set／unset、provider 與 model 的相鄰欄位更新、壞文件及保存失敗後的 lease 釋放。[roles.ts](D:/codex-ih-development/apps/cli/src/roles.ts:245) [跨程序回歸](D:/codex-ih-development/apps/cli/test/settings-write-concurrency.test.ts)

## 設計決定

### 可重複啟動的 dev 實例

`873fcefa` 加入 Windows 開發啟動器，沿用相同 Desktop／Gateway 來源。啟動器使用獨立 profile、`IH_CONFIG_DIR`、workspace 與每次啟動的日誌目錄，記錄 HEAD 及工作目錄狀態。Renderer 沿用 HMR，main watch 可用參數啟用。Repository 版本已實際啟動兩次，從 script 路徑取得 checkout 的預設值通過驗證。[開發啟動器](D:/codex-ih-development/scripts/dev-desktop.ps1)

在 checkout 執行下列命令即可使用這個 dev 實例。

```powershell
pwsh -NoProfile -File .\scripts\dev-desktop.ps1
```

實際資料根目錄為 `C:/Users/IvanKwan/AppData/Local/I-harness-dev/stability`，內含 desktop-profile、config、workspace 及 logs。Main inspector `5858` 與 renderer debugger `9222` 均實測綁定 `127.0.0.1`。目前執行版本顯示 `0.1.13-rc90` 開發版，實機覆驗使用 `d1047acb` 的全部 production source。其後的 launcher commit 只加入啟動腳本。[第一次重新啟動](C:/Users/IvanKwan/AppData/Local/Temp/ih-dev-relaunch-d1047acb.json) [冷重啟](C:/Users/IvanKwan/AppData/Local/Temp/ih-dev-cold-d1047acb.json)

使用者已授權沿用既有供應商設定，並指定 `deepseek-flash`。DeepSeek 設定及 credential 透過既有 file-provider runtime 寫入 dev config，使用現有 `anthropic-messages` 協定。來源設定與 credentials 檔案逐位元組核對相同。第一輪實際回覆 `IH_DEV_READY`，完成 write／read 檔案操作並保存兩個 turn/end。[設定核對](C:/Users/IvanKwan/AppData/Local/Temp/ih-dev-deepseek-configuration.json) [檔案操作與保存](C:/Users/IvanKwan/AppData/Local/Temp/ih-dev-live-smoke.json)

Code Mode 第一輪實機失敗後完成第 104、105 項修正。重新啟動後，DeepSeek 真正執行 JavaScript 並回覆 `IH_CODE_MODE_OK 5050`。第二回合以 `yield_time_ms=0` 返回 running，再用 code_wait 等待同一 cell，最後回覆 `IH_CODE_WAIT_OK 500500`。原生讀取核對兩個完成的 cell、兩個 code/end、兩個 turn/end，step/failed 為零。新增會話的草稿在 UI 與磁碟上均為空，metadata 保留模型選擇。[第一回合](C:/Users/IvanKwan/AppData/Local/Temp/ih-dev-code-mode-d1047acb.json) [背景等待與草稿](C:/Users/IvanKwan/AppData/Local/Temp/ih-dev-code-wait-d1047acb.json)

正常關窗後核對舊 dev 程序及三個監聽 port 均已退出，再冷啟動及開啟同一會話。兩個結果、會話標題與回合數在畫面上恢復，新會話草稿仍為空且保留 DeepSeek Flash 選擇。當次 cold read 沒有發出新的模型任務。[退出核對](C:/Users/IvanKwan/AppData/Local/Temp/ih-dev-d1047acb-closed.json) [冷讀取觀察](C:/Users/IvanKwan/AppData/Local/Temp/ih-dev-cold-reopen-d1047acb.json)

本次成功執行的 dev 日誌另有兩個 reconciliation RPC error，以及一個 session/tasks 的 60 秒逾時。第 111 項正在修復可證明的缺失回覆邊界，Task 讀取時的 busy／unknown 行為仍需原生控制。舊 child 的 8KiB stderr tail 隨正常關閉消失，保存的主程序日誌無法指出那次逾時的原始 Gateway 例外。[本次 dev stdout](C:/Users/IvanKwan/AppData/Local/Temp/ih-dev-relaunch-d1047acb.stdout.log)

第一個 dev 在全庫驗證的 Gateway 後段啟動，另一次輔助程序盤點因 PowerShell 空集合處理而未結束，已中止並修正。ContextOutput actual101 逾時後仍繼續，也影響後續共用計數器。這些負載及計數限制均保留，純耗時案例需獨立複驗。[Dev 啟動重疊](C:/Users/IvanKwan/AppData/Local/Temp/ih-verify-all-73082c41/dev-startup-overlap.json) [輔助盤點負載](C:/Users/IvanKwan/AppData/Local/Temp/ih-verify-all-73082c41/diagnostic-process-overlap.json)

在 `beeebe08` 的獨立 IH dev 中，另完成真實同步子任務。父模型為 `deepseek-flash`，採用 built-in explore 繼承父 ModelClient 的設定，fork_turns 為 none。實際 spawn_agent 回傳 completed，父子各一個回合、零 step/failed，分別保存 IH_TASK_OK 5050 及 IH_CHILD_OK 5050。Task 文件為 format 3、通知佇列為空，33 bytes 的結果 artifact 內容及摘要符合保存的 reference。正常關閉前後 Task 文件雜湊相同，另一個程序完成冷讀取。新草稿為空且保存模型選擇，dev 程序與三個監聽端點均已退出。保存的主程序日誌沒有出現先前的 RPC、FACT_RECOVERY_REQUIRED 或 Task 查詢逾時訊息。[實機與冷讀取摘要](C:/Users/IvanKwan/AppData/Local/Temp/ih-dev-task-beeebe08-summary.json) [原始父子事件](C:/Users/IvanKwan/AppData/Local/Temp/ih-dev-task-beeebe08.json) [Task 文件](C:/Users/IvanKwan/AppData/Local/Temp/ih-dev-task-document-beeebe08.json) [正常關閉及草稿](C:/Users/IvanKwan/AppData/Local/Temp/ih-dev-task-beeebe08-closed.json)

### Code Mode 參考對照與調整

使用者要求一併比較 Code Mode 的設計，並授權有需要時重新設計。IH 的 `@i-harness/code-mode` 是獨立 workspace package，程式目前在 QuickJS／WASM context 執行，外層 Node Worker 負責訊息、限制與回收。DSH 0.2.2-rc.1 的相應功能已命名為 PTC，主要入口為 `tool-executor-ptc` 與 `ptc-runtime-node`。OpenCode 2.2.6 也有獨立的 `@opencode/codemode`，預設為受限制的 JavaScript AST interpreter，另有實驗性的 bytecode VM。這次調整集中在結果及完成責任的歸屬。

| 參考機制 | 對 IH 的具體應用 |
| --- | --- |
| DSH `ProgramWorker` 的每個 Evaluation 有一次性 finish，結果在原始 process cleanup 完成後回覆，cleanupPending 阻止重用 | 每個 attempt 持有自己的完成 promise 與結果，下一次 attempt 等待前一次完整 dispatcher-body 及原始 native cleanup |
| DSH binding 捕獲確切 Evaluation，await 後重驗身分，OutputLedger 只計入實際 logs／return／error | 遲到的 callback 依原始 attempt 歸屬處理，普通 body 在真正回傳後才形成可保留資料 |
| Codex cell actor 分開處理 Started、ContentItem 及 Result，終端完成有單一序列化位置 | dispatch 開始只表示生命週期進入，producer 的實際 observation 與終端 outcome 各自保有完成條件 |
| Codex 完成輸出在交付失敗時保留於原 cell state | 已完成結果與交付 ACK 各由原 owner 保存，避免因交付失敗重新執行工具 |
| OpenCode 的產品入口每次建立新的 Effect-scoped Run，結束時中斷並加入原始 host calls | 執行狀態、目前 attempt 的結果、原始 host calls 與 cleanup 各自具有確切生命週期，重用 catalog 時仍重新建立執行狀態 |
| OpenCode 的實驗性 VM 只在沒有執行中 host call 時保存 continuation，驗證 build、host signature、source 與 bytecode | 可恢復 interpreter state 與外部效果確認具有不同條件，IH 的已知問題先透過原始執行與結果 owner 修正 |

固定版本全庫測試指出，通用 body 在 dispatch entry 被標成 observed，會在 Worker 尚未啟動時產生沒有資料的 recovery source。`c90fa625` 使用同一個 retained-dispatch source array 的目前 body 位置，限制結果選取在目前 attempt，並收尾所有 attempt 的 captured references。Shell issuer 的一次性取得由每個原始 claim 自己核對，原有 issuer 在已確認清理後提供下一次 attempt。完整 Code Mode 與工具套件，以及已知未發出、未知結果、撤銷、崩潰、關閉和 native retry 控制均已重跑通過。

上述對照以本機參考源碼為依據。[DSH ProgramWorker](D:/ih-reference-project/deepseek-harness-dsh-v0.2.2-rc.1/packages/ptc-runtime/ptc-runtime-node/src/worker.ts) [DSH OutputLedger](D:/ih-reference-project/deepseek-harness-dsh-v0.2.2-rc.1/packages/ptc-runtime/ptc-runtime-node/src/output-ledger.ts) [DSH PTC executor](D:/ih-reference-project/deepseek-harness-dsh-v0.2.2-rc.1/packages/core/tool-executor-ptc/src/ptc.ts) [Codex cell actor](D:/ih-reference-project/codex-rust-v0.167.0/codex-rs/code-mode-runtime/src/cell_actor/mod.rs) [Codex cell state](D:/ih-reference-project/codex-rust-v0.167.0/codex-rs/code-mode-runtime/src/cell_actor/types.rs)

OpenCode 的產品整合預設使用 legacy interpreter，`experimental.codemode_vm` 才會選用 bytecode VM。保存與恢復 VM state 需要額外維護語言實作、快照驗證及 host-call 邊界。IH 目前的實際問題已有 dispatcher observation 與 attempt ownership 的具體根因，設計方案保留 QuickJS／WASM 隔離，採用參考項目的每次執行作用域與原始清理責任。[OpenCode package](D:/ih-reference-project/opencode-2.2.6/packages/codemode/package.json) [產品入口](D:/ih-reference-project/opencode-2.2.6/packages/core/src/codemode/tool.ts:115) [VM suspend](D:/ih-reference-project/opencode-2.2.6/packages/codemode/src/vm/runtime/execute.ts:307) [snapshot 驗證](D:/ih-reference-project/opencode-2.2.6/packages/codemode/src/vm/snapshot.ts)

內部生命週期審查另確認，runtime finalization、mount finalization、event-fact queue、final-output source 及 observer 分別保存 worker／host-call join、terminal／publication fence、原始 capture、manifest／source-close ACK 及讀取游標。這些 registry 在各自確認後刪除記錄。`failedAdmissions` 原本會為每次失敗 admission 保留 cell ID 與 WeakMap 至 mount 結束，現在由原始 cell 的完整 finalization 釋放已完成記錄。未知 admission、晚到通知及失敗回呼仍由原 owner 持有，相關保留與釋放控制已通過。[event facts](D:/codex-ih-development/packages/code-mode/src/event-facts.ts) [mount finalization](D:/codex-ih-development/packages/code-mode/src/register.ts:163)

```mermaid
flowchart TD
    UI[Desktop / CLI / SDK] --> Gateway[Gateway / SDK server]
    UI -->|冷 workspace 導航| Catalog[Storage catalog]
    Catalog --> Read[已提交 snapshot / projection]
    Gateway -->|讀取| Read[已提交 snapshot / projection]
    Gateway -->|提交工作| Service[SessionService]
    Gateway -->|fork| Fork[Fork controllers]
    Service -->|已授權 facts| Writer[Coordinator / commit-log handle]
    Fork --> Writer
    Writer -->|有序提交| Storage[持久化 log / documents]
    Storage --> Read
    Service -->|活動與清理狀態| Gateway
    Fork -->|flight 與清理狀態| Gateway
```

### 會話工作狀態

`SessionService` 對外提供涵蓋 legacy 與 managed runtime 的工作觀察。SDK dashboard、關窗及 gateway 回收使用該觀察。執行、已接受輸入、子代理、背景程序、Code Mode、runtime 所持排程及尚未完成的清理，都有明確的保留責任。

Dashboard 另外合併 SDK 自己持有的 request flights，以及既有 fork lifecycle registry 中的 flight 與 cleanup debt。Stop receipt 留作去重，活動值由實際 settlement 與 acknowledgement 狀態決定。

保留 `hasAssembly()` 原有的 assembly 語意。新的工作狀態介面由現有 owner 提供資料，避免新增另一份可獨立漂移的業務狀態。

gateway 回收在異步檢查後重驗工作活動及 runtime 身份。重啟預算覆蓋完整時間視窗，過期的重啟回呼不得替換新一代程序。

Archive 是可逆的可見性變更。已接受的 future schedule 保留其 owner，於原訂時間到期一次。普通 pending input 與 child state 保留，archive 操作本身不觸發執行。這是本輪依既有行為採取的產品語意決定。

### 已提交讀取與執行授權

UI 的歷史、導航和 metadata 查詢讀取已提交狀態。runtime 的執行狀態由其 owner 提供。讀取失敗向呼叫者保留錯誤與範圍，使用者明確要求的 reload 保持獨立操作。

已接受但未提交的工作、未知寫入結果、損壞資料和已提交快照具有不同語意。工具授權、來源 currentness 及提交前的驗證繼續由原有權限 owner 執行。

### 寫入與關閉順序

每個 commit-log handle 使用同一條 mutation queue。追加、flush、refresh、sidecar 變更和 close 的順序由該 owner 決定。衍生序號及前綴前置條件在進入這條佇列後計算，避免檢查與寫入之間的競態。

提交前驗證輸入與操作。寫入或 fsync 失敗後，只有確定回滾成功的 handle 可以繼續修改。未知回滾結果保留錯誤並拒絕後續寫入，直到重新開啟與驗證。

追加使用增量 fold。公開 snapshot 的可觀察語意必須保留，讀取大歷史時避免把整個事件陣列展開為函式引數。

### 版本、刪除及內容定址

一個 session ID 的讀取解析涵蓋舊 JSONL 與新 generation。已刪除的 incarnation 不得透過舊格式回退復活。支援同 ID 重建的儲存入口必須建立新的身分。JSONL 的永久刪除入口持續以 `SESSION_DELETED` 拒絕 `create(deletedId)`。

刪除 receipt 遵守公共 coordinator 的 `visibility` 與 `manifest` 契約，重試可確認原操作結果。清除文件必須抑制其 legacy 回退。

sidecar 讀取驗證摘要與長度。仍被可讀歷史引用的內容具有保留責任。讀者 lease、原始 writer lease 與 document checkpoint 一起決定回收邊界。讀者釋放後，文件 namespace 可移除被 checkpoint 取代的版本，普通 session 的完整 event history 繼續保留。

### 子代理與通知

保留任務身分、可恢復工作及通知去重所需的耐久資料。OpenCode 2.2.6 有持久化的背景 Job 與恢復資訊，簡化方案應以本機新版本源碼為準。

檢查 parent task document、child session、通知及 runtime owner 的提交責任，降低單一輔助狀態失敗影響其它工作的範圍。重建投影、恢復未知提交及傳遞通知分別具有明確的完成條件。

### SDK 與錯誤

高階 SDK 入口先完成初始化。一般 RPC 期限與長任務期限分別定義。任務期限只影響其呼叫觀察，若不能確定原輸入身分，避免對共用 session 發出廣泛取消。

request timeout、傳輸關閉及協定失敗保留不同錯誤種類。stderr 持續排空並只保留有界診斷。關閉操作共享同一次收尾，並確認子程序退出。

### 導航與成品

已展開或已選取來源取得的歸屬資訊回傳給導航 owner，讓未分類歷史可見。Team 的工具、控制入口及專屬分頁已移除，舊資料的讀取與顯示相容性保留。

成品的 runner／worker 入口由明確執行模式解析。驗證涵蓋預編譯 gateway 的正常沙箱命令，並檢查 runtime 資產在成品目錄可用。

## 驗收清單

以下狀態對應本分支的定向實作與測試證據。第 44 項及全庫失敗清單的狀態保留於相應章節。

- [x] 同一 owned handle 的並行寫入均保存，fact 寫入與 metadata 更新不互相覆蓋。
- [x] 已遷移會話刪除後不復活，附屬文件清除抑制 legacy 回退。
- [x] 長歷史可以遷移，無效內容不會發布為可見 generation。
- [x] sidecar 內容與摘要不符時拒絕讀取。
- [x] 有效讀者所引用的 sidecar 不被回收，未提交孤兒仍可回收。
- [x] 同 ID、同長度的重建資料不會命中舊快取。
- [x] enqueue、flush、close 具備正確完成屏障。
- [x] fork 保存新子會話 ID 與正確 lineage。
- [x] 刪除 receipt 可供 Desktop 重試，既有資料與明確重建有相容處理。
- [x] 追加不重播整段歷史，使用便宜的計數或有界讀取推進前綴。
- [x] 正常 managed／legacy 工作狀態一致，關窗與回收看見活躍 owner。
- [x] 檢查期間出現新活動時停止本次閒置回收。
- [x] 打包後 Windows ACL runner 可以實際執行。
- [x] 成功初始化後的反覆崩潰仍受重啟預算限制。
- [x] 非目前 workspace 的未分類歷史及跨專案來源保持可見。
- [x] Team package、執行入口及專屬 UI 已移除，歷史記錄可讀。
- [x] commit-log 會話提供活動時間並正確排序。
- [x] `runHarness` 完成初始化，保留明確提供的啟動參數。
- [x] SDK 長任務沒有任意的 60 秒限制，明確期限不取消其它輸入。
- [x] SDK 子程序 stderr 排空且診斷有界。
- [x] SDK 關閉可重入，舊式 shutdown 回退及退出確認正確。
- [x] frozen install 成功，pnpm 版本與 lockfile 可重建。
- [x] 套件邊界及 reachability 閘門通過，新增公共介面有實際用途或明確保留理由。
- [x] 正常讀取不觸發會話 reload，未知寫入或損壞資料仍可見。
- [x] timeout 不顯示成斷線，online 狀態保留操作失敗回饋。
- [x] 到期排程、子代理建立／續作／取消、fork 與 close 經正常入口完成。
- [x] coordinator 初始化保留 lazy lease options，fold factory 由實際 owner 捕獲。
- [x] Windows settings replacement 以同一暫存檔進行有界重試，衝突與永久失敗保留原內容。
- [x] SettingsStore 以最新持久化內容合併 patch，stale revision 與 failed write 保留 last-good state。
- [x] Child header 的已知 committed ACK 在關閉時保留，真正 unknown 的回覆仍需原 owner 恢復。
- [x] 格式 14 的原始 partial child birth 可在冷啟動後依相同 stage／batch 證明恢復。
- [x] 保留結果先核對目前專案範圍，同權限冷啟動與異權限拒絕均經實際讀取驗證。
- [x] staged write、conversation hydration 與指令發布的最後生命週期回歸完成。
- [x] 已完成各輪定向測試、完整診斷、型別檢查範圍及分支 CI 入口的記錄。
- [x] `a6d3f41e` 的 Persistence 與 JSONL 完整套件通過，17 項歷史 fixture 條件略過逐項列明。
- [ ] Windows 偶發重建失敗的來源或適用限制完成歸因。
- [ ] Gateway 剩餘 fork 成本的調整完成實際量測與權限／恢復回歸。
- [x] CLI 初始化失敗及逾時的原始子程序、HTTP listener 與在途請求完成收尾驗證。
- [x] 固定 `73082c41` 的 82 個測試 package 與七階段 `verify:all` 全部完成，保存逐項失敗及略過記錄。
- [ ] 修正後的完整固定版本驗證通過，`21f8d861` 的 434 項失敗與九個未處理錯誤完成逐案處理。
- [x] 真正 Desktop／DeepSeek Flash 的 Code Mode、草稿與重新開啟流程通過，另行保留背景 Task 查詢錯誤及其 SDK 修正證據。
- [ ] 最終提交、完整問題狀態與分支 CI 結果一致。

## 驗證記錄

### 測試契約與原始故障的重寫

依使用者於 2026-11-14 的追加指示，先釐清案例所驗證的產品行為，再調整不符合實際契約的 fixture。`614680d2` 修改六個測試／helper 檔案，使用既有 constructor 注入原生 append／reconcile 的觀察與故障。原始 owner、prefix、batch key 及實體檔案均經實際恢復控制核對。Gateway 的 Win32 探針明確限定 Windows，這次 Windows 執行沒有略過案例。[原生故障 helper](D:/codex-ih-development/packages/session-executor/test/helpers/crash-retained-result.mts) [原生路徑控制](D:/codex-ih-development/packages/desktop-gateway/test/task-child-zero-count.test.ts)

崩潰控制的第一次有效執行為八項通過、四項失敗。其中 Code 完成後實際保存工具結果、文字輸出及輸出 manifest，舊斷言只計入前兩者。新控制驗證完整 manifest 位元組及其與文字 artifact 的連結。兩個後段 Code 案例在原期限附近完成，完整重跑分別量得 30.035 及 34.326 秒，因此此檔案使用 60 秒整體期限。子程序 receipt 使用 30 秒，正常 setup 首次 20 秒啟動延遲的原始紀錄保留。此後完整 12 項通過，包含實際 kill、原始 journal 邊界、冷讀、一次效果與明確新輸入。[首次有效執行](C:/Users/IvanKwan/AppData/Local/Temp/ih-test-constructor-crash.log) [完整重跑](C:/Users/IvanKwan/AppData/Local/Temp/ih-test-constructor-crash-final.log) [測試實作](D:/codex-ih-development/packages/session-executor/test/retained-physical-crash.test.ts)

排程原本在寫入 seed 之前就打開宣告了非零 seedLength 的空會話。兩個繼承歷史案例改為用既有 header codec 寫入完整 format 5 fixture，再經正常 coordinator 開啟及升級，核對原始前綴與 seedLength。另補上 child 的零 seedLength，測試真實 child context 的冒泡事件。所有 fixture 最終等待原 assembly 及 coordinator，重建 assembly 的案例也明確界定同一 coordinator 的生命週期。取消控制則在原始建構入口暫停真正已提交的 promotion ACK，六項 live／cold／Stop 組合均通過。[排程控制](D:/codex-ih-development/packages/session-executor/test/schedule-delivery.test.ts) [取消競態控制](D:/codex-ih-development/packages/session-executor/test/received-cancellation-close.test.ts)

最終以完整回歸相同的兩個 worker 配置依序重跑。Gateway 兩項通過，耗時 48.22 秒。Executor 三個完整檔案共 28 項通過，耗時 352.60 秒，未處理錯誤與略過均為零。六個候選檔案與 HEAD 在前後核對一致，Gateway／Executor 型別檢查通過。較早的一次定向命令漏用 scripts/test-env.mjs，因證據目錄未設定而在 setup 失敗，該紀錄獨立保留，最終驗證使用正式環境包裝器。[最終收據及檔案雜湊](C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-21f8d861/receipt.json) [Gateway 完整結果](C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-21f8d861/gateway-inventory.json) [Executor 完整結果](C:/Users/IvanKwan/AppData/Local/Temp/ih-test-rewrite-21f8d861/executor-inventory.json)

### 最新定向修正

`675282ad` 修正新使用入口遺漏原始閒置清理重試的問題。沿用 ContextStore 既有的 quiescing 狀態及 quiesce 完成順序，在八個服務入口的 exclusive gate 內先完成原清理。兩項新增原生控制在舊來源均失敗，修正後確認可恢復的 native close 被同一原始實例重試，舊 workspace lease 已釋放才允許新的 acquisition。已消耗但回覆未知的控制維持同一 undefined cause，沒有新的 acquisition 或第二次 native close。該負向控制最後釋放原始 OS lease 的步驟屬測試程序資源收尾，邏輯清理仍未獲確認。[原生失敗與修正收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-idle-retry-final-receipt.json)

ContextOutput 九個完整檔案共 149 項通過，另有 Persistence 五個檔案共 102 項通過，涵蓋刪除準備、清理責任、原生 ownership、撤銷及順序控制。五個 package 型別通過，四個候選檔案的雜湊保持一致。三個原先使用預設五秒期限的原生多階段案例，在定向量測中分別為 5.140、5.403、8.581 秒，現各有 15 秒期限。DescribeFunding 的原計數失敗在隔離執行中未重現，該斷言保持，完整 44 項 index lifecycle 控制亦已通過。[完整 ownership 控制](C:/Users/IvanKwan/AppData/Local/Temp/ih-idle-retry-ownership-qualified.log) [原生撤銷與順序](C:/Users/IvanKwan/AppData/Local/Temp/ih-idle-retry-native-ordering.log) [期限量測](C:/Users/IvanKwan/AppData/Local/Temp/ih-index-three-timing.log)

`a7663918` 修正 coldLegacyFixture 的生命週期。原 fixture 在建立 capture／grant 後沿用暖服務，隨後手動加入 V2 plan，正常 resume 因發現 namespace drift 而撤銷 historical reader。現在先關閉 producer，再安排完整持久檔案並建立冷服務。另一項真正測試暖快取 drift 的案例，明確以原生讀取建立初始 witness，再透過獨立服務改變 membership。原有撤銷判斷保持通過。ContextOutput 26 項、Gateway 七項、JSONL 五項及 Persistence 81 項合計 119 項通過，四個 package 型別通過。暫時診斷程式已逐位元組恢復。[完整收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-cold-fixture-final-receipt.json) [原始 revocation 追蹤](C:/Users/IvanKwan/AppData/Local/Temp/ih-cold-revocation-trace.log)

`2054f4a4` 完成第三批程序中斷與冷讀取測試。程序由 node --import tsx 直接啟動，核對真正 producer 的 PID 及 cut，標記寫入完成後才退出，父程序等待 stdio close。已提交邊界先驗證 committed，工具結果亦核對 succeeded。副作用改為追加記錄，重播會留下額外內容，mutable 工具在 fixture 中明確批准執行。五個中斷位置在原 30 秒期限內通過，完整命令耗時 46.68 秒。

另十個 publication／pin 中斷案例保留原生檔案、pin、內容、原始 Task 文件及無 writer ownership 的斷言。原 producer 已終止，冷讀取將已保存的 running 留在 savedObservation，公開狀態為 recovery-required，且沒有 Task result、通知或新的完成事實。這符合案例對 artifact 已提交仍須有原 Task 完成證明的要求。十項全部通過，耗時 57.69 秒，原期限保持，三個檔案雜湊一致且 Executor 型別通過。[完整收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-crash-publication-receipt.json) [程序中斷測試](D:/codex-ih-development/packages/session-executor/test/physical-crash.test.ts) [冷讀取與 publication 控制](D:/codex-ih-development/packages/session-executor/test/publication-pins-physical.test.ts)

`993d5999` 完成輸入提升與提交完成流程的第二批測試修訂。原始 append／reconcile 在 backend 建構時包裝，刻意遺失 ACK 前先核對真正 committed 結果。標題收尾的有界等待從已確認的原始 title 寫入開始，清楚定位回覆是否完成。原有 service 及 coordinator 的清理結果加入 soft async 斷言，使清理錯誤進入測試結果。兩個完整檔案共 20 項通過，耗時 57.10 秒，兩個 worker、原有期限及正常 test-env 啟動方式下沒有略過或未處理錯誤。Executor 型別通過，兩個檔案雜湊在前後一致。[驗證收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-input-completion-receipt.json) [完整測試清單](C:/Users/IvanKwan/AppData/Local/Temp/ih-input-completion-inventory.json)

`e613aee0` 的 history materialization 修正完成八項原生控制，包含讀取與寫入相遇、準備寫入先等待原讀取、自我重入拒絕、原始讀取／關閉錯誤及關閉責任。Gateway 正常 Desktop 的背景 Code 加 history 案例以 14.367 秒通過，Persistence 與 JSONL 型別通過。另一次 `Owned dependency archive changed` 發生於 history 之前，該原始失敗記錄繼續保留，尚待完整回歸定位。[驗證收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-108-final/receipt.json) [另一次原始失敗](C:/Users/IvanKwan/AppData/Local/Temp/ih-108-desktop-lane-first.log)

`21f8d861` 完成壓縮發布修正。只刪除 eager overhead 讀取的第一個候選恢復正常 close，但壓縮仍回覆 blocked，最終繼續修正 captured projection 的原始讀取邊界。原案例於 20.902 秒確認 compacted、committed、summary、todo 及正常 host close，原 120 秒期限保持。六項 native projection／Plan 控制及一項比例、prompt、hook 撤銷控制通過，Core Agent 與 Gateway 型別通過。[完整收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-109-final/receipt.json)

`5379efea` 的草稿送出身分修正完成 18 項定向控制，相關 11 檔合計 94 項通過，Desktop 型別通過。案例覆蓋相同文字的真實重新編輯、最早 await 前捕獲身分、較晚建立與 ACK、跨 remount 送出及持久清除失敗。`295b6951` 的 Task 讀取健康修正完成五檔 43 項及 Persistence／Subagent 型別，原始健康 writer 的 public／private 讀取控制均已通過，保留原來的父讀取 guard。[草稿收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-issue110-qualified-e613aee0/receipt.json) [Task 原始控制與收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-task-read-health-receipt.json)

`b0a868ce` 的 Windows 原生鎖修正完成 fs-lock 全套 136 項通過及六項原有條件略過，型別及 Context 長路徑案例通過。`006481fe` 另將四個 Context 測試檔中的真實 file symlink `EPERM` 能力限制明確記為七項環境略過，原有 junction、hardlink 及成功建立 symlink 後的拒絕斷言保留。測試篩選造成的 deselection 另行計數。[長路徑鎖收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-issue113-qualified-295b6951/receipt.json) [Context 路徑與連結收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-context-path-and-link-receipt.json)

### 固定整合版本與後續修正

`a14fdbe4` 的 `pnpm verify:all` 從 2026-11-11 08:37:05 UTC 執行至 12:17:01 UTC。期間 production 與測試程式保持固定，只有本報告更新。82 個測試 package 全部報告結果，15,037 項通過、1,078 項失敗、96 項略過，另有 20 個未處理錯誤。全庫 typecheck、10 個 E2E 檔案、reachability、package boundaries 及獨立 compiled Gateway／ACL smoke 均通過。套件失敗仍需完成修正後重跑全庫。[固定版本日誌](C:/Users/IvanKwan/AppData/Local/Temp/ih-verify-all-a14fdbe4.log) [完整清單與 SHA-256](C:/Users/IvanKwan/AppData/Local/Temp/ih-verify-all-a14fdbe4.inventory.json) [來源與階段 metadata](C:/Users/IvanKwan/AppData/Local/Temp/ih-verify-all-a14fdbe4.metadata.json)

失敗的 package 為 CLI、Code Mode、context-output、core-agent、core-tools、desktop-gateway、SDK、session-executor、session-persistence、session-persistence-jsonl 及 subagent。清單保存 Vitest 的原始失敗標籤、去重標籤與各 package 的實際總數，部分案例因多個錯誤而重複列印。已確認的共同原因包括真正的結果歸屬缺陷、讀取範圍放大、測試複製名義 owner、建構後替換已捕獲方法、舊結果欄位、缺少 lineage，以及逾時後仍在執行的測試工作。尚未完成逐案歸因的項目繼續保留。

`c90fa625` 的 Code／core 修正已有下列驗證。

| 範圍 | 結果 |
| --- | --- |
| Code Mode 完整套件 | 29 檔、377 項通過 |
| Core Tools 完整套件 | 25 檔、188 項通過 |
| Core Agent 原始身分、Shell issuer、instruction pin | 4 檔、14 項通過 |
| SDK 已接受 context 與撤銷入口 | 4 項通過 |
| 原生 Shell／nested Code retry | 6 項通過，包含未知清理、第二次未知及下一次 body 前拒絕 |
| Code Mode、Core Tools、Core Agent 型別檢查 | 三個 package 全部通過 |

Prepared call 的身分被改動時，該輪現在保留原始拒絕並停止。相應負向測試要求確切錯誤與一次 provider 請求，仍驗證原 proof 不能再次使用，以及獨立的手動呼叫沒有模型來源權限。Instruction pin 測試改用產品的 `createExecutionRuntimeContext` 發布路徑，保留真實 pin 的一次釋放、falsey 故障與原始重試斷言。[Code Mode](C:/Users/IvanKwan/AppData/Local/Temp/ih-code-mode-attempt-retention-fixed.log) [Core Tools](C:/Users/IvanKwan/AppData/Local/Temp/ih-core-tools-attempt-retention-fixed.log) [Core Agent](C:/Users/IvanKwan/AppData/Local/Temp/ih-core-agent-attempt-retention-targets-final.log) [SDK](C:/Users/IvanKwan/AppData/Local/Temp/ih-sdk-prebody-outcome-fixed.log) [native retry](C:/Users/IvanKwan/AppData/Local/Temp/ih-native-retry-after-retention-fix.log)

`41089acb` 的 selected metadata／pending publication 修正，在正常兩個 worker、沒有命令列期限覆寫的情況下取得 32／32 通過。原始已確認 transfer 的關閉收尾、未知 passive close 與五項權限負向控制另取得 7／7，context-output 型別檢查通過。五列完整讀取使用 3 次頁面讀取，101 列使用 9 次，兩者均維持三次 graph pass、每列三次 canonical 檢查與 12 次 inventory。[32 項正常驗證](C:/Users/IvanKwan/AppData/Local/Temp/ih-selected32-normal2-final.txt) [關閉與權限驗證](C:/Users/IvanKwan/AppData/Local/Temp/ih-transfer-close-original-ack-final.txt) [型別檢查](C:/Users/IvanKwan/AppData/Local/Temp/ih-context-output-final-types.txt)

這組測試的期限經過實際量測調整。101 列案例的完整安靜執行為 20.526 秒，其中原生寫入至 10.818 秒完成、reader acquisition 至 12.941 秒完成，完整枚舉及關閉至 20.524 秒完成，個別期限設為 30 秒。其正常雙 worker 執行為 21.556 秒。另 25 個包含真實 native plan 準備的案例採用 15 秒個別期限，已量測的安靜執行為約 4.27–7.02 秒，空來源控制仍以五秒完成。所有頁面、canonical、inventory、原始 handle、無額外 reader 寫入及負向斷言皆有實際驗證。新增 closing-window 測試一度因 Context Mode 未啟用而沒有建立預期 gate，修正前置條件並要求實際 reference 後，五項均於 1.19–1.26 秒完成。[101 列完整分段量測](C:/Users/IvanKwan/AppData/Local/Temp/ih-selected101-full45.txt) [原 15 秒邊界](C:/Users/IvanKwan/AppData/Local/Temp/ih-selected101-original15.txt) [普通 metadata 量測](C:/Users/IvanKwan/AppData/Local/Temp/ih-selected-metadata-diagnostic15.txt)

正常服務的 Code Mode 補充驗證曾實際捕捉到 only 模式送出 19 個工具的整合錯誤。`449e3dc4` 修正後，off／mixed／only 三個模式在初始及重新綁定模型後均符合設定，真正的 `code_exec → spawn_agent → followup_task／wait_agent` 路徑完成一次 child birth、兩輪 child 執行、三個 nested call 及原始 owner 清理。四項驗證與 executor／Gateway 型別檢查通過。[正常 schema 與 Task 路徑](C:/Users/IvanKwan/AppData/Local/Temp/ih-owned-code-schemas-task-fixed.log) [首次捕捉紀錄](C:/Users/IvanKwan/AppData/Local/Temp/ih-owned-code-nested-task-first.log) [型別檢查](C:/Users/IvanKwan/AppData/Local/Temp/ih-code-mode-model-surface-types.log)

原生 Plan 的 staged-write 修正 `c007ca45` 通過六項控制，涵蓋已保存 off、原始 unknown 的恢復、建構器退休、方法替換與中止。`021b1c37` 將同步 close preflight 放回通用自我等待檢查之前，保留原 `SessionBindingObservationError`／`conflict`，已接受 I/O、關閉冪等性及 native cleanup 的 51 項控制與兩個 persistence package 型別檢查通過。[Plan 六項](C:/Users/IvanKwan/AppData/Local/Temp/ih-owned-plan-staged-lifetime-fixed.log) [ownership 與 admission 35 項](C:/Users/IvanKwan/AppData/Local/Temp/ih-persistence-original-checker-unit-final.txt) [native self-close 三項](C:/Users/IvanKwan/AppData/Local/Temp/ih-persistence-typed-self-close-final.txt) [close lifecycle 13 項](C:/Users/IvanKwan/AppData/Local/Temp/ih-persistence-commit-close13-final.txt)

`8d9b820b` 的結果發布 fence 與 Task V3 驗證分別通過 19 項及 32 項控制，Gateway 型別檢查通過。平行讀取的正向案例先加入兩個真實讀取再釋放原始 I/O gate，驗證兩者完整回傳。[結果頁與 fence](C:/Users/IvanKwan/AppData/Local/Temp/ih-gateway-result-fence-qualified.log) [Task 目錄、格式及 ownership](C:/Users/IvanKwan/AppData/Local/Temp/ih-gateway-catalog-owner-021b1c37.log) [Gateway 型別](C:/Users/IvanKwan/AppData/Local/Temp/ih-gateway-catalog-owner-types-021b1c37.log)

Executor 的十檔入口與結果測試首輪為 102 通過、2 失敗。七個 sandbox／shell／workspace 檔案與八項 managed-producer 故障控制已通過，修訂提交為 `526adb06`。其餘兩個案例完成實際模型入口與 journal 確認語意修正後，assembly 46 項及 generation-close 16 項全部通過，提交為 `e443fa71`。after-commit throw 控制核對一次故障、一次 close append、一次實體提交及一次 native reconcile，原始 generation 復原亦核對一次性操作。[十檔首輪](C:/Users/IvanKwan/AppData/Local/Temp/ih-executor-entry-extraction-10-first.log) [assembly 與 generation 62 項](C:/Users/IvanKwan/AppData/Local/Temp/ih-executor-assembly-generation-fixed.log)

`8403ea92` 的已接受工作與 close 測試通過 39 項。Persistence 三檔選取 34 項，JSONL archive 選取 5 項，均使用兩個 worker 與原有期限。關閉後的新公開請求回覆 `FACT_CLOSED`，已接受 callback、讀寫及 child birth 等待原始資源完成後關閉。成功 child birth 的第三個 lease 以真正 Task document 路徑核對，明確 target retirement 的負向控制仍只有原來兩個 ownership leases。這次僅修正測試，四檔中未選取的案例待後續完整驗證。[Persistence 34 項](C:/Users/IvanKwan/AppData/Local/Temp/ih-accepted-close-grace-persistence-final.txt) [JSONL 5 項](C:/Users/IvanKwan/AppData/Local/Temp/ih-accepted-close-grace-archive-final.txt)

`df7c634a` 的原始 cleanup 與測試隔離修訂通過 51 項。五個 context-output 檔案為 42 通過、3 略過，另有兩個獨立 owner ledger 修復案例及完整 rewind 七項通過。失敗的原始檔案 close 維持相同錯誤，健康 sibling 確實釋放，持有中的成功 close 僅執行一次。Legacy store 在真正活動期間拒絕競爭者，閒置後可由另一程序讀取。Rewind 使用建構期的原始 batch wrapper，第二輪可在上一筆 journal append 暫停時完成。context-output 與 executor 型別檢查通過，executor 的 fixture 曾把 `AgentResult` promise 註記為 void，已改為符合只等待用途的型別。[42 項與三項環境略過](C:/Users/IvanKwan/AppData/Local/Temp/ih-context-close-ownership-fixtures-qualified.log) [ledger 兩項](C:/Users/IvanKwan/AppData/Local/Temp/ih-context-original-ledger-two.log) [rewind 七項](C:/Users/IvanKwan/AppData/Local/Temp/ih-executor-rewind-original-fixtures.log) [executor 最終型別](C:/Users/IvanKwan/AppData/Local/Temp/ih-executor-rewind-fixtures-types-final.log)

三個新確認的 Windows file-symlink 案例均在實際建立 fixture link 時回報 `EPERM`。本輪新增的略過處理最初誤用 parameterized test 的 context，已改為逐個註冊案例，之後正確回報環境略過。目錄 junction 與 hardlink 的負向控制仍實際執行。[首次處理錯誤](C:/Users/IvanKwan/AppData/Local/Temp/ih-context-close-ownership-fixtures-initial.log) [修正後結果](C:/Users/IvanKwan/AppData/Local/Temp/ih-context-close-ownership-fixtures-qualified.log)

`444e9ea2` 的五個 persistence 測試檔通過 23 項選取案例，以及兩個 package 型別檢查。原生資源斷言現在核對真正的 session／Task companion，以及 fork preparation 的 project-document pin／lease 相依關係。已釋放的健康資源可以重新取得並回滾，原始失敗 handle 必須持續保留，pin 需要等待其 lease 完成釋放。Task document 的新格式正向測試使用既有完整 Transition constructor，複製 factory、永久刪除、未知 ACK 與 validator 自我修改的負向控制保留。JSONL 另有一項原本依環境啟用的 predecessor 控制未執行。[原生資源兩項](C:/Users/IvanKwan/AppData/Local/Temp/ih-next-batch-resource-identities-qualified.txt) [JSONL 21 項](C:/Users/IvanKwan/AppData/Local/Temp/ih-next-batch-jsonl-initial.txt) [Persistence 型別](C:/Users/IvanKwan/AppData/Local/Temp/ih-next-batch-persistence-types.txt) [JSONL 型別](C:/Users/IvanKwan/AppData/Local/Temp/ih-next-batch-jsonl-types.txt)

`2df98529` 的 Gateway metadata-debt 五項，連同 execution-host 十二項控制，以正常兩個 worker 通過 17 項，Gateway 型別檢查通過。原先五秒期限在原生 fork 尚未完成時到期，現在單 fork 案例使用 30 秒、雙 fork 使用 60 秒的局部期限。故障取得、原始 handle 身分、binding lease 保留與一次性釋放斷言持續執行，concurrent gate 亦會觀察原始 acquisition 是否提前結束。實際 fork 延遲另列於問題 77，仍需處理。[17 項正常驗證](C:/Users/IvanKwan/AppData/Local/Temp/ih-selected-native-metadata-normal2.log) [原生分段量測](C:/Users/IvanKwan/AppData/Local/Temp/ih-selected-native-metadata-single-diagnostic.log) [Gateway 型別](C:/Users/IvanKwan/AppData/Local/Temp/ih-selected-native-metadata-types.log)

同一 Gateway fixture 的兩次一-reference fork 進一步確認重複成本。cold／warm prepare 為 70.4／56.8 ms，execute 為 13.661／14.764 秒。原始 `checkWin32ArtifactPaths` 的批次呼叫為 17,786／19,213 次，送入檢查為 91,870／100,155 個，inclusive 時間為 10.991／12.028 秒。量測轉送原始函式的 receiver、參數及回傳值，原 path capture、owner 與 native enrollment 保持原樣。CPU 樣本指向 `withArtifactCurrentChecks`、legacy fork guard、Gateway source currentness 及 funding context。暫時測試已移除，後續調整仍需保留外部 callback 與異步邊界的驗證。[兩次 fork 的完整量測](C:/Users/IvanKwan/AppData/Local/Temp/ih-gateway-one-ref-5576.json) [CPU 樣本摘要](C:/Users/IvanKwan/AppData/Local/Temp/ih-gateway-one-ref-5576-cpu-summary.json)

`960f237c` 的第一步合併重用現有 currentness helper，核對原始方法、receiver namespace 及已登記 reader。相同量測的 cold／warm execute 降至 9.096／9.633 秒，原生 proof 數降至 49,426／53,391，inclusive 核對時間為 6.432／6.957 秒。opaque callback 與空 flush 邊界仍存在，因此 checker 入口呼叫數幾乎相同。九項定向控制通過，涵蓋真實 namespace 替換、callback 前的核對、Proxy／accessor 次數、方法替換、退休及來源撤銷後零效果。既有控制為 74 項通過，舊 E00 fixture 修正至真正 read-only facet 與 writable factory 拒絕後另行通過。這是兩次執行的資格證據。core-session、executor、Gateway 及修改過的 persistence 測試型別檢查全部通過。[第一步完整量測](C:/Users/IvanKwan/AppData/Local/Temp/ih-gateway-one-ref-19872.json) [executor 定向控制](C:/Users/IvanKwan/AppData/Local/Temp/ih-fork-currentness-focused2.log) [Gateway 定向控制](C:/Users/IvanKwan/AppData/Local/Temp/ih-fork-currentness-gateway-focused.log)

`cb42cbab` 進一步從既有 `readyOwners` 取得原始 document 的同步 guard，保留 private view、公開 descriptor、原始 readiness 與既有 snapshot 檢查。既有 global capture 行為保持原樣，custom ownership／execution 維持 opaque。受控的 legacy document 關閉旗標使用原生持有者已有的組合機制，project getter 也只在原始 observation 與 reader 關係成立時合併核對。12 項定向與 67 項既有原生控制，以及 persistence、executor、Gateway 型別檢查通過。相同 cold／warm execute 再降至 6.964／6.370 秒，proof 為 28,222／30,027 個，batch entry 為 8,358／8,825 次。暫時 profile 已移除。[完整驗證收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-stage2-receipt.json) [第二步量測](C:/Users/IvanKwan/AppData/Local/Temp/ih-gateway-one-ref-12768.json)

Task replay 的 26.367 秒診斷當時包含無條件包裝 native lease 的測試成本，先前對正常產品延遲的判斷需要更正。後續同預算 profile 確認，只在指定故障路徑包裝 handle，replay 由 29.884 秒降至 7.688 秒，bootstrap 由 15.111 秒降至 3.257 秒。production source 保持相同，原生 proof 的批次計數因更多核對重新進入既有 batch 而增加，這項結果只能證明 fixture 成本已消除。`b991ed7e` 的完整 30 項在原 20 秒操作及 15 秒 cleanup 期限下通過，最慢案例為 7.260 秒，效果次數、複製／重播拒絕、generation／expiry 及原始清理均保留。[早期完整診斷](C:/Users/IvanKwan/AppData/Local/Temp/ih-task-launch-first-phase-quiet60.log) [修正後 profile](C:/Users/IvanKwan/AppData/Local/Temp/ih-task-bootstrap-scoped-profile.log) [完整 30 項與原期限](C:/Users/IvanKwan/AppData/Local/Temp/ih-task-scoped-lease-full30-final20.log) [驗證收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-task-scoped-lease-receipt.json)

`4443092a` 的 cached adoption 與 cold execution 故障控制通過五項及 persistence 型別檢查。已接受的 cached adoption 等待實際 close ACK 後才失去 witness，新請求在 close 之後立即拒絕。建構後被替換的方法在執行前被拒絕，原始位元組與變更通知均未改動。streamed archive recheck 故障透過真正的 descriptor acquisition 注入，保留 primary failure、rollback、native close 與 dirty-edge 證據。[五項回歸](C:/Users/IvanKwan/AppData/Local/Temp/ih-cached-cold-fault-fixtures-initial.txt) [型別](C:/Users/IvanKwan/AppData/Local/Temp/ih-cached-cold-fault-fixtures-types.txt)

`9c31efeb` 修正七個 Gateway fixture 的空繼承 lineage，並以真正 SessionService 驗證 retained catalog 的發布來源。18 項定向案例分次通過，catalog 讀取後三個 session 均維持未掛載 assembly，現行 Gateway 型別檢查通過。兩個 retained catalog 案例最初使用沒有原始 observer 登記的結構性 service，補正至正常 constructor 後通過。[六項 lineage 與首次 catalog 拒絕](C:/Users/IvanKwan/AppData/Local/Temp/ih-gateway-empty-seed-fixtures-eight.log) [完整 instruction lifetime 十項](C:/Users/IvanKwan/AppData/Local/Temp/ih-gateway-instruction-lifetime-ten.log) [正常 catalog service 兩項](C:/Users/IvanKwan/AppData/Local/Temp/ih-gateway-retained-publication-original-service.log)

`7263a48a` 的三個 persistence fixture 通過七項，保留 genuine signal shadow 的零 override、callback 一次及零存活 native lease 斷言。關閉後的檢查改用明確 read-only facade，延遲到達的外層 publication 仍拒絕 `FACT_CLOSED`。Child callback 的 self-close 保持 typed conflict，原始 owner 持續有效，READY 後取得相同 document。首次型別檢查只碰到另一組新增測試漏填 `createdAt`，補正真實型別欄位後 persistence 型別檢查通過。[七項回歸](C:/Users/IvanKwan/AppData/Local/Temp/ih-close-readback-seven-initial.txt) [初次型別記錄](C:/Users/IvanKwan/AppData/Local/Temp/ih-close-readback-seven-types.txt)

`7a2c0edc` 的四個 constructor／capability fixture 通過 15 項及 persistence 型別檢查，均使用原有期限。必要 writer 方法缺失、複製 backend 與明確停用 ownership 的 writer 在建構時拒絕，四個可選 capture 方法缺失則保持可選入口不可用。Generic read backend 透過明確 read-only facade 檢查資料，所有 write-effect spies 保持零次。原始 child flight 與 duplicate flight 在 finally 完成後才清理。[15 項回歸](C:/Users/IvanKwan/AppData/Local/Temp/ih-constructor-capabilities-initial.txt) [型別檢查](C:/Users/IvanKwan/AppData/Local/Temp/ih-constructor-capabilities-types.txt)

`0015a24a` 整合公開 child 的原子建立、bootstrap 原始 pending 收尾，以及 commit-log observation 修正。18 個檔案的工作目錄雜湊在提交前全部核對。最新 native birth／guard／commit ACK 組合為 45 項通過，有／無 seq 的 memory observation 與引用座標另有八項複驗，完整 Task launch 為 30 項，bootstrap／close／observation 為 86 項，真正 reviewer 為十項，Task／commit 整合為七項，legacy selection／visibility 為十項，commit observation 為 14 項。這些範圍有交集。core-session、persistence、subagent、guard-approval、executor 型別檢查全部通過。[18 檔清單與收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-b-runtime-final-receipt/receipt.json) [native 45 項](C:/Users/IvanKwan/AppData/Local/Temp/ih-raw-birth-native-controls45-final.log) [bootstrap 與 close 86 項](C:/Users/IvanKwan/AppData/Local/Temp/ih-bootstrap-close-observation-regressions-final.log)

Child 的捕獲資料保留原始 callback receiver、role、message、fork selection、timing 與 header hints，結果來源在 storage birth 前完成 admission。Missing seq 僅在自己的 observation copy 補上位置，原始 parent、既有座標及 context／reference 內容保持相同。Review 使用既有 parent allowance。真正 Code Mode 的非 yield 測試明確等待其預期回覆，另外的 yield 控制仍保留。Task 功能初次資格驗證曾使用 45 秒操作及 15 秒 cleanup 餘裕，`b991ed7e` 修正故障 fixture 後已恢復 20 秒操作期限。generation／expiry 及 1／0 效果斷言持續通過，所有原始 flight 在還原 spies 前完成。[unsequenced 與座標複驗](C:/Users/IvanKwan/AppData/Local/Temp/ih-raw-birth-unsequenced-typed-fixture-final.log) [reviewer 十項](C:/Users/IvanKwan/AppData/Local/Temp/ih-raw-birth-reviewer-owned-cleanup-final.log) [原期限完整 Task launch](C:/Users/IvanKwan/AppData/Local/Temp/ih-task-scoped-lease-full30-final20.log)

在 `0015a24a` 的固定工作目錄上，Persistence 與 JSONL 全套依序完成。Persistence 為 1,191 通過、26 失敗，JSONL 為 803 通過、81 失敗及 17 skipped，兩者未處理錯誤均為零。使用正常 wrapper、兩個 worker、原期限及完整 package 範圍，耗時分別為 374.34 秒及 481.35 秒。當時有五個未提交的其它 package 測試及本報告，相關 source 與測試雜湊在執行期間保持固定，完整失敗清單已保存。[完整清單與驗證範圍](C:/Users/IvanKwan/AppData/Local/Temp/ih-persistence-jsonl-full-0015a24a/inventory.md)

`a52d9a92` 修正 Persistence 七個檔案的建構、原始 lifetime、logical legacy scope 與故障注入 fixture。六個檔案共 96 項在首次整組通過，fork-controller 在最後完整執行為 32 項通過，合計 128 項分次完成，Persistence 型別檢查通過。保留原五秒期限及 falsey cause、原始 handle retry、consumed debt 與來源變更控制。已消費 reservation 而缺 header 的案例，真正 reconcile 持續回覆 unknown，測試明確要求 coordinator close 拒絕，再以測試所持有的原始 OS handle 清理。整個 Persistence package 仍需於其餘修訂完成後重跑。[首次七檔記錄](C:/Users/IvanKwan/AppData/Local/Temp/ih-p-seven-qualified.log) [最後 fork 32 項](C:/Users/IvanKwan/AppData/Local/Temp/ih-fork-controller-whole-qualified.log) [型別檢查](C:/Users/IvanKwan/AppData/Local/Temp/ih-p-seven-types-final.log)

`cfba10ea` 的五個 JSONL fixture 共 79 項分次通過，另有一項既有環境條件 predecessor 案例 skipped，JSONL 型別檢查通過。冷讀 metadata 的原 30 秒逾時案例，在保留未選取 native lease 的原始身分後以約 5.6 秒完成，期限保持原樣。Replacement fork 核對四個 semantic seed records、第五個 completion record 與下一筆 seq 5，原始訊息內容及母會話位元組一致。格式拒絕核對 native transition 的 `SESSION_FORMAT_UNSUPPORTED` 與原始 cause，constructor 內的 repair counter 保持零。實際 rename 後撤銷的測試確認已發布位元組、unknown 結果與零次最終 writable open。[四檔首次整組記錄](C:/Users/IvanKwan/AppData/Local/Temp/ih-root-jsonl-four-whole.log) [格式與 replacement 最終 11 項](C:/Users/IvanKwan/AppData/Local/Temp/ih-root-jsonl-format-fixtures-final.log) [JSONL 型別檢查](C:/Users/IvanKwan/AppData/Local/Temp/ih-root-jsonl-fixtures-types.log)

長對話效能的固定 3／33／65 目標量測保持相同請求位元組及新鮮度斷言。私有 `WeakSet` 僅重用本模組已建構及深度凍結的資料，外部物件、accessor 與 Proxy 繼續完整驗證。短字串編碼保持相同 canonical 位元組、字元跳脫及 24 KiB chunk 上限。最後再將 retirement disposition 判斷移到 `current()` 前，沒有 disposition 的請求每次減少一次完整 capture。65 目標由 670 次降至 603 次，完整快照的 inclusive 時間由 25.17 秒降至 20.56 秒，最後模型請求到達時間由 43.94 秒降至 38.49 秒。67 個請求與最後 52,574 bytes 的請求大小相同。跨 callback 的兩次獨立檢查維持原順序，68 項新鮮度及 recovery 回歸通過。[最終 65 目標比較](C:/Users/IvanKwan/AppData/Local/Temp/ih-instruction-capture-disposition-first-65.json) [內部分段量測](C:/Users/IvanKwan/AppData/Local/Temp/ih-instruction-capture-inner-3-33-65.json) [68 項回歸](C:/Users/IvanKwan/AppData/Local/Temp/ih-context-disposition-first-regression.log)

257 目標的首次完整通過為 545.017 秒。加入上述短路條件後，最終案例為 507.775 秒，整個命令包含收集階段為 529.76 秒，均使用單一 worker，原來的單輪 540 秒及案例 600 秒期限保留。最終執行從 `df7c634a` 加上待提交的三個效能檔案開始，期間只有五個無關 persistence 測試提交為 `444e9ea2`，三個 production 檔案與長測試內容保持固定。profile 中的投影、複製與編碼時間包含巢狀呼叫，不能相加作為總 CPU 時間。[首次完整通過](C:/Users/IvanKwan/AppData/Local/Temp/ih-instruction-original257-short-string.log) [最終 257 目標結果](C:/Users/IvanKwan/AppData/Local/Temp/ih-instruction-original257-final.log)

效能修訂的下游驗證包含 output-retention 45 項、Code Mode 完整 383 項、serializer／deep-result 26 項，以及 core-agent、core-session、context-engine 三個 package 最終型別檢查，全部通過。五個檔案已提交為 `d3d94e5d`。暫時量測探針已移除，長測試檔案內容與既有期限保持原樣。[輸出保存](C:/Users/IvanKwan/AppData/Local/Temp/ih-performance-output-retention-final.log) [Code Mode 完整套件](C:/Users/IvanKwan/AppData/Local/Temp/ih-performance-code-mode-final.log) [serializer 回歸](C:/Users/IvanKwan/AppData/Local/Temp/ih-performance-serializer-final.log) [三個 package 型別](C:/Users/IvanKwan/AppData/Local/Temp/ih-performance-types-final.log)

`42c0b311` 完成原始 Task recovery error 與 document close 的修正。完整 required-settlement 15 項與新增 native 三項，在正常雙 worker 下全部通過，使用各案例原 20／60 秒期限。其它已完成範圍包含 Gateway delivery／cold inspection 24 項、普通與 falsey chain 六項、Persistence source／close 70 項及 consumed cleanup 兩項。非 required source 的 native UNKNOWN 與原始 start receipts 三項另於最終檔案重跑通過。Subagent、Executor、Gateway、Persistence 型別檢查通過，提交前核對了全部 14 個檔案雜湊。[完整 18 項](C:/Users/IvanKwan/AppData/Local/Temp/ih-issue86-consolidated18-final.log) [非 required source 最終重跑](C:/Users/IvanKwan/AppData/Local/Temp/ih-issue86-nonrequired-exact-final.log) [完整清單及收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-issue83-86-final-receipt.json)

Task ACK 的真正恢復由同一原始保存與 source close 證明。控制案例記錄兩份捕獲 snapshot 與三次保存嘗試，前兩次使用相同位元組，接著確認相同結果 revision 與 outbox 的 pending→delivered 更新。Held source ACK 的案例等待同一個第一次 service close 成功，並核對刻意製造的暫時 readiness 診斷訊息。Code Mode、一般 callback 與非 required source 仍各自保留其實際失敗結果。[原始 chain 與 ACK 控制](D:/codex-ih-development/packages/session-executor/test/task-chain-acknowledgment.test.ts) [保存與通知順序](D:/codex-ih-development/packages/session-executor/test/required-task-settlement.test.ts)

`16ac630f` 的子代理完整測試檔為 48／48 通過，Subagent 型別檢查通過。測試使用真正 bootstrap header 與 batch constructor 觀察建立過程，核對繼承訊息、semantic seed、initial admission、連續 fact 座標、delegation depth，以及工具 body 前的持久化 checkpoint。清理會等待原始 child body、disposer、context 和 coordinator。初始化的 provider 錯誤保持原錯誤回傳，內部清理依既有 AbortSignal 語義停止尚未執行的 setup generation，測試核對其 stopped disposition 與零 model attempt／publication。[48 項完整結果](C:/Users/IvanKwan/AppData/Local/Temp/ih-child-full48-qualified.log) [檔案及型別收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-child-qualified-receipt.json)

摘要邊界同時保留 512 與原 3,000-token 情況。512 下的固定輸出 floor 使準備階段拒絕 transport。3,000 下實際送出兩個合法的 dedicated summary request，每個請求的 input 加 output cap 均在限制內，包含原始繼承內容，provider rejection 與 main request 次數均為零。兩次無效 checkpoint 後回覆 `prompt_too_long`，原始歷史與 reset 控制均通過。[原始 3,000 與 512 控制](D:/codex-ih-development/packages/subagent/test/child.test.ts)

在 `16ac630f` 加上當時待提交 journal lifetime／bootstrap 修訂的固定工作目錄上，Persistence 全套完成 1,214 通過、3 失敗、0 skipped，135 個檔案耗時 391.06 秒，未處理錯誤為零。執行期間 24 個 source／test 檔案雜湊全部核對一致。失敗項目為一個 child 讀取預期，以及 fork preparation 與全庫 durable-event 來源掃描的兩個五秒逾時。三個 fixture 的完整檔案其後取得 58 項通過並整合至 `f2dd1b56`，全套後續結果如下。[該輪完整 Persistence 記錄](C:/Users/IvanKwan/AppData/Local/Temp/ih-persistence-full-post-journal-lifetime.log) [來源雜湊與驗證範圍](C:/Users/IvanKwan/AppData/Local/Temp/ih-persistence-full-post-journal-lifetime.metadata.json)

`f2dd1b56` 整合 30 個檔案，包含 14 個 production 檔案及 16 個測試檔案。Journal descriptor、原始 mutation token、歷史格式 birth、header reconciliation 及 retained Task proof 的來源與資格驗證雜湊已保存。兩個 package 的完整測試在固定 source／test 下依序執行，均使用正常 wrapper、兩個 worker、原始期限及完整 package 範圍。[整合收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-persistence-recovery-integration-receipt.json)

| Package | 通過 | 失敗 | 略過 | 耗時 |
| --- | ---: | ---: | ---: | ---: |
| session-persistence | 1,215 | 2 | 0 | 402.07 秒 |
| session-persistence-jsonl | 948 | 2 | 17 | 397.24 秒 |

合計 2,163 通過、4 失敗、17 skipped，未處理錯誤為零。Persistence 的失敗涉及合法 torn completion 的恢復，以及來源掃描的五秒逾時。JSONL 兩項 cleanup diagnostic fixture 在 native handle 已消耗但 close ACK 拋錯後，仍預期 coordinator 能回覆 clean。完整清單及執行前後雜湊均保留。[完整失敗清單](C:/Users/IvanKwan/AppData/Local/Temp/ih-full-persistence-f2dd1b56/inventory.json) [Persistence 日誌](C:/Users/IvanKwan/AppData/Local/Temp/ih-full-persistence-f2dd1b56/persistence.log) [JSONL 日誌](C:/Users/IvanKwan/AppData/Local/Temp/ih-full-persistence-f2dd1b56/jsonl.log)

`a6d3f41e` 修正 torn completion 的恢復邊界。已完整的 header 與 seed 之後，允許觀察一個長度有界且尚未提交的 completion 尾段，所有實際位元組納入 currentness fingerprint。原流程仍先確認 Task、準備 target、取得 dependencies，再由原始 `reconcileOwnedBatch` 比對整段尾部與實際 completion batch。非空 context-output artifact 的實際儲存搭配受控 dependency port 驗證此順序。完整 bootstrap recovery 為 18 項通過，JSONL 十個檔案為 232 項通過，兩個 package 型別檢查通過。Cleanup diagnostic 另核對已知 committed receipt、單次安全診斷及持續保留的清理責任。[修訂檔案收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-b-tail-regression-final/receipt.json)

來源掃描使用 regex。另一輪完整 Persistence 診斷中，掃描三項均通過，實際 body 為 417.23ms，1581 個檔案、11,063,019 bytes、58 matches 與單獨量測完全相同。原先 17.528 秒的耗時尚未歸因。該輪全套為 1,215 通過、2 失敗，另觀察到明確重建已刪除會話的 Windows `rename` 偶發 `EPERM`。暫時探針已完整移除，來源位元組與 HEAD 核對一致。[掃描比較與來源核對](C:/Users/IvanKwan/AppData/Local/Temp/ih-full-p-scanner-comparison.json)

Windows 重建診斷使用相同原始 generation 與完成的 stage。既有 500ms 重試的 20 次量測中有一次失敗，暫時 2,000ms 候選的 40 次量測中仍有一次失敗。真正的 Windows reader 在約 700ms 後釋放時，較長候選可以於同一次操作完成，持續佔用及 foreign-generation 控制仍正確拒絕。兩組為不同樣本，所有已追蹤 descriptor、pending reads 與 native leases 最終均為零，偶發失敗來源尚未辨明。Production 已逐位元組恢復既有重試實作，繼續採集原生錯誤證據。[候選摘要](C:/Users/IvanKwan/AppData/Local/Temp/ih-commit-retry-candidate-summary.json) [候選量測](C:/Users/IvanKwan/AppData/Local/Temp/ih-commit-retry-candidate.log)

原生歸因探針完成七次實際重建，第七次遭遇五次 `EPERM` 後，在既有 500ms 範圍內成功。每次拒絕之後，對相同 target 與 stage 以 DELETE access 開啟均成功，檔案沒有 read-only attribute，內容雜湊保持相同，探針取得的句柄均完成關閉。這些後續觀察尚不足以辨識先前 rename 拒絕的來源。暫時測試已移除，production 與既有版本逐位元組一致。[原生觀察](C:/Users/IvanKwan/AppData/Local/Temp/ih-commit-native-attribution.jsonl) [診斷日誌](C:/Users/IvanKwan/AppData/Local/Temp/ih-commit-native-attribution.log)

`a6d3f41e` 的最新完整重跑在 source／test 全部固定下依序完成。Persistence 為 135 個檔案、1,218 項全數通過，耗時 441.77 秒。JSONL 為 950 項通過、17 項略過，105 個檔案通過、3 個檔案整檔略過，耗時 443.99 秒。兩個程序 exit 均為零，未處理錯誤為零，HEAD 與逐路徑 source／test 雜湊在執行前後完全相同。[完整結果與略過清單](C:/Users/IvanKwan/AppData/Local/Temp/ih-full-persistence-a6d3f41e/inventory.json) [Persistence 日誌](C:/Users/IvanKwan/AppData/Local/Temp/ih-full-persistence-a6d3f41e/persistence.log) [JSONL 日誌](C:/Users/IvanKwan/AppData/Local/Temp/ih-full-persistence-a6d3f41e/jsonl.log)

略過案例分布在 `cold-selected-capability` 一項、`task-d-repair-header-path` 一項、`task-transition-original13` 九項、`task-transition-selected-cold-retry` 三項，以及 `task-transition-selected-cold` 三項。全部使用既有 `IH_TASK_D_PREDECESSOR_FIXTURES` 條件，需提供真正歷史產生器及其 manifest，後續驗證將逐項記錄。[略過案例與原因](C:/Users/IvanKwan/AppData/Local/Temp/ih-full-persistence-a6d3f41e/inventory.json)

上述 17 項已完成補驗。產生器使用本機 Git 中 `5cb58e62766b4d1e821ac97b382a1dedb940a667` 的原始 format 13 程式，建立普通會話、Task1／Task2 companion、public／child birth、原始 syscall 中斷的 header-only birth，以及帶有實際 native receipts 的 selected-result birth。五個完整測試檔共 70 項全部通過，耗時 131.88 秒，包含原本 17 項略過及 53 項既有案例。267 個原始程式／manifest 檔案與 26 個產出檔案的雜湊在驗證後仍相同。[補驗收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-predecessor17-current-qualification/receipt.json) [原始產生器 manifest](C:/Users/IvanKwan/AppData/Local/Temp/ih-task-d-predecessor-5cb58e6-run3/manifest.json) [原始 producer receipts](C:/Users/IvanKwan/AppData/Local/Temp/ih-task-d-predecessor-5cb58e6-run3/outputs/original-receipts.json)

`0624727c` 修正 CLI SDK fixture 的原始資源責任。完整測試檔 10 項在原有期限內通過，耗時 66.83 秒，CLI 型別檢查通過。九個具有資源的案例均記錄實際子程序 exit 0、HTTP listener 已關閉、pending operations 為零、settings 位元組相同，以及單次 close flight／SDK close ACK。新的無效 store 案例使用真正的檔案路徑與 SDK／CLI，在 3.690 秒內取得 `RpcError -32603` 及原始 `session/create` 錯誤，原生效果為零。[完整測試](C:/Users/IvanKwan/AppData/Local/Temp/ih-sdk-approval-ten-untraced.log) [資格驗證收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-sdk-approval-qualified-receipt.json)

該檔首次執行為九項通過、一項初始化逾時。當時 initialize 持續 pending 至 20 秒，測試 hook 隨後完成原始 SDK 關閉，確認實際子程序被終止、HTTP listener 關閉及在途請求歸零。後續在真正 CLI 入口加入的暫時分段量測，以及移除量測後的完整十項執行，均正常回報同一無效 store 錯誤。首次延遲來源尚未歸因，原始記錄持續保留。CLI production 檔案已逐位元組恢復，測試期限保持原樣。[首次記錄](C:/Users/IvanKwan/AppData/Local/Temp/ih-sdk-approval-ten-first.log) [原始資源稽核](C:/Users/IvanKwan/AppData/Local/Temp/ih-sdk-approval-receipt-audit.json)

Gateway 的追加效能檢查使用重建的同一個實際 RPC fixture、原生 artifact 與正常 version 1 fork。原實作兩次量測的首輪 execute 分別為 5.997／6.820 秒，同一程序的第二輪為 4.851／4.607 秒。首輪均為 4,400 個原生驗證批次、13,624 個驗證項目，第二輪均為 4,141 個批次、12,777 個項目，各有六次實體 metadata 讀取。較早的 profile 原始程式已移除，因此本輪使用自己的配對基準。[第一組原實作量測](C:/Users/IvanKwan/AppData/Local/Temp/ih-gateway-one-ref-fresh-15384.json) [重複原實作量測](C:/Users/IvanKwan/AppData/Local/Temp/ih-gateway-one-ref-fresh-15864.json)

兩個候選分別重用既有 coherent project observer 於 dependency check 及 target-scope getter，原生驗證次數均與配對基準完全相同。候選已全部撤回，涉及的 production／測試檔案與原始版本逐位元組核對一致，暫時 profiler 亦已移出 repository。限量 stack 採樣定位到 legacy fork-transfer guard、observed read、result observation 及 binding currentness，host admission callback 的邊界仍會分開原生驗證批次。這次檢查記錄剩餘成本，額外效能改善尚未完成資格驗證。[採樣摘要](C:/Users/IvanKwan/AppData/Local/Temp/ih-one-ref-native-stack-summary.json) [兩個候選與調查記錄](C:/Users/IvanKwan/AppData/Local/Temp/ih-gateway-coherent-bootstrap-static/REVIEW.md)

後續第三個候選合併 host callback 之後的原始 document readiness 與 metadata 核對，單 reference fork 每輪減少 295 個批次與 885 個驗證項目，約 6.7% 至 7.1%。同一組 wall-time 量測有升有降。新增的真實獨立 writer 控制顯示，原實作可以讀取已提交前綴，候選的額外 snapshot 資格檢查卻拒絕這條正常路徑。候選已撤回，production 與額外 exports 均恢復。`cc56896e` 僅加入這條原始 writer 暫停期間的讀取回歸，完整檔案八項及 Executor 型別檢查通過。[撤回與回歸收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-posthost-withdrawal-final/receipt.json)

### Subagent 完整測試與測試品質核對

`334484a2` 的完整 Subagent 套件在固定來源上完成 705 項通過、130 項失敗、零略過，83 個檔案中有 16 個失敗，耗時 664.49 秒，未處理錯誤為零。執行前後 HEAD 及 source／test 雜湊相同。失敗清單包含多個共用 fixture 的錯誤，也重現了第 93 至 95 項實際程式缺陷。[完整清單](C:/Users/IvanKwan/AppData/Local/Temp/ih-full-subagent-334484a2/inventory.json) [原始日誌](C:/Users/IvanKwan/AppData/Local/Temp/ih-full-subagent-334484a2/subagent.log)

第 93 項用相同 Jobs 測試檔重現及複驗。修正前為 18 項通過、一項失敗，重複 finish 產生第三次通知。`b36a8de2` 後 19 項全部通過，另有一項原始 Task 投影補上 terminal identity 的控制通過，Subagent 型別檢查通過。[修正前](C:/Users/IvanKwan/AppData/Local/Temp/ih-job-duplicate-publication-baseline.log) [修正後](C:/Users/IvanKwan/AppData/Local/Temp/ih-job-duplicate-publication-fixed.log) [原始 Task 身分控制](C:/Users/IvanKwan/AppData/Local/Temp/ih-job-original-terminal-identity.log)

`b5c1c0a3` 修訂 owned-load／owned-save 兩個檔案，解決前一輪的 76 項失敗。完整 92 項在原五秒期限內通過，耗時 69.04 秒。原生鎖只在指定故障路徑包裝，一個正常載入案例的準備由約 3.46 秒降至 0.77 秒。Bound-v3 案例從真正 child 檔案準備 inbox，並核對檔案位元組相同。Mirror 以原始 I/O 暫停，驗證已完成角色目錄載入時的角色操作，以及仍待 mirror 完成的 Task／Job 執行限制。[92 項收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-task-owned-final92/receipt.json)

這組修訂也核對實際 native disposition。未發出的操作可以完成清理，UNKNOWN 則需取得同一原始 ACK 才能清理，原來的 rejected promise 與退休 consumer 的 handoff／release 拒絕繼續驗證。後續 queued snapshot 只在原始 ACK 恢復後推進，Task A 的 terminal 內容保持精確，後續資料差異由另一個 Task B 的正常 claim 產生。最後僅對已修改的密集測試區塊作可讀性整理，兩個完整檔案的正規化 emitted JavaScript 在整理前後逐位元組相同，TypeScript parse diagnostics 為零。[格式等價與最終雜湊](C:/Users/IvanKwan/AppData/Local/Temp/ih-task-owned-final92/format-equivalence.json)

`2494a868` 的七個測試檔完成 135 項通過及 Subagent 型別檢查，耗時 27.85 秒，來源雜湊在執行前後一致。檢查涵蓋真正 semantic child birth、送給模型的繼承訊息、最後一輪選取跨越舊 replacement、錯誤 anchor 在任何儲存或模型效果前拒絕、三個實際保存階段的排隊與 flush，以及同一原始 UNKNOWN save 在正確時間點的 ACK 與退休驗證。[七檔資格驗證收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-root-subagent-seven-receipt.json)

Auxiliary persistence 的修訂驗證相同 immutable snapshot 的明確重試，並在原記憶體 Job 改變後核對重試仍保存最初內容。Followup 測試以真正 body 進入訊號確認序列順序，逾時測試以可釋放的 provider gate 維持實際未完成工作，完成後加入原始 cleanup。這些控制取代了對 microtask 次數、原始框架事件或過時格式常數的假設。[七檔完整日誌](C:/Users/IvanKwan/AppData/Local/Temp/ih-root-subagent-seven-final.log)

另有一項原生 managed-child 整合案例的本地完整工作量量到 5.94 秒及 6.35 秒，因此採用局部 15 秒案例期限。該案例驗證真正 prepared Agent／Task、parent Stop 的實際取消、單次 child transport、對應終態與完整 cleanup，已包含於 `7ed799c1` 的六檔 Subagent 驗證。

`7ed799c1` 完成第 94、95 項修正，共九個 production 檔案及十個測試檔案。原始父寫入的錯誤辨識使用既有 required-parent 證據與 source-run 記錄，要求確切的 parent、source、Pending、錯誤、entry 及 completion chain。安裝成功或確認不存在的標記在相應操作成功後產生，Task／end／source close 的原始 ACK 一併決定歷史錯誤是否已解除。未分類 callback 與普通 private parent 的拒絕順序亦經實際控制驗證。[19 檔雜湊清單](C:/Users/IvanKwan/AppData/Local/Temp/ih-c-parent-final-manifest.json)

| 驗證範圍 | 結果 |
| --- | ---: |
| 六個 Subagent 檔案與原始重現 | 37 項通過 |
| Private-parent 與 cleanup helper | 19 項通過 |
| JSONL journal／native cleanup | 41 項通過 |
| Executor required Task／原始 ACK chain | 18 項通過 |
| 普通 falsey chain／非 required UNKNOWN | 7 項通過 |

五個套件的最後型別檢查全部通過，涵蓋 Persistence、JSONL、Subagent、Executor 與 Gateway。型別檢查發現的兩個冗餘 truthy guard 已在同一 native 分支改為直接呼叫，執行條件等價。原始回歸亦驗證同一個第一次 close promise 在釋放真正 held ACK 後完成。[Subagent 37 項](C:/Users/IvanKwan/AppData/Local/Temp/ih-c-parent-full-six-final.log) [底層 19 項](C:/Users/IvanKwan/AppData/Local/Temp/ih-c-parent-low-controls-final3.log) [JSONL 41 項](C:/Users/IvanKwan/AppData/Local/Temp/ih-c-parent-jsonl-controls.log) [Executor 18 項](C:/Users/IvanKwan/AppData/Local/Temp/ih-c-parent-executor-ack-controls.log)

Managed Job 的 generic producer 使用原本獨立的 `jobs` auxiliary namespace，驗證實際 UNKNOWN、原始 reconciliation 與 Stop 後已完成結果的保存。真正 child 則各自驗證仍在執行時的取消，以及已完成但原始 end append 尚被暫停時的結果保存。兩者都核對原始 controller／transport signal、Task outcome 與一次實體 end write。前者在後續 drain 後取消，後者保留相同已完成結果與 revision。這兩種原生情境使用上述局部 15 秒案例期限。[原始結果與 Stop 控制](D:/codex-ih-development/packages/subagent/test/managed-job-facts.test.ts)

`aff1966c` 的 Task2／pending 修正通過六個完整檔案共 31 項及 Subagent 型別檢查。三個正常入口案例保留原有 legacy memory parent、角色模型及嚴格保存 hook，先重現保存前的 Retained task body incomplete，再驗證同一 Task 的完整結果經原始 ACK 保存。故障恢復保持模型呼叫兩次及工具效果一次，原始錯誤不會被 cleanup 覆蓋。[第 96、97 項收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-issue96-97-final-receipt/receipt.json)

`b07b22a5` 的歷史 artifact reader 修正通過 15 項矩陣、六檔 38 項與 Subagent 型別檢查。控制包含缺少 reader、明確 unavailable reader、真正 owned Task2、已保存原始結果的 reader 撤銷與恢復，以及 live 結果複製 savedObservation 時仍須完成嚴格保存。訂閱控制先重現狀態已失敗卻收到零次通知，再驗證 failed／durable 轉換各通知一次，重複失敗及重複 ACK 不增加通知。[第 98 項最終收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-issue98-notification-final-receipt/receipt.json)

隨後在固定 `b07b22a5` 執行完整 Subagent，共 844 項通過、10 項失敗、零略過，耗時 472.29 秒，未處理錯誤為零。九項 owned-save 失敗涉及預期保存入口未進入、retention 未設定、原始 terminal save 未排入及 cleanup 未完成。另一項 canonical Task 關閉案例超過原 60 秒期限。所有 production source、Subagent 測試及輔助檔案在執行前後雜湊一致。這輪結果證明定向通過仍須完整套件檢查，目前正以相同案例進行修改前後歸因。[完整結果](C:/Users/IvanKwan/AppData/Local/Temp/ih-full-subagent-b07b22a5/inventory.json)

`984963d3` 修正第 96 項引入的 owned-save 回歸。相同、未修改的原始 source-save 案例在修正前拋出 Retained task body incomplete，僅移除把 ownedTask 當成 capture 的判斷後通過。真正 Task1／Task2 document owner 的新增控制驗證完整多語文字、原格式、原始 committed save 及 cleanup ACK，無須製造 result descriptor 或 legacy 標記。原有 55 項保存測試與 17 項矩陣合計 72 項通過，六檔 40 項及 Subagent 型別檢查通過，全部使用原期限。[原始重現與最後收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-issue96-owned-document-regression-final/receipt.json)

Canonical Task 的原兩項案例在單檔重跑各約 15 秒內通過，維持原 60 秒期限。完整執行留下的實體檔案顯示子任務結果及 subagent/end 已保存，通知仍為 pending、attempts 為零且沒有 delivery-received，因此逾時發生於 helper 等待通知進入，當時尚未呼叫 service.close。其後兩輪追蹤再次重現，原始 source close ACK 及通知 hint 均已發出，父會話的原始 step/end 卻先被拒絕。[未修改案例重跑](C:/Users/IvanKwan/AppData/Local/Temp/ih-issue96-canonical-close-two.log) [第一輪追蹤](C:/Users/IvanKwan/AppData/Local/Temp/ih-canonical-phase-diagnostic/run1.log)

第 99 項的控制在真正 core.prepareWrite 完成後、Pending 指派前暫停父 step/end，再讓原始子任務完成及取得真正 Task writer exclusion。Task 文件發布約在 15,735ms 被暫停，父寫入於 15,737ms 因 requiredWriter 存在而拒絕，當時 authorization.required 為 true、issued 為 false。原始 admission 在 15,747ms 回覆 not-issued／FACT_RECOVERY_REQUIRED，父 run 的 recovery hold 隨後才出現。這個時序確認首次拒絕源於準備階段的寫入保留空隙。診斷 hook 已從正式來源還原，原始失敗資料繼續保留。[因果控制追蹤](C:/Users/IvanKwan/AppData/Local/Temp/i-harness-tests-20616-mwexyoiq/ih_native_dependency_evidence_root/canonical-task-close-oLzAlw/phase-trace.jsonl)

候選修正的真實父會話／子任務控制在原 60 秒期限內完成，耗時 15.284 秒。永久回歸控制改在真正的 writer acquisition 嘗試後釋放準備 gate，並在相同測試下比較 `984963d3` 與候選來源。前者於約 935ms 回覆 not-issued／FACT_RECOVERY_REQUIRED，後者完成同一個 step/end，實體 append 與對應事件各一次。診斷 hook 已還原。[相同控制的原始失敗](C:/Users/IvanKwan/AppData/Local/Temp/ih-issue99-corrected-same-gate-baseline-red.log) [真實交錯完成控制](C:/Users/IvanKwan/AppData/Local/Temp/ih-issue99-fixed-causal/test.log)

第 100 項另以真正已 issued 的 native batch 驗證，原始 `984963d3` 在等待中收到 release 後仍讓 resume 成功。新增的準備期、原始已 issued 兩種退休控制，以及先開始等待、後遇到 opaque callback 的拒絕，同 source／同操作重入，以及四種 falsey dependency close 失敗，合計兩個完整 Persistence 檔案 31 項通過，Persistence 型別檢查通過。準備失敗會在原清理及 lane 結束後傳回原始原因，保留後續獨立操作原本的授權條件。[已 issued 退休競態原始失敗](C:/Users/IvanKwan/AppData/Local/Temp/ih-issue100-issued-baseline-red.log) [新九項回歸矩陣](C:/Users/IvanKwan/AppData/Local/Temp/ih-issue99-100-matrix-next.log)

`42dfc339` 已提交這兩項修正。最後兩個 Persistence 完整檔案為 31 項通過，原 canonical close 兩項、required Task 十五項及真正 private UNKNOWN 一項合計 18 項通過，耗時 56.19 秒，全部保留原期限。Persistence、JSONL、Subagent 與 Executor 型別檢查通過。最後可讀性整理與一項多餘檔尾換行的修正均另有等價紀錄，production source 的正規化 emitted JavaScript 逐位元組相同，parse diagnostics 為零。[最後資格驗證收據](C:/Users/IvanKwan/AppData/Local/Temp/ih-issue99-100-final/receipt.json) [最後 source 格式等價](C:/Users/IvanKwan/AppData/Local/Temp/ih-issue99-100-final/root-resume-format-equivalence.json) [檔尾換行等價](C:/Users/IvanKwan/AppData/Local/Temp/ih-issue99-100-final/root-test-eof-equivalence.json)

### Executor 與 Gateway 測試核對

`09afc598` 修訂五個測試檔案。讀取測試使用相同原始 coordinator，實體 FileHandle 的 close 故障在建構期注入，Gateway 則觀察真正的 retained coordinator close。故障案例保留原始拒絕及獨立清理錯誤，驗證單次 native close、拒絕新 owner、實體 descriptor 清理及原始 logical ACK 的區別。Setup、冷重開及已接受操作由相同測試 owner 等待完成，逾時後的延遲返回亦有清理責任。[五檔來源雜湊與範圍](C:/Users/IvanKwan/AppData/Local/Temp/ih-upper-final-five-manifest.json)

Executor 的三個完整檔案共 11 項通過，Gateway 的兩個完整檔案共 16 項通過，均使用正常兩個 worker，診斷 phase 與時間戳已移除。兩個套件的型別檢查通過。這輪執行來源為固定 `984963d3` 加上第 99 項未提交的 managed-document 候選，其 SHA256 為 `26D06088431A214B03699C5667581913F643855ED970C005404DD9AE051D1811`，來源在執行期間保持相同。[Executor 11 項](C:/Users/IvanKwan/AppData/Local/Temp/ih-upper-executor-full-untraced.log) [Gateway 16 項](C:/Users/IvanKwan/AppData/Local/Temp/ih-upper-gateway-full-untraced.log)

四項整合案例原本套用預設五秒期限，實際工作包含原生 fork、保留結果讀取、來源清除、冷重開及完整清理。先在原期限重現逾時，再以暫時 30 秒的有限診斷完成原有全部斷言，最後將這四項案例各自設為 20 秒。Project ABA 仍使用五秒，最後量到 4.025 秒。這些調整校正測試的等待預算，產品效能仍按實測耗時記錄。

| 案例 | 完整診斷耗時 | 移除診斷後耗時 | 最後案例期限 |
| --- | ---: | ---: | ---: |
| Gateway 兩次 nested fork | 7.707 秒 | 7.869 秒 | 20 秒 |
| Gateway managed／L1 transfer、來源釋放及 cold read | 10.356 秒 | 12.066 秒 | 20 秒 |
| Executor READY L1 live／cold read 與 shadowing | 8.076 秒 | 7.937 秒 | 20 秒 |
| Native-context seed、rewind、clear、read 與 retry | 8.989 秒 | 10.482 秒 | 20 秒 |

原本的資料可見性、拒絕條件、原始來源位元組、零次 provider build、captured scope、單次效果及 cleanup ACK 斷言均保留。原期限失敗、有限診斷及最後完整檔案的日誌分開保存。[Gateway 完整量測](C:/Users/IvanKwan/AppData/Local/Temp/ih-upper-gateway-phases30.log) [READY 完整量測](C:/Users/IvanKwan/AppData/Local/Temp/ih-upper-ready-diagnostic30.log) [Native-context 完整量測](C:/Users/IvanKwan/AppData/Local/Temp/ih-upper-native-diagnostic30.log)

後續另確認共用 legacyFixture 在成功 capture 後、初始化尚未返回時拒絕，service、broker 與 coordinator 的 cleanup 次數均為零。基準兩項案例先核對真正 native ownership、已提交 capture 與 source 檔案，再重現此缺口。`73082c41` 讓 helper 保存部分建立的原始 owner，初始化失敗時清理，原始 cleanup 拒絕則透過狹窄的 test-helper port 保留明確重試。已 ACK 的 sibling 不會再次關閉。並行初始化仍等待全部原始 capture／grant flight 結束後再收尾。[基準 native leak](C:/Users/IvanKwan/AppData/Local/Temp/ih-legacy-setup-baseline.log) [三檔最終雜湊清單](C:/Users/IvanKwan/AppData/Local/Temp/ih-legacy-setup-final-manifest.json)

新增完整檔案四項通過，包含普通失敗、falsey 清理拒絕、真正 held sibling 失敗及成功 grants。既有空 fork consumer 一項與 READY 完整檔案三項通過，Context-output 與 Executor 型別檢查通過。所有 native leases 與實際 FileHandle 均於原始清理 ACK 後驗證釋放；第一次清理拒絕後，只重試同一失敗 owner。大型 101／1,001 references 的完整覆蓋由本輪全庫驗證執行。[四項原生控制](C:/Users/IvanKwan/AppData/Local/Temp/ih-legacy-setup-native-concurrent.log) [READY 完整三項](C:/Users/IvanKwan/AppData/Local/Temp/ih-legacy-setup-ready-full.log)

### 第二輪整合檢查

| 範圍 | 本輪結果 |
| --- | --- |
| Commit-log 完整套件 | 15 個檔案、73 項通過，含 checkpoint、原生跨程序讀者、輸入捕獲、快照隔離及失敗清理 |
| Native fs-lock 完整套件 | 135 項通過、6 項平台或環境略過，另包含實際跨程序 close／crash 與 descriptor 重用控制 |
| coordinator／JSONL document claim 清理 | 4 項通過，成功讀取後 close 失敗及 failed-open 均由原 owner 重試，實際 native contention 驗證釋放順序 |
| 全庫 typecheck | `pnpm typecheck` exit 0，後續新增 Team 變更另作定向複驗 |
| Package boundaries | 138 個跨包來源引用，既有 baseline 147，gate 通過 |
| Reachability | gate 通過，保留 1 項既有失效 allowlist 提示 |
| S6 大型 legacy fork | 101 及 1,001 個實際 references 均在原有 30 分鐘／案例期限內完成 |
| Task 最終原生整合 | 相同 source、命令與期限重跑為 20／20 通過，總計 188.1 秒。7 個真實 crash case 各 16.7–18.8 秒，2 個 close case 各 15.6–17.1 秒 |
| Team 移除後完整 E2E | 10 個檔案、127 項全部通過，實際執行 71 秒 |
| 一般 Task／CLI 整組 | 3 個檔案、11 項全部通過，149.5 秒，涵蓋冷啟動、續作、關閉、不同 child 身分拒絕及歷史 Team 唯讀 |
| 實際 fork wire | 真正 READY 後遺失回覆、巢狀 fork、來源清理與冷讀取完成，76.2 秒 |
| Shell retry 的 native／Code 路徑 | 6 項全部通過，包含第二次 unknown、撤銷後零新效果與正常 close |
| Instructions 完整套件 | 142 項通過，3 項 Windows 檔案 symlink 案例因實際建立探測回報 EPERM 而略過 |
| PSEC 原生驗證 | 完整套件 121、Rust 單元 52、native smoke 34 通過，標準矩陣 39 通過、4 不支援、0 失敗，Git-byte checkout 亦通過 |
| 整合型別 checkpoint | 全庫執行為 81 通過、1 個 CLI fixture 型別失敗。移除未使用 polling helper，冷讀改用明確 readonly facet 後，CLI 定向 typecheck 通過 |
| 整合成品 | 隔離 compiled gateway 與 Windows ACL smoke 通過，實際回報兩個成功標記 |
| 整合邊界／reachability | 128 個跨包來源引用，原 baseline 147，兩個 gate 通過 |

Commit-log 完整結果、資源跨層回歸及型別檢查日誌可供複查。[commit-log 完整套件](C:/Users/IvanKwan/AppData/Local/Temp/ih-commit-log-retirement-full.log) [原始資源跨層清理](C:/Users/IvanKwan/AppData/Local/Temp/ih-commit-cleanup-retention.log) [全庫型別檢查](C:/Users/IvanKwan/AppData/Local/Temp/ih-structural-all-types.log)

Task 的首輪同時執行全庫型別編譯，20 項中有 6 項逾時、14 項通過。保留相同 source 與期限，在編譯完成後重跑取得 20 項通過，兩份日誌一併保留。crash case 的原有個別期限為 60 秒。[首輪記錄](C:/Users/IvanKwan/AppData/Local/Temp/ih-s4-final-native20.txt) [完成重跑](C:/Users/IvanKwan/AppData/Local/Temp/ih-s4-final-native20-quiet.txt)

端到端與 Task 整組均使用目前的正常產品入口。HTTP 測試伺服器與模型 transport fixture 提供受控回覆，檔案、子程序、持久化與 Windows 隔離由實際元件執行。[完整 E2E](C:/Users/IvanKwan/AppData/Local/Temp/ih-e2e-no-team-final.log) [CLI 整組](C:/Users/IvanKwan/AppData/Local/Temp/ih-cli-task-ordinary11-verified.txt) [fork 完整量測](C:/Users/IvanKwan/AppData/Local/Temp/ih-cli-fork-wire-full-measured.txt) [六項 retry 驗證](C:/Users/IvanKwan/AppData/Local/Temp/ih-retry-native-six-final.log)

個別原生整合案例依實際工作量設定有限期限。兩次新 CLI 程序的 help／錯誤參數案例量得 6.9 秒，採 20 秒期限。新的三次 headless run 關閉案例曾在原 20 秒期限內以 19.934 秒通過，後設為 30 秒。兩次 foreground Task birth 加四次 child turn 的案例量得 16.85 秒，採 45 秒。三個 SDK 程序、兩次 fork 與 16 次模型請求的案例量得 76.24 秒，採 90 秒。實際 child approval 矩陣的單項量得約 9 秒，採每項 30 秒期限。所有效果、權限、資料與清理斷言持續驗證。

JSONL 刪除後，明確的 `create(deletedId)` 依既有合約回覆 `SESSION_DELETED`。本輪曾為一個身分替換測試加入重建路徑，核對既有契約後已完整撤回該路徑。永久刪除 7 項與正常建構／關閉 24 項測試通過。不同 child 身分的負向案例使用另一個真實儲存區建立有效資料，再於所有 owner 關閉後替換測試檔案，驗證原 Task 拒絕接管。[永久刪除契約](D:/codex-ih-development/packages/session-persistence-jsonl/test/delete-owned.test.ts) [回歸記錄](C:/Users/IvanKwan/AppData/Local/Temp/ih-jsonl-permanent-deletion-final.log)

PSEC 標準矩陣的四項不支援繼續記錄為 PSEC／MSYS 與 PTY 的既有限制，qualification 狀態為 experimental／incomplete。一次完整套件曾觀察到 owned adapter 的 `SetFileInformationByHandle` 回報原生 code 5，root exit、輸出及取消已完成。壓力案例現在只對這個明確的 release 結果，透過同一 public handle 重試原始資源釋放，並驗證完整 ACK、輸出雜湊與冪等 close。第一次失敗與全部比較結果有保留，原生取消行為及期限維持原契約。[完整 PSEC 套件](C:/Users/IvanKwan/AppData/Local/Temp/ih-psec-staged-original-cleanup-final2.log) [新 qualification](D:/codex-ih-development/packages/sandbox-windows-psec/qualification.json) [比較記錄](C:/Users/IvanKwan/AppData/Local/Temp/ih-msys-pressure-comparison-results.json)

### 第一輪檢查記錄

| 範圍 | 已完成結果 |
| --- | --- |
| Commit-log 完整套件 | 最新重跑 10 個測試檔，55 項通過 |
| Commit coordinator 專項 | 9 個測試檔，50 項通過 |
| Core-session 完整套件 | 最後 production source 凍結後重跑，87 個測試檔、934 項通過 |
| SDK 完整套件 | 最後 production source 凍結後以單一 worker 重跑，22 個測試檔、140 項通過，保留既有期限 |
| Desktop 完整標準命令 | 203 個測試檔通過、3 個略過，1,565 項通過、7 項略過 |
| Settings 完整套件 | 20 個測試檔，248 項通過 |
| Provider file-runtime | 6 項通過 |
| Windows settings sharing | 5 項通過，涵蓋真實 child reader、期限、外部變更及永久錯誤 |
| Windows 同 ID 重建 | 新增 6 項 sharing／tombstone identity 案例通過，原有 2 項重建失敗案例重跑通過 |
| 已發布 child birth 恢復 | recovery、routes、cached ready、passive bootstrap、child admission 共 98 項通過 |
| 結果範圍授權 | 3 個檔案 10 項通過，另有實際 Shell revoked-scope 案例通過 |
| 實際工具與 captured source | Shell 15、private native Exec 5、nested Shell 2、nested Workflow 1、captured Code 6，共 29 項通過 |
| Summary physical admission | 2 項通過，staged writer 持有時 0 次模型呼叫，釋放後沿原有刷新路徑重新通過嚴格檢查，再進行恰好 1 次摘要 |
| Managed runtime 與 readiness | 最後 source 凍結後 3 個檔案、62 項通過，涵蓋原有 runtime 39、staged／hydration／pre-step 13、指令發布 10 |
| 指令分類與服務生命週期 | 30 項通過，包含原始 snapshot witness、健康 epoch、mapping failure 與實際讀取失敗 |
| Binding currentness | 專項使用單一 worker 與 120 秒 CLI 期限時 118 項通過，另有 16 項 artifact currentness negative cases 通過 |
| 指令適用範圍與實際工具授權 | 31 項通過 |
| Lazy options 與資料操作契約 | 11 項通過 |
| Package boundaries | 147 個既有跨包來源依賴，與既有 baseline 相同，gate 通過 |
| Reachability | gate 通過 |
| 最後本機 compiled artifact | 通過，隔離成品實際回報 gateway 與 Windows ACL 成功標記 |
| 最後 component typechecks | instructions、core-session、core-agent、session-executor 通過，相關 core-tools／code-mode 檢查亦已通過 |
| 最終分支全庫 typecheck | 由推送後的 `typecheck (all packages)` job 執行，完整執行結果保留於本分支 CI |
| 先前 GitHub CI `38c8cee7` | 全庫型別與隔離 compiled gateway／Windows ACL 通過 |

推送後的 CI 會執行全庫型別、test runner、package boundary 及隔離成品檢查。`verify:all` job 按既有 workflow 條件在手動或排程事件執行，push 的綠燈對應上述有限範圍。最終推送的狀態與 job 日誌可在本分支的工作流記錄查閱。[分支 CI](https://github.com/ivankwanpn/I-harness/actions/workflows/verify.yml?query=branch%3Acodex%2Fruntime-stability-redesign)

完整 Desktop 的初輪結果為 1,550 通過、15 失敗、7 略過。採用既有 `verify:all` 的兩個 worker 資源預算並修正測試握手後，曾取得 1,565 通過、7 略過。標準命令重跑又捕捉到 settings rename 的間歇失敗，導致問題 36、37 的進一步修正。其後標準命令取得 1,565 通過、7 略過，執行期間 production source 保持凍結。全庫診斷再次取得相同 Desktop 結果。

### Team 移除前的完整診斷記錄

以下保留 `38c8cee7` 階段的完整診斷與當時的待處理項目。該輪 `pnpm verify:all` 的 83 個專案全部回報，包含當時的 fixture 修改，執行期間亦有後續修正進入工作目錄。後續 Team 移除、固定版本測試及逐項修正的結果記錄於前文。

| 階段 | 完成結果 |
| --- | --- |
| Workspace suites | 14,589 通過、90 略過、1,564 失敗，17 個專案失敗 |
| 全庫 typecheck | 通過 |
| E2E | 107 通過、21 失敗，7 個測試檔失敗、3 個通過 |
| Reachability | 通過，1 項既有 allowlist entry 過期提示 |
| Package boundaries | 通過，147 個跨包來源依賴與 baseline 相同 |
| 隔離 compiled artifact | 通過，實際得到 `IH_COMPILED_ACL_OK` 與 `IH_COMPILED_GATEWAY_OK` |

失敗專案涵蓋 CLI、agent-team、code-mode、compaction、context-output、core-agent、desktop-gateway、exec、hooks、instructions、llm-anthropic、llm-bedrock、sandbox-windows-psec、session-executor、session-persistence、session-persistence-jsonl 及 subagent。部分失敗已促成上表的後續修正，完整列表仍有未完成逐案歸因的項目。基準分支的完整 suite 尚未執行，故無法把全部失敗歸因為基準缺陷或本分支迴歸。[診斷記錄](C:/Users/IvanKwan/AppData/Local/Temp/ih-verify-all-diagnostic-38c8cee7.log) [逐項失敗清單](C:/Users/IvanKwan/AppData/Local/Temp/ih-verify-all-diagnostic-38c8cee7.inventory.json) [執行來源與階段 metadata](C:/Users/IvanKwan/AppData/Local/Temp/ih-verify-all-diagnostic-38c8cee7.metadata.json)

CLI 的 59 個失敗中，41 個碰到缺少 native transition composition 的 fixture，13 個仍讀取舊的 tool-result 欄位，另有檔案計數、factory interception 及 help 字串落差。舊結果斷言會妨礙功能驗證，相關功能健康度仍需透過正確入口補驗。Team 的兩個 initial-input 語意失敗已補正，其餘 completion delivery 等失敗仍有驗證缺口。Windows instruction symlink 案例出現 `EPERM`，PSEC 真實 native 案例回報 `0x8007000f`，兩者需要各自釐清執行環境與產品行為。

最後另抽驗 5 個 child-instruction queued／unknown-publication／recovery 案例，結果為 5 項失敗，伴隨 5 個 cleanup rejection。這些 fixture 在 backend 建構後替換 `appendOwnedBatch` 或 `reconcileOwnedBatch`，觸發原始方法 descriptor 核對的 `PROCESS_READ_UNAVAILABLE`，預期的 native 階段因而無法到達。這 5 條舊測試需要改用建構期的原始 I/O wrapper，才能完成其預期行為的資格驗證。[定向記錄](C:/Users/IvanKwan/AppData/Local/Temp/ih-child-instruction-selected-final.log) [原始方法核對](D:/codex-ih-development/packages/session-persistence/src/coordinator/canonical-path-resolution.ts:26)

64-ID native stress case 在這台 Windows 主機由 101.91 秒降至 75.53 秒，保留 256 次 native acquisition 與 64 次文件讀取斷言。原測試包含 63 個 native-backed session 的建立，基準量測單此步驟已達 52.4 秒。該單一 stress case 現已明確使用 120 秒測試期限。新 child crash recovery 案例按實際 native I/O 量測採用個別 10 或 20 秒期限。nested Workflow fixture 的 context window 由 4,096 調為 16,000，原記錄顯示完整續作請求需要 4,342 tokens，所有結果與權限斷言均保留。

Persistence 完整套件首輪為 877 通過、267 失敗，另有兩個 unhandled error。150 個失敗發生在缺少 native task-transition composition 的舊正向 fixture，23 個失敗涉及建構後替換 backend 方法。完成 fixture 與責任邊界調整後，完整診斷取得 1,154 通過、19 失敗。其中 child admission 與 Windows recreation 失敗其後已有定向修正，其餘 cold-write、cleanup count 及 fork-controller 失敗保留在清單。已完成的修訂維持現有能力拒絕與負向授權檢查，使用正常建構方式、建構期 fault injection 及實際底層元件驗證各自責任。

## 參考機制

- Codex rollout recorder 由單一 writer 消費命令，flush 回覆前處理先前寫入。IH 採用同一 handle 的 mutation queue 與完成屏障。[recorder.rs](D:/ih-reference-project/codex-rust-v0.167.0/codex-rs/rollout/src/recorder.rs:137)
- DSH SessionHandle 明確定義讀取新鮮度、append、flush 與 close 的契約，generation 在發布前驗證暫存資料。IH 對應修正並行 append、先驗證後發布與 close 失敗清理。[handle.ts](D:/ih-reference-project/deepseek-harness-dsh-v0.2.2-rc.1/packages/session/session-persistence/src/handle.ts:48) [generation.ts](D:/ih-reference-project/deepseek-harness-dsh-v0.2.2-rc.1/packages/session/session-persistence-jsonl/src/generation.ts)
- OpenCode 的 SessionRunCoordinator 持有 active execution 與 awaitIdle，SessionStore 處理會話查詢。IH 由 SessionService 暴露活動觀察，讀取已提交資料與新工作 admission 各有條件。[run-coordinator.ts](D:/ih-reference-project/opencode-2.2.6/packages/core/src/session/run-coordinator.ts:9) [store.ts](D:/ih-reference-project/opencode-2.2.6/packages/core/src/session/store.ts)
- OpenCode 2.2.6 的背景 Job 有 SQLite 表、recovery 及 notification ID。這份版本證據支持保留 IH 的耐久工作與通知去重資料。[job.ts](D:/ih-reference-project/opencode-2.2.6/packages/core/src/job.ts:185)
- Pi 使用增量 append，fork 會建立新的 header 身分，worker 入口按 release runtime 明確解析。IH 對應修正長歷史成本、fork ID 與打包 runner。[session-manager.ts](D:/ih-reference-project/pi-1.5.1/packages/coding-agent/src/core/session-manager.ts:1188) [config.ts](D:/ih-reference-project/pi-1.5.1/packages/coding-agent/src/config.ts:524)
- ZCode 由主程序管理 host 生命週期，視窗重新掛接沿用原 host，並追蹤程序實際退出。IH 把重啟預算與收尾放回單一 manager。[desktopWindowLifecycle.ts](D:/ih-reference-project/ZCode-3.17.2/packages/desktop/src/main/desktopWindowLifecycle.ts:134) [desktopHostProcess.ts](D:/ih-reference-project/ZCode-3.17.2/packages/desktop/src/main/desktopHostProcess.ts:774)
- Windows 的開啟 handle 會持續限制檔案共享方式，rename 需要相容的 delete sharing。設定寫入的修正依據本機持有讀取 handle 的定向重現，並對照 Windows 文件。[CreateFile sharing modes](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea)
