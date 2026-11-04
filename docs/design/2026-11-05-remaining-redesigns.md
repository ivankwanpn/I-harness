# 剩餘重設計清單（2026-11-05）

這份文件只列**尚未實作、且需要跨模組設計**的四項。其他審計項目（S-01～S-07、S-09、S-10、NG 系列、A-01～A-12 的大部分、D-01 steps 1–4f、D-05、D-07）已完成並有測試／覆核記錄，見 `2026-11-04-fix-progress-checkpoint.md`。

---

## 1. S-08：fork 的原子發佈

**現狀**：fork 先在 child header 寫 reservation，再分階段 append seed／completion frame；`list()` 已排除 0-byte 半成品（`53ea918e`），但「有 header、尚未完成 seed」的 child 仍會出現在清單。

**已完成**：zero-byte 過濾 + 測試（`list-incomplete`）。

**待做**：
- 方案 A（建議）：fork 先寫入 `<id>.forking`（或 `.pending`）暫存檔，完成 seed＋bootstrap＋initial input 後 `rename` 成 `<id>.jsonl`；`list()` 自然只看得到完成品。
  - 需要 `fork-controller` 的 targetSessionId 與檔名解耦，或 backend 增加「fork 專用的 publication name」。
- 方案 B：在 header 寫入 `bootstrap.completedAt`，完成後才更新 header；`list()` 對有 `semanticSeed` 的檔案讀 header 並過濾。成本是每個 forked session 一次 header 讀取。
- 測試：在 reservation 與 seed frame 之間注入失敗，斷言 `list()` 不含半成品、重開後可 resume 或明確 rejected。

---

## 2. A-12：WSL worker 重用

**現狀**：每個 execution 重新 spawn `wsl.exe + python worker`；distribution 檢查已 per-backend 快取（`de99ee29`）。

**待做**：把 `WorkerClient` 的單一 workload 協議改成可重用：
- worker 端 loop 接受 `prepare → commit → output → settled` 多輪；
- 每個 workload 有獨立 output framing／cancel token；
- idle worker 回收與崩潰偵測；
- 保留 bounded memory 與既有 frame 驗證。

**前置**：需要一份協議版本（v2）與相容性策略；現有單一 workload 路徑保留為 fallback。測試用 fake transport 計數 spawn 次數（連續兩次 prepare 只 spawn 一次）。

---

## 3. D-01 最後一步：移除可變 task document 寫入

**現狀**：job record 雙寫、recovery 優先、document 重建、legacy fallback、owned 唯讀降級、write-behind coalescing、write intents 都已完成；task document 仍是可變寫入來源（strict／owned v3 尤其）。

**待做**：
- 讓 desktop catalog／projectTasks 改讀 job record（或 document 只作 projection，延遲寫入）；
- required settlement／v3 parent 契約改以 child session + job record 為依據；
- 移除 `TaskPersistence` 的 strict 寫入或將其降為 compaction；
- 補 e2e：document 完全缺失時，registry 仍可從 job record + child session 啟動（legacy 已可，owned 需 fallback 或明確 degraded）。

**風險**：v3 parent assertion 與 owned write ownership 是同一組 witness；需要先分離「ownership proof」與「task projection」。

---

## 4. D-12：agent-team 測試 harness 遷移

**現狀**：`ownedTeamFixture` 仍用 legacy coordinator；`acknowledgement-settlement` 等測試在 backend 建立後覆寫 `appendOwnedBatch`／`reconcileOwnedBatch`，composed backend 的 canonical-path guard 會拒絕，造成 timeout。

**已完成**：證明 composed coordinator + action wrapper 本身可正常送出 team message；`composed-team-write` 2/2 固定了邊界。

**待做**：
- backend 增加 pre-bind seam：`wrapOwnedBatch`（已有）＋`wrapOwnedReconcile`（2026-11-05 已補，含 `backend-wrap-hooks` 測試）；
- `ownedTeamFixture` 已可選 `{ composed: true, control: { append, reconcile } }`，hooks 在 backend 建立前注入（`composed-fixture-hooks` 測試）；測試改用 hook 記錄 batch／注入 unknown outcome，而不是事後覆寫 backend；
- 逐檔遷移 agent-team 測試；剩餘 `FACT_INVALID_GROUP` 需逐案確認是 fixture 前置狀態還是產品組合問題。
- **2026-11-05 進展**：`acknowledgement-settlement` 已全數遷移到 composed coordinator＋control hooks（**37/37**），fixture 的 hooks 延遲分派，可在建立後指定。其餘 agent-team 測試仍用 legacy fixture，需逐檔遷移。
- **`completion-delivery`** 已遷移（**13/13**；需要 `d72dde63` 的 admitted-input settle 修正，以及 fixture control hooks）。
- **`transact`** 已遷移（13/13；需要 `IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT` 的兩個證據測試在設定後全綠）。
- **`managed-transact`** 已遷移（1/1，unknown-outcome hook 在 backend 建立前注入）。

---

## 建議順序

1. S-08 方案 A（最小、可測試、不影響 write ownership）
2. D-01 最後一步（產品價值最高，但風險也最高）
3. D-12（純測試基礎，可分批）
4. A-12（效能，需要協議版本）

## D-12 遷移中發現的組合問題（2026-11-05）

以 composed coordinator 跑 `completion-delivery` 時，session-executor teardown 會出現 `Team cleanup incomplete → Task registry retired (TASK_REGISTRY_UNAVAILABLE)`：composed 的 task registry 比 legacy 更早 retire，而 team scheduler 的 cleanup 仍會呼叫 `jobs.kill`／`table.remove`／`table.update({closing})`。

已修：subagent 對 runtime 的 guarded facade 在 retirement／registry unavailable 時，允許上述**純 cleanup** 操作（kill 回 `already-finished`、remove 走 staged table、closing update 直通 staged table），不再讓整個 service teardown 失敗。屬於真正的組合修正（desktop 也用 composed coordinator）。

## D-12 尚未解決的產品差異：team completion 在 composed coordinator 下不喚醒 Lead

以 composed coordinator 跑 `completion-delivery` 時（teardown 修正後）：

- 13 個測試中 6 個通過，7 個失敗在「Lead 沒有收到完成通知」：`spawn_teammate` 完成後，idle Lead 的模型從未被喚醒（`seen` 為空）。
- 失敗不是 cleanup，也不是 fixture hook；通知在 composed 路徑某處被丟棄。legacy coordinator 下同一測試會喚醒 Lead。
- 需要追的路徑：`onTaskTerminalCommitted` → `parentNotify.wake`／task-notification drain → `service.wake`／assembly 的 live session 綁定。composed 的 parent session 是由 fact document 持有，live view 可能不是通知系統比對的那個 identity。

這是 desktop（composed）與 team 完成通知的**真實組合風險**，優先度高於剩餘 harness 遷移；在修正前 `completion-delivery` 維持 legacy fixture。

### 追查線索（2026-11-05，尚未修）

- `session-executor/src/service.ts:590 parentNotifyFor()` 的 `wake(sessionId)` 只在 `sessionId === id`、`assemblies.get(id) === assembly`、`owner() === assembly` 時才 signal `deliveryDrains`；任何 identity 不一致都會靜默 return。
- `admit()` 比對 `input.sessionId !== id` 與 `assembly !== owner()`；`assembly.inbox.pending()` 需含 `parent-notify-*` 的 input。
- `assembly.ts:1324 registerSubagent(... persist: { coordinator, stateId, parentSessionId })` 與 `mountAgentTeams(..., parentNotify: opts.parentNotify)` 都有接線。
- 建議的最小 probe：以 composed fixture 傳入自訂 `parentNotify`（記錄 `wake`／`admit`／`prepareTaskDelivery` 呼叫），斷言 spawn_teammate 完成後 `wake('lead')` 是否被呼叫；若沒有，往 task-notification drain／`onTaskTerminalCommitted` 查；若有，往 `deliveryDrains`／inbox admission 查。

### 根因（2026-11-05，已定位未修）

用 `IH_WAKE_DEBUG` 診斷 composed completion 流程：

1. `parentNotify.admit` 正常（identity 全對），input 進入 `assembly.inbox.pending()`。
2. `parentNotify.wake` 正常，找到對應的 `parent-notify-*` input。
3. `wake` 接著呼叫 `submit(id, input.text, …, { admittedInputId })`；submit **立即失敗**：
   `Managed facts require reconciliation (FACT_RECOVERY_REQUIRED)`（`core-session/src/managed/nondurable.ts` 的 `assertNewWork`：`recoveryHolds.size` 或 sticky state 非空）。

也就是：通知 admission 寫入的 fact group／delivery hold 尚未 reconcile，就被同一次 wake 的 submit 視為「新工作必須先恢復」。legacy coordinator 沒有這層 hold，所以同一流程可行。

**修正方向（下一步）**：在 composed 路徑上，notification admission 必須以可 settle 的方式完成（或在 submit 前 reconcile 該 input 的 hold／以 `admittedInputId` 直接採用而不觸發 assertNewWork），不能讓 notification 自己把父會話鎖成 recovery-required。

### 更深一層根因（2026-11-05）

`FactRecoveryRequiredError` 的實際 throw 位置（debug stack）：

- `managed-document.ts` 的 `settleFinishedActions()`（`pending` 未清 → throw `FACT_RECOVERY_REQUIRED`，約 694/707 行）。
- 呼叫端：`service.ts:1352`，在 `submit` 真正開始 turn 之前：`awaitDeliveryStop(...); priorDocument?.settleFinishedActions()`。

也就是通知喚醒的 submit 在「開始新 turn 前先 settle 舊 action」這一步失敗；pending frame（team spawn 或 notification admission 留下的 action）尚未 settle，於是整個 wake 被拒。

**修正選項**：
1. notification admission 完成後，明確等待 `document.settleFinishedActions()`（或等價 drain）再 `wake`；或
2. `submit` 帶 `admittedInputId` 時，允許先消費該 input，再 settle 先前的 finished actions（順序調整，需保留 fail-closed 檢查）。
兩者都需先確認 pending frame 的來源（team spawn transaction vs notification input admission）。

### 修正（2026-11-05）

`submit` 在帶 `admittedInputId`（notification wake）時，現在**先跳過** `priorDocument.settleFinishedActions()`：
- 該 pending 是 required settlement source（`qualified:false, eligible:0`），它的 close 由這個 turn 消費 input 時觸發；
- 在 turn 前 settle 只會撞上 circular dependency，永遠 `FACT_RECOVERY_REQUIRED`。
- 非 notification 的 submit 仍照舊先 settle；後續 submit 也會正常 settle。

**效果**：composed `completion-delivery` 由 6/13 → **10/13**（喚醒流程的測試已通過）。剩餘 3 個是 close 階段的 `PROCESS_READ_UNAVAILABLE`（artifact path association）與 evidence-root 環境依賴，另外追蹤。

### 剩餘 composed close 問題（2026-11-05，未修）

`completion-delivery` 遷移後剩下 2 個測試在 close 階段失敗：

- 錯誤：`PROCESS_READ_UNAVAILABLE`，throw 於 `canonical-path-resolution.ts` 的 descriptor guard。
- 呼叫路徑：`artifact-path-association.ts:artifactScope()` → `paths.session/document` → guard → `assertOriginal`。
- 表示在 teardown 時，某個已綁定的 backend descriptor 與建立時不同；但 `session-persistence` 內沒有直接重寫 backend 屬性的地方，需進一步確認 composed 包裝層是否在 close 時替換了 descriptor（下一步：在 guard 內比對並印出**哪個 key** changed）。
- 目前 `completion-delivery` 維持 legacy fixture；composed 遷移暫停在 10/13。

**修正後記（2026-11-05，最終）**：先前看到的 close 階段 `PROCESS_READ_UNAVAILABLE` **不是產品問題**，而是那次探針只改了 coordinator 建立、沒有把 `configure` 裡的 `backend.appendOwnedBatch` 覆寫轉成 control hook（事後替換 descriptor 被 guard 抓到）。完成完整 hook 轉換後，composed `completion-delivery` **13/13 全綠**（搭配 `d72dde63` 的 admitted-input settle 修正）。

### lifecycle 遷移狀態（2026-11-05）

lifecycle（14 個 backend 覆寫）以 composed fixture 遷移後最佳為 **41/50**；剩餘 9 個是語義差異，不是 fixture 問題：

- cleanup/stop 之後的錯誤由 legacy 的 `/closed/` 變成 `Team recovery required`（composed 的 recovery 狀態更早 sticky）；
- 部分測試直接以 `coordinator.create({ sessionId, parentSession })` 假造 child session，composed 的 task transition 路徑不支援這種建立方式（需走 bootstrap child API）。
- 已還原 lifecycle 檔案，維持 legacy fixture；其餘已完成遷移的檔案不受影響。
- 另外已把「seeded composed fixture」加入 `composed-fixture-hooks` 作為回歸測試（3/3）。

### 修正：team gate 的 closed vs recovery（2026-11-05）

`mountAgentTeams` 的 team tool gate 原本只要 `phase !== 'open'` 就拋 `Team recovery required`（`FACT_RECOVERY_REQUIRED`）。這讓 **unmount 進行中**（`phase==='retiring'`）的新工作得到 recovery 錯誤，與 legacy 測試預期的 `/closed/` 不符。

已改為：
- `phase === 'recovery'` → `Team recovery required`（`FACT_RECOVERY_REQUIRED`）
- 其他非 open（constructing／partial／retiring／closed）→ `Team is closed`（`FACT_CLOSED`）

效果：lifecycle 以 composed 遷移後由 41/50 → **43/50**（兩個 child-acquisition 測試轉綠）。剩餘 7 個仍為語義差異（cleanup AggregateError 形狀、status edge、settings selection 等），lifecycle 檔案維持 legacy fixture。

### lifecycle 遷移（2026-11-05，部分）

lifecycle 已切到 composed fixture + control hooks：
- 遷移前（legacy fixture）同一環境：**30 failed / 20 passed**；
- 遷移後：**7 failed / 43 passed**（剩餘 7 個：cleanup 的 AggregateError 形狀 ×2、recovery 讀取、deliver fail-closed ×2、wait_agent status edge、settings selection）。
- 這 7 個多數在 legacy 也失敗（pre-existing），不是 composed 新引入；後續逐項處理即可。
- 測試直接 `coordinator.create({sessionId:'target'})`（不再帶 parentSession）：composed 不支援以 create 假造 child-tagged session，parent linkage 由 table entry 提供。

**lifecycle 遷移更新（2026-11-05）**：完成剩餘 seed／backend 覆寫轉換後為 **48 passed / 2 failed**（先前 43/50 的註記以此為準）。

剩餘 2 個：
1. cleanup AggregateError 形狀（`errors[1]` 預期 `null`）——legacy fixture 下同樣失敗，屬 pre-existing 測試假設。
2. restore-path deliver fail-closed 測試在最後 `coordinator.close()` 得到 `Coordinator cleanup is unresolved`——composed 對未結算 action 的 fail-closed 較嚴格，需補明確 reconcile（測試或產品）。

**lifecycle 第 2 個失敗的診斷（2026-11-05）**：`Coordinator cleanup is unresolved` 的內層原因是 **`Managed restored read/document cleanup unresolved`**（`managed-documents.close()` 的 `closeOne` 對某個 document 回報 restored-read 未結清），不是 delivery write 的 pending。也就是 restore-path 測試在 finally 直接 `coordinator.close()` 時，仍有一個由測試流程留下的 managed read handoff；需要先讓該 document 的 read handoff 被 consume／abandon（或測試在 close 前關閉文件）。尚未修。

**lifecycle 失敗 document 定位（2026-11-05）**：`managed-close` 診斷顯示失敗的是 **`parent` document**（`Managed restored read/document cleanup unresolved`）。`restoredEntries` 的 `close()` 在 coordinator teardown 前未被 consume／abandon；測試在 finally 先 `owned.document.close()` 也無效（該 handoff 屬於 managed restored read，不是一般 document handle）。

**下一步**：檢查 `mountAgentTeams` 的 managed parent 收尾（unmount → `managed.parent.close()`）是否應 consume/abandon 這個 restored read；或在 `managed-documents.closeOne` 對「team 已 unmount 的 parent」允許 release。修正後 lifecycle 應達 49/50。

**restored-read close 進一步追蹤（2026-11-05）**：`parent` document 的 `restoredEntries.close()` 會執行
`retired=true → flight → state.close() → history=undefined`，若 `hasFailure` 再 `transitions.joinIO()`；
錯誤（cleanup unresolved）來自這條路徑的其中一步。也就是 restore-path team mount（seed 內含 queued message）讓 parent 走進 restored-read 狀態，並在 close 時留下未完成的 IO／state。
下一步：在 `createManagedRestoredRead.close()` 區分「read 已 failure／retired」與「IO debt」；若 team 已 unmount 且沒有任何 writer，允許 release 而不是 join（或由 mountAgentTeams 在 unmount 時先 settle）。

**實驗結果（2026-11-05，未採用）**：嘗試兩個假設都未讓 lifecycle restore-path 測試轉綠，已全部還原：

1. `createTeamDeliveryFacts`：not-issued 時提早 `source.close()`（避免 delivery settlement 留 hold）。
2. `managed-document.finish`：not-issued 時無條件 `staged.discardUnissued()`（issued 後也丟棄 staged group）。

`closeOne` 診斷仍顯示 step 1 = **document close 回 `Managed facts require reconciliation`**，所以留下 debt 的不是 delivery source 或 discard 與否。下一步需在 document close 路徑列出實際的 `pending`／`recoveryHolds`／`sourceDrains` 條目（含 group 名稱或 action 來源），才能定位是哪個 fact group。

**source-facts drain 實驗（2026-11-05，未採用）**：在 `drainSnapshot` 對 `not-issued` 直接 `remove(fact)`（視為沒有 durable debt）仍無法讓 restore-path 測試通過；teardown 仍以 `Required source facts need recovery` 失敗，表示該 record 的 reconcile outcome 不是 `not-issued`（很可能是 `unknown`，即先前 attempt 已 issued 但結果未知）。已還原，避免放寬真正需要 recovery 的情況。
下一步：在同一位置列出每個 pending fact 的 `outcome.kind/code` 與 group 種類，確認是 delivery admission、team-input-admission 還是 task delivery 的 record。
