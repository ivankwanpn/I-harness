# R4A External Delivery Fix Round 1 Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` task by task. The user-selected implementer is **deepseek-flash-1017**; Codex reviews the delivery. One product writer, no recursive delegation. Do not merge, tag, release or start R4B.

**Goal:** 修正本次A1／A2的3個已重現回歸、unsupported-reader缺口，以及失效的測試比較，交回可重現的修正包。

**Architecture:** 保留Task與state/job各自的closed schema；原exec capture負責被動保存，真正結果observer負責自身dependency註冊；in-flight coalescing與已知terminal狀態分開，unknown仍由原操作恢復。所有工作沿現有owner與source，沒有第二份結果store或重試權威。

**Tech Stack:** 現有TypeScript／Node24.15.0／Vitest／JSONL／exec與ContextOutput。

**Spec:** [本輪驗收報告](../../research/2026-10-19-context-r4a-external-acceptance.md)、[原R4A契約](2026-10-18-context-engine-r4a-retained-results.md)、[R4A收尾計劃](2026-10-19-context-engine-r4a-completion-handoff.md)。本輪完成不等於原A3–A6完成。

## Global Constraints

- 審查產品HEAD：`41e97ecb80149bfe99bb7151c3bd5a0b7c11a9e7`；外部增量BASE：`f362c6387a40fbb8d4a0e60184c3040e9f01d5fb`；full R4A BASE：`91d8fef04253272a437c68f5f2f84a657fa53d3b`。
- 接手最新分支，保留審查文件commit；不得回退／覆蓋現有工作。不再一邊跑測試一邊把同一checkout切回baseline。
- 原R4A A1–A10與DEP/HOST/PIN/COLD/HOOK規則保持有效。startup不等EOF；完整結果先保存確認再發布引用；unknown不是absence；process/body/getter/hook/guest不重播。
- 原execution outcome、retention outcome及reader availability分開。不可把保存未知變成執行失敗，也不可把wrapper物件存在變成durable讀取證明。
- 確定的storage-refused/quota unavailable與仍可reconcile的unknown分開；不增加無界重試、輪詢、背景timer或新的retry budget。
- 測試、fixture、source manifest、原始失敗與review probes保存為新紀錄；不覆寫原53檔evidence或把混合source結果重新命名為有效baseline。
- 產品檔依責任維持小模組；不擴展其他拆分或重寫已接受R0–R3。版本維持`0.1.13-rc.1`，拆分計數仍27/43。

## 起點與反例

本機原始probe及runner：`.superpowers/sdd/2026-10-19-context-r4a-external-review/`。Git內有[等位元組反例副本](../../research/context-r4a-external-review-20261019/README.md)，可在別台電腦還原到相同三層深度的獨立review目錄；不要把副本當成已跑過的新source證據。

這次先重現下列確定的RED，再把相同情境加入實際package tests：

```powershell
Set-Location 'D:/I-harness-main'
$r4aNode = 'C:/Program Files/nodejs/node.exe'
$r4aReview = 'D:/I-harness-main/.superpowers/sdd/2026-10-19-context-r4a-external-review'
& $r4aNode 'node_modules/vitest/vitest.mjs' run --root $r4aReview --config "$r4aReview/vitest.config.ts" task-roundtrip.probe.test.ts --maxWorkers=1 --minWorkers=1
# Then run background-catalog.probe.test.ts and background-retry.probe.test.ts,
# one at a time, with the same root/config. Preserve separate raw logs.
```

預期：task roundtrip兩個真實cases失敗；catalog與retry各一個失敗。collection/import failure是setup問題，不是有效RED。

## F1：修正Task publication的domain schema

**Files:** `packages/subagent/src/task/{validation,publication,types}.ts`、`packages/subagent/src/result-publication.ts`；`packages/subagent/test/retained-task-{cold,negative}.test.ts`。

**Interfaces:** 消費真正`TaskRecord.savedObservation`及Task status/outcome；產出接受自己合法持久化資料的closed Task validator。State/job繼續使用自己的domain，僅共用確實相同的ref/execution基本驗證。

- [ ] 在實際coordinator/store/registry fixture重現首次restore→save→第二次restore；分別使用原parent F1 committed與unqualified。保留目前`outcome`欄位造成的真正RED。
- [ ] 讓Task層驗證其實際持久化的`status/outcome/execution`契約。禁止刪掉原outcome來遷就state validator，或放行任意extra key／任意status。
- [ ] 加入completed/error/cancelled及需要savedObservation的recovery狀態；非法outcome、future publication、缺required欄位、literal1帶v2 descriptor仍拒絕。
- [ ] 核對第二次載入保持相同task/revision/ref與原saved observation，無新job/status、subagent/end、模型或工具；修正後原probe及實際package控制都必須通過。
- [ ] 聚焦tests／subagent types通過後提交完整F1修正，記錄before/after source。

既有真實fixture中的關鍵oracle：

```ts
const savedAgain = await coordinator.getDocument(taskDocKey('parent')) as TaskProtocolDocument;
const nextCold = createTaskRegistry({ coordinator, stateId: 'parent', results,
  reportPolicy: SHIPPING_REPORT_POLICY });
expect(() => nextCold.restore(savedAgain)).not.toThrow();
// In the committed/unqualified cases, assert the original task/revision/ref,
// savedObservation.outcome and original fact counts separately.
```

變數及完整setup直接來自附上的actual probe；不要用只回expected的fake validator取代實際restore。

## F2：分離原capture保存與真實observer註冊

**Files:** `packages/exec/src/{capture/frames,jobs/records,jobs/observation,jobs/views}.ts`、`packages/session-executor/src/lifecycle/{exec-result-retention,result-dependencies,result-retention}.ts`、`packages/subagent/src/tools/status.ts`；`packages/session-executor/test/retained-background-exec.test.ts`及新的query依賴控制。

**Interfaces:** 消費原`ExecFrameCapture.settle()`、`ExecResultRetention.observe()`、真正`ToolExec`與`registerToolResultDependency`。產出同一original frame artifact和每個合法observer自己的dependency handle／F1 catalog；不增加資料store。

- [ ] 使用actual assembly／pwsh，讓startup已返回後才解除EOF gate；等automatic artifact出現，再於第二個真正Agent回合呼叫shipping `job_output`。目前缺catalog必須可重現。
- [ ] 自動結算只依原capture/source進行；它不能冒充已finalize的startup觀測。原capture已有`settle()`能力，不應要求稍後有query才能保存。
- [ ] 真正query／completion observer在其有效prepared ToolExec內註冊同一來源。保存coalescing不能跳過新的observer registration；依實際target/current ACL取得必要grant/pin，不固定使用startup target取代現在的observer。
- [ ] F1中的正式`job_output` ResultEnvelope必須含原frame來源catalog，後續cold頁可依它取得同一完整內容。不能只在內部live view加`retained`，也不能把payload長得像ref就視為授權。
- [ ] 加入兩次查詢、授權的不同scope觀測、撤銷／偽造scope零body I/O。Startup繼續不等EOF；execution launch、原capture與完整內容hash不變。
- [ ] 原實際probe與affected exec/executor tests通過後提交。

正式consumer oracle：

```ts
// readerEnd is the actual committed tool/result for shipping job_output.
expect(readerEnd.envelope.dependencies).toMatchObject({ kind: 'artifact-set', count: 1 });
// Read the actual catalog with the actual authorized owner, verify its sourceId
// equals the original native source and its frame ref equals automatic retention.
// A ref merely copied into tool args or a live BackgroundJobView is not this proof.
```

這個片段須接在actual tool/result的型別guard後；仍採用原plain-value與envelope的closed union，不用`as any`掩蓋錯誤形狀。

## F3：unknown settlement保留恢復入口

**Files:** `packages/exec/src/jobs/{contracts,records}.ts`、`packages/output-retention/src/result/exec-frames.ts`及原executor source接線（只在反例需要時）；`packages/exec/test/managed-frames.test.ts`及actual background recovery控制。

**Interfaces:** 沿同一capture的既有write cursor／`settle`。只合併同時進行的Promise，確定terminal結果才可永久快取；unknown／rejection不變成已完成void狀態。

- [ ] 跑actual exec service＋controlled backend＋真實`createExecFrameCapture`反例。第一次finish unknown，第二次同一原操作可前進；query/list/dispose的observe/settle不能永久停在1次。
- [ ] 在原owner明確分開pending in-flight、known terminal、recovery-required。舊promise結束只能清理自己，不能刪掉較新的in-flight handle；並發query共用當前一次settlement。
- [ ] original operation/write offset/receipt key與必要source仍保留。禁止重新begin、重寫完整body、再launch process、從stage檔案存在猜成功。
- [ ] 加入一次unknown→已知拒絕、一次unknown→真正artifact ready、持續unknown與throw→reconcile。已知quota拒絕不當成無限可重試；持續unknown的dispose要如實保持／回報recovery-required，不可假稱required settlement完成。
- [ ] 與Stop/close/current-source revoke控制連接，確保沒有new transport／tool／guest，並區分execution已結束和retention仍待確認。
- [ ] F2/F3聯合tests及types通過後提交；不要只靠一個mock observe counter宣稱磁碟故障恢復已驗證。

實際capture狀態可直接用現有型別：

```ts
type FrameSettlement = Awaited<ReturnType<ExecFrameCapture['settle']>>;
// A recovery-required result keeps the original capture retriable.
// ready/unavailable/storage-refused is a known terminal disposition,
// distinct from ready/artifact and from an uncertain write/finish.
```

本輪review的直接retry控制得到的是known storage-refused，不是artifact成功；下一輪兩種分支都須測。

## F4：以真實reader capability判斷可讀性

**Files:** `packages/subagent/src/task/registry.ts`、TaskResultStore契約、`packages/session-executor/src/lifecycle/{task-result-retention,result-store}.ts`及assembly薄接線；實際retained task/executor tests。

**Interfaces:** 真正service/reader capability與原result descriptor分開。當前ACL拒絕、service unavailable、原資料retained是不同事實。

- [ ] 用真正`createTaskResultRetention` factory構成有wrapper但沒有ContextOutput service的情況；不能只用省略`results`的fixture。檢查cold restore/resave/read與正常service的控制組。
- [ ] 由composition傳遞真實可讀能力，或在沒有reader時不宣稱其存在；禁止`Boolean(adapter)`作durable-read證明。保留v2、原revision/ref與execution observation。
- [ ] 加入設定載入失敗／unsupported backend的實際接線控制，確認明確unavailable；有service但ACL被撤銷仍按原授權拒絕，不刪descriptor、不授新grant。
- [ ] 聚焦schema/reader tests、affected types與本輪反例通過後提交。

此項原review只有source tracing；下一輪必須提供真正RED/GREEN，不把它說成已由本輪runtime測過。

## F5：修正證據與固定source回歸驗證

**Files:** 新的獨立evidence目錄、`docs/research/context-r4a-external-delivery.md`的明確更正段落、新fix交付報告；不覆寫原mixed-source logs。

- [ ] 更正原report的兩處不實範圍：完整套件測試source變動含8產品檔＋1測試檔；實際新背景fixture是9raw bytes，沒有1MiB證明。保留舊結論作帶日期的更正，不改舊receipts。
- [ ] 在產品不再變動的固定commit上執行candidate驗證。若要比較handoff BASE `f362c638`，使用隔離目錄／worktree，記錄其Git blobs、依賴與真實workspace import targets；不得把baseline workspace依賴連回正在修改的candidate。
- [ ] baseline與candidate按順序執行，同一時段只跑一套；每次前後比對maintained product/test hashes。忽略scratch僅能作用於明確的測試產物路徑，不能忽略`src`／真正test檔。任一source漂移則該次不作qualification。
- [ ] 對每個差異保留test名、原始錯誤與因果證據；失敗檔案集合一樣／失敗數較少都不能直接推出沒有新增回歸。單獨通過不能抹掉原cleanup失敗。
- [ ] 重跑本輪三個review probes、submitted focused範圍、affected types與normal reachability。6個unused-export仍明列；不能新增豁免或假consumer。若補1MiB背景控制，從literal bytes及實際background route獨立驗證，不借foreground stub結果。
- [ ] 最後必要的Gateway／CLI新copies與source/import map按原A6要求保留。Build成功與真實packaged行為分開；未跑的流程仍寫未跑。
- [ ] 交回full BASE..HEAD與本輪incremental range、每個F/E的對應證據、未完成A3–A6及所有程序cleanup狀態，標記UNACCEPTED，停止產品實作等待Codex複驗。

## 本輪交付檢查表

| ID | 必須交付 |
| --- | --- |
| F1 |真實restore/save/restore committed與unqualified＋domain statuses，closed負例仍拒絕 |
| F2 |automatic保存＋startup不等EOF＋正式query catalog＋合法scope及cold內容一致 |
| F3 |unknown可透過原source恢復，並發coalescing、known refusal、真正artifact ready、持續unknown/Stop/dispose |
| F4 |真正factory無service／正常service／ACL拒絕的reader能力區分 |
| E1/E2 |source隔離與序列baseline證據、更正9bytes與不成立的回歸結論 |

完成本輪後仍不是R4A整批接受；A3–A6照原清單繼續保留。Codex複驗修正通過後，才安排下一段實作，不直接進R4B或發佈。
