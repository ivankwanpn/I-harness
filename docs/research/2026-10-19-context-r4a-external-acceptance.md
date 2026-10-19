# R4A 外部交付驗收 — 2026-10-19

**結論：CHANGES REQUESTED，尚未接受。** 原R4A整批仍未完成；本次新增A1／A2也有3個經獨立反例重現的P1缺陷。保留實作與證據，交回外部實作者修正；Codex本輪沒有修改產品程式。

## 審查範圍

- 工作目錄：`D:/I-harness-main`；分支：`codex/v0.1.13-development`。
- 本次審查HEAD：`41e97ecb80149bfe99bb7151c3bd5a0b7c11a9e7`。
- 外部增量BASE：`f362c6387a40fbb8d4a0e60184c3040e9f01d5fb`；產品提交`e0a9e841`、`b53938be`，文件提交`41e97ecb`。
- 整個R4A原BASE仍為`91d8fef04253272a437c68f5f2f84a657fa53d3b`，含尚未接受的WIP`81917360`。本輪讀完整外部增量與相關既有owner，沒有把原188檔整批宣稱重新驗收通過。
- 分工：一名GPT6.1Sol做唯讀程式審查；Codex主代理獨立核對原證據並依序執行反例、交付中的focused controls及型別檢查。沒有並行執行baseline／candidate，也沒有切換產品內容。

## 必修缺陷

### F1 — P1：真正的task文件在第二次cold restore被拒絕

位置：`packages/subagent/src/task/validation.ts:15`、`task/publication.ts:9`、`packages/subagent/src/result-publication.ts:17`。

新增驗證直接使用state/job的`validResultPublication`，但Task owner本來就會保存`{status, outcome, execution}`；共用驗證器只接受`status`、`execution`。第一次cold restore產生這份真正的savedObservation，重新保存後，下次restore就拋出`Unsupported retained task publication metadata`。

**獨立重現：2/2失敗。** 原parent F1已提交與未提交兩種情況都會失敗。這是owner自己產生、自己存下的合法資料被自己拒絕，不是偽造測試物件。缺陷會阻止後續載入task registry。

修正必須保留Task自己的status/outcome domain及closed schema，不能全面放寬state/job驗證；追加真正的restore→save→restore、committed／unqualified／cancelled控制。

### F2 — P1：背景結果保存了，正式工具結果卻沒有完整來源引用

位置：`packages/session-executor/src/lifecycle/exec-result-retention.ts:47`、`packages/exec/src/jobs/records.ts:24`；實際consumer `packages/subagent/src/tools/status.ts:79`。

新的被動背景保存始終向startup producer註冊dependency；但startup的ResultEnvelope已在EOF之前取得dependency snapshot。後續`job_output`是另一個真正的ToolExec，而observe的永久快取及固定startup producer使這次讀取沒有註冊原frame來源。內部`BackgroundJobView.retained`不會自動成為正式tool/result的dependency catalog。

**獨立重現：1/1失敗。** 真實assembly／pwsh／startup EOF gate，4次受控模型呼叫後，artifact已自動保存，但startup與正式`job_output`的dependency都不存在。大型輸出只剩有界preview，無法從該正式結果找到完整frame來源。

修正須分開「原capture的保存owner」與「本次真實讀取／完成觀測的dependency registration」。同一capture／artifact不重做；每個合法observer要有相應的來源、pin／grant及catalog。startup仍必須不等EOF。

### F3 — P1：保存狀態unknown被永久快取，原操作無法再恢復

位置：`packages/exec/src/jobs/records.ts:24`及`:39`。

`owner.observe`回傳`recovery-required`或reject時，程式仍永久快取已完成的`Promise<void>`。之後query、list、dispose只拿到同一個已結束promise，不再進行原capture的settlement。

**獨立重現：1/1失敗。** 真實exec service與controlled execution backend，原process只launch一次；經query/list/dispose後observe與settle仍只有1次。直接再次操作同一原capture，第二次能進入已知`ready/unavailable/storage-refused`狀態，證明原操作本身可以前進，而上層快取封死了入口。

這個反例證明原unknown操作可恢復為已知處置；它沒有宣稱故障後成功發布artifact。修正應區分in-flight coalescing、確定terminal disposition及仍需reconcile的unknown，不新增無界retry、不得重跑process、不得讓dispose假稱已完成必要保存。

### F4 — P2：有adapter物件不等於有可用的結果reader

位置：`packages/subagent/src/task/registry.ts:253`；相關`packages/session-executor/src/lifecycle/task-result-retention.ts:61`及assembly接線。

這是原WIP已存在、此次宣稱收束reader時仍未解決的缺口。新的`Boolean(resultOwner)`判斷仍會接受一個沒有ContextOutput service的`createTaskResultRetention` adapter；該物件存在，但read實際拋出`Task result owner unavailable`。設定載入失敗／不支援的持久化組合可達此路徑，並非必須偽造第三方adapter。

本項已追到實際composition與reader程式，**本輪沒有另外跑runtime反例**。下一輪須用真正factory、缺少service及正常service兩個控制驗證實際read capability。保留原v2 descriptor／revision，且不可把當前ACL拒絕誤改成原資料不存在。

## 證據問題

### E1 — 完整套件比較混入了不同source，不能用來宣稱沒有新增回歸

原report表示candidate的source變動僅來自scratch files。獨立重算其before/after manifests發現，除4個新scratch JSON以外，**8個產品檔＋1個測試檔**全由candidate內容換成handoff內容。已分別比對Git blobs及CRLF版本，排除了單純換行差異。

香港時間2026-10-19：

| run | 開始 | 結束 | cwd |
| --- | --- | --- | --- |
| candidate完整session-executor |07:46:31.393 |07:51:28.433 |同一`packages/session-executor` |
| handoff baseline完整session-executor |07:50:23.548 |07:54:37.019 |同一`packages/session-executor` |

兩次執行重疊約**64.9秒**。因此65 vs67個失敗、失敗檔案集合相同等資料不能建立固定candidate的回歸結論；不能由此斷言所有差異都是既有flaky問題。保留原紀錄，另在隔離baseline與固定candidate上順序重跑，完整記錄各自source和實際imports。

### E2 — 新背景fixture是9 bytes，沒有證明1MiB背景流程

`retained-background-exec.test.ts`輸出`A + NUL + emoji`共6個stdout bytes，另有`ff 00 7f`共3個stderr bytes，總計**9個raw bytes**。report多處稱為「1MiB級」並不符合fixture。

另有2MiB的既有`managed-frames`測試，但那是不同的foreground流程與stub retention port。兩種證據不得互換；需修正report，或另外實際補上獨立1MiB背景控制。

## 本輪獨立驗證

所有新測試依序在固定HEAD執行，前後**2571個tracked inputs一致**；反例另記錄probe／config／runner雜湊。

| 控制 | 結果 | 範圍 |
| --- | --- | --- |
| submitted-subagent-focused |7 passed |原交付的retained task negative/cold/body |
| submitted-executor-focused |9 passed |原交付的state negative、background、exec及hook recovery |
| current-executor-types |exit0 |session-executor `tsc --noEmit` |
| task-roundtrip-probe-v2 |2 failed |F1真實第二次cold restore |
| background-catalog-probe-v2 |1 failed |F2實際shipping job_output缺catalog |
| background-retry-probe-v2 |1 failed |F3原unknown settlement無法經API再次處理 |

頭兩次probe嘗試因審查目錄缺少workspace alias，在collection前失敗，沒有行為結論；改成實際package public source entry後的v2執行才是上述反例。沒有修改產品／原測試或降低斷言。

另外重算：**53個closed evidence檔案、4587個最終manifest檔案、8個Gateway copy及CLI bundle hash均一致**，0項內容雜湊錯誤。這不消除E1：紀錄完整保存了source在測試中被切換的事實。53檔seal僅涵蓋logs，不涵蓋所有build腳本、final manifest與copy map；8檔相等及bundle hash也不等於packaged real-entry已驗證。

Root最初stdio驗證腳本誤刪stderr最後一個newline，造成假hash mismatch；修正解析後全部stdio hash吻合。初始報告保留，採用`root-delivery-evidence-verification-v2.json`；沒有改動外部日誌。

## 未完成範圍與下一步

- A3 Code Mode emitted output仍未實作；A4/A5的MCP、media、search/export、fresh-host crash cuts等未完。
- 最後source的100MiB／100-child與packaged Gateway/CLI實際流程未資格化。
- reachability尚有6項unused-export；原renderer問題及全會話R6工作仍未完成。
- S25／CX2僅有結構對照，沒有因此接受原完整責任；原拆分數維持27/43。

先執行[下一輪修正計劃](../superpowers/plans/2026-10-19-context-r4a-external-fix-round1.md)，處理F1–F4及E1/E2後交回Codex。產品仍停在原提交；本輪只保存審查、反例與計劃，不代替外部agent實作。

本機完整review與raw logs：`.superpowers/sdd/2026-10-19-context-r4a-external-review/`。可攜反例及精簡證據見[審查附件](context-r4a-external-review-20261019/README.md)。本輪不是整個原R4A範圍的通過證明。
