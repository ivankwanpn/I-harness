# ADR-2026-11-05：以單一 commit log 取代分階段出生（session durability core 重寫）

- **狀態**：提議（待 root 核可）
- **取代**：`2026-11-05-birth-decision-redesign.md` 的方案 A/B（該文件保留為研究記錄）
- **範圍**：`packages/session-persistence`（11,883 行）＋`packages/session-persistence-jsonl`（3,657 行）＝15,540 行，與 12 個套件（含自身與 jsonl backend）的 coordinator 呼叫面
- **判準**：產品穩定性、功能完整性、設計合理程度（不計開發量）

---

## 1. 裁定

**重寫耐久核心，而不是修補出生狀態機。**

現行架構把一次出生拆成多個耐久物（`.stage`／capture reservation／header／`task-*.doc.jsonl`／seed／completion），
每一步都要一個語義去覆蓋「已發行但未知」的組合，於是長出 9,402 行的 coordinator 狀態機、
45 個 `blocked()` 出口與 adoption／mode／recovery-required 的補丁鏈。40 筆紅測試是這套狀態機的影子，不是個別 bug。

六個參考專案（DSH 0.2.2、codex 0.166、opencode 2.1.4、pi-durable 1.2、ZCode、superagent prototype）**沒有任何一個**用分階段出生；
它們一致採用：

1. 一次變更＝**一個 commit 點**（append／marker／交易）；
2. **延遲物化**：沒有內容就不落地，物化前 crash ＝ 不存在；
3. 耐久意圖與被保護狀態**同域**（或根本沒有耐久意圖）；
4. 恢復在 **open** 決定（fold log），不在行程內用 `blocked`／adopt 猜；
5. 所有權是**租約／鎖**，不是 adoption 記錄。

因此採用 **Session Commit Log（SCL）**：每個 session 一條 append-only commit log + content-addressed sidecars + flock 租約 + handle API。
**這一改動同時滿足 BC01 的實質要求**（capture 前必須有耐久意圖）：意圖改為 log 內的 `intent` 記錄，仍先於 capture 持久化，
但不再需要獨立的 `.stage`／reservation 檔案。改變的是機制，不是不變量。

---

## 2. 為什麼不是只做語義修正（方案 A）

方案 A（decision/debt 分離 + resume 完成）能讓多數紅測試轉綠，但留下：

- 兩份耐久物（session + task doc）→ 每次 task doc 失敗都要一條「projection 不擋 birth」的例外規則；
- 多階段 artifact（stage/header/promote/capture）→ 每一種 crash 位置都需要一個可判定狀態；
- in-process adoption/blocked → 跨程序（desktop + CLI）沒有單一事實來源；
- 45 個 blocked 出口仍存在，只是 reason 更細。

以穩定性而言，方案 A 是「把不可判定的組合逐一列舉」，SCL 是「讓組合不存在」。後者才是結構解。

---

## 3. 目標架構

### 3.1 磁碟佈局（per-session directory，format 15）

```
<root>/
  <escaped-id>/
    session.v15.jsonl          # commit log（當前 generation）
    session.v14.jsonl          # 保留的舊 generation（若有）
    side/<sha256>              # content-addressed sidecars：task document 快照、selected results、大型 artifact
    <id>.lock                  # flock；檔案存在與否不重要，鎖隨 fd 釋放
```

- 舊 generation 的位元組**永不改寫**（DSH 的 immutable generations）；升級＝讀舊、寫新 generation。
- sidecar 是內容尋址；未被任何 commit 引用者，在 open 時回收。

### 3.2 Commit 記錄（單行 JSON）

```jsonc
{
  "v": 15, "seq": 7, "prev": "<sha256 of previous commit line>",
  "at": "2026-11-05T...", "op": "commit",
  "entries": [/* SessionEvent[]，維持現有 event schema */],
  "ops": [
    { "kind": "meta",   "patch": { "title": "..." } },
    { "kind": "doc",    "side": { "digest": "sha256:...", "bytes": 1234 } },
    { "kind": "intent", "id": "op-1", "intent": { "kind": "child-birth", "childId": "...", "payloadDigest": "..." } },
    { "kind": "intent-done", "id": "op-1" },
    { "kind": "rewind", "toSeq": 4 },
    { "kind": "delete" }
  ]
}
```

- `seq` 嚴格遞增、`prev` 串鏈（完整性＋排序；不需要 fact receipt 機制）。
- **一個 commit 行就是唯一承諾點**：行完整 parse 且 digest 對得上＝已承諾；否則整行丟棄（torn tail）。
- sidecar 先寫＋fsync，commit 行最後 append；沒有 commit 引用的 sidecar 一律視為垃圾。

### 3.3 出生（birth）

1. `create(header)` 只建立**行程內未發佈**的 session（回傳 write handle）。
2. 第一次 `commit`：把 header 與初始 entries／ops 寫入同目錄 temp（`<id>.<rand>.tmp`）→ fsync →
   `link(tmp, session.v15.jsonl)`（**no-overwrite**，EEXIST 即衝突）→ fsync 目錄 → unlink temp。
3. crash 在 link 前：temp 是垃圾，session **不存在**；在 link 後：session 完整存在。
   沒有「已發行 header 但 seed 未寫」這一態。

### 3.4 所有權

- 每個 session 一把 flock（`<id>.lock`）；取鎖成功＝唯一寫者；行程死亡自動釋放。
- 啟動時清理 stale lock 檔（能取得鎖就刪檔，codex 模式）。
- 讀取不需要寫鎖；只讀完整 commit 行，永遠看到合法前綴。

### 3.5 恢復（open）

1. 選最高 generation；讀 header＋所有完整 commit 行；torn tail 丟棄（可選：截斷）。
2. 驗證 `seq` 遞增與 `prev` 鏈；不合法＝corrupt（大聲拒絕，不猜）。
3. fold：entries 可見前綴、meta 最新值、doc 最新 sidecar、intent 未完成集合、deleted 標記。
4. 回收未被引用的 sidecar。
5. **沒有 blocked／adoption**：要嘛 fold 出合法 session，要嘛拒絕。

### 3.6 跨 session 工作（取代 capture reservation）

- 父 session 的 commit 可包含 `intent{childId, operationId, payloadDigest}`（**先於**任何 capture／模型準備）。
- 子 session 的第一個 commit 記錄 `birth.operationId`。
- 同一 operationId 重試＝no-op；不同 operationId 且 intent 仍 open＝拒絕。
- 父 resume 時把 open intent 交給呼叫端完成；子 log 已存在則只驗證 digest 並標記 done。
- 這保留 BC01–BC11 的**不變量**（presence/uncertainty 不給第二次 capture），但意圖與狀態同域。

### 3.7 fork

- `fork(parent, cut)`＝建立 child，第一個 commit 是 `seed{parent, cut, digest}` ＋複製的前綴 entries。
- 檔案一次出現（link 發佈），S-08 的 `.publishing` marker 不再需要；`list()` 只看得到完整檔案。

### 3.8 rewind／compaction／deletion

- rewind：append `{kind:'rewind', toSeq}`；fold 時隱藏其後 entries。物理壓縮是維護操作，寫新的 generation（`fold` commit），舊檔保留。
- compaction：append `{kind:'compact', baseSeq, summaryRef}`；fold 以 summary 取代前綴。
- deletion：append `{kind:'delete'}` → 移除檔案與 sidecars；crash 留在 delete 標記的 log，`list()` 隱藏並可重試。

### 3.9 API 表面（facade）

保留 `SessionCoordinator` 的對外方法（create／open／resume／append／fork／list／snapshot／updateMeta／close…），
由 SCL 實作；刪除 `bootstrapSemanticTarget`／`resumeSemanticTarget`／capture／inspection 系列，改為：

- `createFromSeed(request)`／`resume(invocation)`（子代理與 fork 共用）
- `beginIntent(...)`／`completeIntent(...)`

12 個消費者套件透過 facade 無感；只有直接呼叫 bootstrap API 的三處（fork-controller、subagent task-birth／team-birth）需要改接。

---

## 4. 刪除與保留

| 刪除／取代 | 行數（現況） | 取代物 |
|---|---|---|
| `coordinator/bootstrap.ts` | 985 | `createFromSeed`／SCL birth |
| `coordinator/task-document-transition.ts` | 425 | intent ops + projection |
| `coordinator/managed-document.ts` | 933 | 純 fold／projection（~200） |
| `coordinator/managed-documents.ts` | 262 | session registry + projection（~100） |
| `coordinator/binding-observation.ts` | 815 | handle + lease |
| `coordinator/ownership.ts` | 602 | flock lease（~150） |
| `coordinator/retained-*`、`process-read-*`、`fact-*`、`task-document-operation` 等（粗估） | ~1,800 | 不再需要 |
| jsonl `backend/bootstrap-{header,stage,capture}*`、`document-write`、`task-document-observation` | ~1,800 | log writer + sidecar writer |
| **主要刪除項合計** | **~7,600** | 加上保留的 event schema／舊格式 reader／facade，整體 **15,540 → ~6,000** |

保留：`core-session` 的 event schema、conversation projection、UI／desktop、tools、sandbox、agent loop。`SessionCoordinator` 形狀保留為 facade。

---

## 5. 遷移（format 15）

1. **讀**：新 reader 支援 13／14 舊 generation（fold 舊 header＋journal＋`task-*.doc.jsonl`），輸出與現行 coordinator 相同的 session view。
2. **寫**：對舊 session 的第一次變更＝寫新 generation（`session.v15.jsonl`），舊檔位元組不動；之後只寫新檔。
3. **驗證**：golden corpus（現有 14 格式會話）dual-run：舊 coordinator 與新 fold 的 events／meta／task doc 必須完全相同；差異即 blocker。
4. **切換**：先只讀（SCL 讀、舊寫），再寫入切換，最後刪除舊 coordinator；feature flag 可按 session 逐步。
5. **回滾**：新檔是額外 generation，舊檔未被改寫，回滾＝忽略新 generation（但已寫入的新資料需人工合併，僅限災難）。

---

## 6. 驗證策略與現況（2026-11-06）

| # | 項目 | 狀態 | 證據 |
|---|---|---|---|
| 1 | **crash-cut 矩陣**：temp 寫入、fsync、link、目錄 fsync、sidecar 寫入、commit append 各步注入中止；重開只允許「不存在」或「恰好該 commit 前綴」 | ✅ | `session-commit-log/test/crash.test.ts`（5 案例，含 link 前後、sidecar 與 append 中斷）＋ `store.test.ts` |
| 2 | **fold 性質測試**：任意 commit 序列 → fold(log) == 記憶體模型；重開冪等；torn tail 任意截斷點得到合法前綴 | ✅ | `fold-property.test.ts`（5 seed × 25 commits，全部 op）＋ `scanner.test.ts`（torn tail／seq／prev）|
| 3 | **舊格式 corpus**：format 8/11/13/14 可讀；14 的 task doc 可重建 | ⚠️ 部分（8/11 需 journal metadata） | `commit-dual-run-corpus.test.ts` 以 8 個 legacy session 與 legacy coordinator 逐項比對（events／meta／task doc）。6–12 格式的檔案必須帶有效 `journal` metadata（fact journal），本 branch 沒有產生它們的 writer 或錄製樣本；邊界已測：缺 journal 的舊檔會把 legacy 的 `invalid session journal metadata` 原樣拋出，只有真正不存在的 session 才是 `CommitLogNotFoundError` |
| 4 | **既有回歸**：jsonl、session-persistence、subagent、agent-team、desktop-gateway、sdk e2e | ⚠️ 部分 | SCL 相關套件全綠（**host 35 檔／40 tests**、store 9 檔／38 tests、commit 系列 43 tests）；legacy `session-persistence` 仍有既有失敗（transition gate／artifact latch／win32 lock），與 SCL 無關，見計畫 Plan 38–39 |
| 5 | **多程序**：兩行程同開一 session，只有一個取得寫鎖；死鎖／重啟後可恢復 | ✅ | `multiprocess-lock.test.ts`：子程序持鎖時父程序被拒；kill 後父程序接管、append、新讀取可見 |

---

## 7. 風險與緩解

| 風險 | 影響 | 緩解 |
|---|---|---|
| 重寫期間的行為漂移 | 高 | facade + dual-run golden corpus + feature flag |
| 失去 fact receipt 的所有權證明 | 中 | `prev` 鏈＋flock＋commit 內 owner／incarnation 欄位；audit 對照表逐項確認 |
| 舊格式 fold 不完整 | 高 | 先用唯讀模式跑完整舊 corpus；任何差異阻擋切換 |
| desktop 直接依賴檔案佈局 | 中 | 保留 `<id>.jsonl` 相容投影或一次性遷移腳本；先在 desktop 讀取層加抽象 |
| BC01–BC11 的核准語義被誤解為放寬 | 中 | 在規格中明示：intent op 仍先於 capture 持久化，invariant 不變 |
| 重寫引入新 bug | 高 | crash matrix＋property tests＋分階段切換，不一次性刪除舊路徑 |

---

## 8. 待核可的決策

| # | 決策 | 建議 |
|---|---|---|
| D1 | 是否採用 SCL（單一 commit log）取代現行 coordinator | **是** |
| D2 | sidecar 佈局（per-session `side/<digest>`）與 64 MiB 上限沿用 | 是 |
| D3 | BC01 的機制改為 log 內 intent（不變量不變） | 是 |
| D4 | format 15 的 generation 遷移（讀舊寫新、舊檔不改寫） | 是 |
| D5 | 切換順序：唯讀 dual-run → 寫入切換 → 刪除舊路徑 | 是 |

---

## 8. 遷移進度（2026-11-06 實作快照）

| 步驟 | 狀態 | 證據 |
|---|---|---|
| 1. 讀（13／14 reader、task doc） | ✅ | commit-coordinator.test.ts（legacy read＋首寫遷移）、commit-dual-run-corpus.test.ts（events／documents／meta 完全一致） |
| 2. 寫（首寫產生新 generation，舊位元組不動） | ✅ | 同上；legacy 檔位元組以 readFile 比對不變 |
| 3. 驗證（golden corpus dual-run） | ✅ | 8 種 session（空／訊息／internal／turn／tools／steps／delivery／兩輪＋title） |
| 4. 切換（read-only → write → 刪除舊路徑） | 進行中 | gateway／CLI 以 IH_SESSION_STORE=commit-log 選用 SCL；legacy 仍是預設 |
| 5. 回滾（忽略新 generation） | ✅ | 舊檔從未改寫 |

切換前尚待補齊：

- **selected results**：SCL 回報 SELECTED_RESULTS_UNSUPPORTED（gateway 已 guard），需移植或接受功能降級；
- inspectChildBootstrap：caller 有 guard，尚未提供；
- compaction：SCL 已可完整執行（長歷史 E2E 通過），僅測試 fixture 的摘要長度需注意；
- legacy 刪除（~7,600 行）：需在預設切換後進行，並以本文件的 corpus gate 為前置。

SCL 已在真實 host 驗證的產品面：session 建立／列表／改名／封存／還原／刪除、prompt turn、模型切換、fork（含 nested、**fork child 續用**：
child 可跑 turn、記錄自己的 rewind point、管理 schedule）、rewind（含 files 模式、fingerprint 失效、跨 host、turn 後、fork 後）、
schedule CRUD（含 fork child）、execution surface（訂閱／snapshot／changed 通知）、project bind／move（含 batch 與 owner guard）、
approval rules state、auto title 文件、execution／tasks／processes 讀取、todo 冷／live 寫入與 reconcile、session search（含混合 store、
subtree、lineage、context picker）、compaction、CLI run＋sessions、重啟耐久（session／metadata／schedule／batch move）。

### 8.1 決策（2026-11-06）：selected results 與最終切換

selected results 是唯一仍獨占 legacy coordinator 的功能：其 capture／witness 建立在 `createDocuments(...).observations`
（`acquireSelectedBindingRead`、cold finalization、保留式 lease）之上，並透過 `createSelectedRuntimeCapture` 建立子 session；
SCL 的 fork capture 走不同路徑，兩者無法只靠 facade 銜接。

依照「產品穩定性、功能完整性優先、開發工作量不計」的原則，本計畫的處置是：

1. **維持 legacy coordinator 為預設**，SCL 以 `IH_SESSION_STORE=commit-log` opt-in；
2. **不刪除 legacy**，直到 selected-results 移植完成；刪除階段的 gate 因此未達成；
3. selected-results 移植列為後續大型工作（需要 SCL 版的 documents／observations selected 路徑），不在本輪承諾；
4. SCL 的所有已驗證產品面（turn、fork、rewind、schedule、surface、management、project、title、compaction、tool/artifact、
   CLI）維持綠燈並持續回歸驗證。

這個決策讓「功能完整性」優先於「刪除 legacy 的程式碼縮減」；若之後接受在 SCL 模式失去 selected results，再啟動刪除階段。

### 8.2 selected results 的移植分析（2026-11-06）

**legacy 現在做什麼**：`selectedSourceFor(coordinator)` 提供 `acquire`／`retainTask`／`retainManagedTask`，全部建立在
`createDocuments(...).observations` 之上（`acquireSelectedBindingRead`、cold finalization、retained lease、result lineage
witness）；fork capture 走 `createSelectedRuntimeCapture`，內含 reservation → cold/warm finalization → witness 的協議。
SCL 的 fork capture 是另一條路（`bootstrapSemanticTargetWithCapture`），兩者無法只靠 facade 拼接。

**移植會牽涉什麼**：把 `createDocuments` 的 selected 路徑（binding observations、cold routes、finalization tickets、
revocation admission）重寫到 SCL 的 retained binding 上；這是 legacy coordinator 最複雜的一層，估計是數千行的等價邏輯，
且必須重做 crash-cut 與 lineage 測試。

**可行的替代方案（snapshot selection）**：fork 當下用既有的 context-output 服務讀出被選取的 result pages（SCL 已驗證可讀），
把它們以一般事件／artifact 內嵌到子 session 的 seed。語意差異：

- 選取結果是**fork 當下的快照**，不具跨 session 的 lineage／撤銷見證；
- 沒有 reservation／finalization 協議，crash 安全由 SCL 的單一 commit 提供；
- UI 上「selected results」仍可用，但 `assertResultLineage` 類的嚴格語意不再成立。

**範圍釐清（2026-11-06）**：這條路只在 **帶 selected results 的捕獲** 上才會被觸發——fork／child 的 core 會多一個
`results: "selected-results-v1"` 標記（`readSelectedResultsCore`），gateway 需要 `selectedSourceFor` +
`createSelectedRuntimeCapture`（`context-runtime.ts` 的 `selectedComposer`，僅在 legacy store 上成立）。一般 fork（v1 core）、
不帶 selected results 的 task child、`session/result/read` 的頁面讀取、以及 context output 都不受影響（皆已在 SCL 驗證）。
因此 §8.1 的「功能不完整」只限於 selected-results 繼承，不是整個結果讀取面。

**可行性補充（2026-11-06，B2 的具體入口）**：core-session 的 `heldSource()`（`test/selected-results-codec.test.ts`）只用了
`createManagedSessionState(Session, {sessionId})` ＋ 一個 `FactOwner` ＋ `createCompletedPassiveContext(owner, {kind:'completed'})` ＋
`{assertCurrent, legacy()}`，就能呼叫 `exportSelectedResultsConversationSeed(context, inherited)` 產出 v3 seed。SCL 已有能力提供
前兩者所需的 `Session`（`coordinator.snapshot()`），因此 B2 的最小路徑是：

1. 以 SCL snapshot 建立 `Session`；
2. 以 `createManagedSessionState` ＋ 最小 `FactOwner` 建 owner；
3. 以 `createCompletedPassiveContext` 建 context；
4. `inherited` 以 SCL 的 result pages 讀取（`session/result/read` 已驗證）實作 `legacy()` 迭代；
5. 呼叫 `exportSelectedResultsConversationSeed`，把結果放進 `seed` commit。

未知數只剩 (4) 的 held pages 與其 currency 檢查；這是可先以單元測試驗證的範圍，不需要移植 legacy 的 `createDocuments(...).observations`。

**更精確的資料流（2026-11-06 追蹤）**：selected results 的最終出口是 `exportSelectedResultsConversationSeed(context, inherited)`，
它需要 `CompletedPassiveContext`（restored owner）、`HeldInheritedResultMetadata`、`projectSelectedResults` 與可逐頁迭代且帶
currency 檢查的 `HeldResultPages`，輸出 `SemanticSeedV3Public`（v3 seed 協議）。換句話說，「snapshot」省掉的只是 legacy 的
reservation／witness 層，**v3 seed 的產生器仍然要存在**。

因此替代方案要再分成兩種：

- **B1（不進 v3 協議）**：fork 當下把選取結果以一般 context 事件寫進子會話（例如 `context/selected-result` 一類事件或 artifact
  引用）。最簡單、可立刻在 SCL 實作；代價是子會話的 UI 不會有「inherited results」的標記與 lineage。
- **B2（v3 seed 但自建 held 物件）**：在 SCL 上實作 `HeldInheritedResultMetadata`／`HeldResultPages` 的等價物（綁定 fold 與
  artifact store，帶 prefix 檢查），仍可輸出 v3 seed；工作量中等，但能保留子會話的 inherited 標記。

**建議**：若產品要的是「能帶著選取結果開子會話」，先做 snapshot selection（B），把語意寫清楚；只有當「子會話必須持續
見證父結果的撤銷與 lineage」是硬需求時，才投入完整移植（A）。目前決策見 §8.1（維持 legacy 預設、SCL opt-in）。