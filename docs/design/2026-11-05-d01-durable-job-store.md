# D-01 durable job record：設計與第一步（2026-11-05）

## 問題

同一個子代理任務目前有三份事實來源：

1. 父 journal 的 `subagent/start` / `subagent/end`；
2. 父會話的 `task-<parent>.doc.jsonl`（v3，可變 document，每次狀態變化整份重寫）；
3. child session（header 的 `parentSession` / `origin`）。

三份要在 spawn 時同步；任一寫入失敗就破壞一致性，而且 task document 的 debt 會封鎖整個父會話（D-08）。

## 目標模型（對照 Codex / opencode）

- **child session 是執行事實的唯一來源**（rollout 本身就是 durable log）。
- **job record 是任務層的唯一來源**：append-only、可 fold、可重建、per-job 隔離。
- 父會話**只 append** 一筆完成通知（像 Codex 的 `SubAgentActivity` / opencode 的 completion message），不再參與可變 registry document 的寫入。
- task document 降級為 **write-behind projection**（或直接廢除），讀取時若與 job record 不一致，產生 `projectionWarning` 而不是讓 session 卡住。

## JobRecordV1（本次已實作）

```ts
{
  version: 1,
  jobId: string,
  parentSessionId: string,
  childSessionId?: string,
  status: "accepted" | "running" | "completed" | "error" | "cancelled" | "recovery-required",
  createdAt: number,
  updatedAt: number,
  terminal?: { at: number; reason?: string },
  detail?: string
}
```

- append-only JSONL，一行一筆完整 snapshot（不是 patch）；`load()` 以 jobId fold 出最新狀態。
- terminal 狀態（completed/error/cancelled）必須有 `terminal`，且 terminal 之後的紀錄會被視為 corruption warning，不會覆蓋。
- 損壞的行只產生 warning，不丟棄其他有效紀錄。
- 存放位置（下一步）：`<sessionDir>/jobs/<parentSessionId>.jobs.jsonl`，由 subagent task manager 的單一 writer append。

## 落地步驟

1. **（本輪）** schema + `createJobRecordStore` + fold/validation 測試。不動任何現有路徑。
2. **（已完成）** 在 TaskRegistry 的 submit / claim / 	erminalize / cancelTree append job record，寫入序列化並由 lushPersistence() 一起 drain；與現有 journal/document 雙寫，讀取路徑未變。append 失敗只影響該 job（best-effort，IH_JOB_RECORD_DEBUG 可觀察）。
3. **（已完成，read-only 檢查）** `inspectJobRecordProjection` 比對 job record 與 task projection，回報 `job-record-missing`／`terminal-ahead`／`terminal-missing`／`child-mismatch`；session-executor 的 `taskProjectionIntegrity`／`reconcileProjection` 會附帶這些問題。不改 task 狀態、不寫 document；沒有 job file 的舊 session 視為尚未遷移。
4. **（部分完成）** recovery 的 `classifyRestoredTasks` 先看 job record：terminal job 可直接結案（child session 遺失時仍能恢復 completed／error／cancelled，error 取 job terminal 的 reason，completed 則在 child session 仍在時補 resultText）。task document 仍是可變寫入來源；移除可變寫入留待下一步。
   - **D-08（部分完成）**：spawn 的 admission drain 改用 `flushPersistenceBestEffort()`：document 寫入失敗只回報（`{ok:false,error}`，且 registry 會保留最近失敗），不再讓該次 spawn 或後續任務被 debt 擋住；job record 已先寫入，父 journal 仍照常 append。close 路徑仍用 strict `flushPersistence()`，清理失敗不會被吞掉。
5. **（e2e 已完成重建層）** `rebuildTaskDocumentFromJobRecords` 可在 task document 遺失時，用 job record（含 agentPath／description／agent／delivery 等 projection metadata）重建 v1 文件，再走正常 `restore()` 驗證與 counter seeding。測試覆蓋 writer → job records → 空 registry 重建 → 終態與 classifyRestoredTasks 無額外動作。
   **（已接上 legacy restore 路徑）** `restoreTaskDocument` 在 `getDocument` 缺失或拋錯時，自動用 job record 重建文件再 restore；`restoreTasksAndSweep` 已改用它。owned／v3（desktop）路徑仍走原本的 stage restore，尚未接 fallback；移除可變 document 寫入也尚未做。

## 驗證

- `packages/subagent/test/job-record.test.ts`：fold／terminal 不可逆／壞行容錯／schema 拒絕，3/3。
- 後續步驟需補：重啟重建、與 task projection 的一致性、desktop 顯示。

## Owned／v3 restore 的決策（2026-11-05）

owned 路徑的 task document 同時是**寫入所有權的 witness**（`observe → confirm → handoff`）；在 document 缺失時用 job record 偽造一份文件，會繞過 read confirmation／ownership 契約，因此**不做自動 fallback**。

降級模式改為唯讀：`readRecoveredTaskRows(coordinator, parentSessionId)` 從 job record fold 出任務列（status／outcome／error／childSessionId／agentPath），供 host 在 registry unavailable 時顯示與診斷；此模式**明確不可 admit 新工作**。下一步是在 desktop 的 task projection 接上這個降級來源與 banner。
- **降級顯示（2026-11-05）**：`SessionService.tasksAsync()` 在 `TASK_REGISTRY_UNAVAILABLE` 時改讀 job record，回傳 `AgentTaskView`（`canCancel:false`、summary 標明 recovered read-only）；SDK `session/tasks` 已優先使用 `tasksAsync`。這讓 desktop 在 task document／registry 不可用時仍看到最後已知任務，而不是整個清單失敗。

- **write-behind（2026-11-05，legacy/non-owned）**：`TaskPersistence` 對非 strict／非 owned 的 document 寫入做 coalescing——同一 microtask 內多次 save 只寫一次「最新 snapshot」，`flush()` 會等 in-flight 寫入完成；strict／owned 仍保持有序且可 capture 的寫入契約。這降低了每次狀態變化重寫整份文件的成本，但 document 本身仍是可變來源。

## D-07 持久化寫入意圖（2026-11-05）

每次 task document 寫入前，先在 `jobs/<stateId>.write-intents.jsonl` 追加 `pending`；成功後追加 `settled`。重啟後 `readPendingDocumentWrites(coordinator, stateId)` 會回報未匹配的 pending intent——這就是「fail-closed 的 debt 有 durable 證據」，不再只靠記憶體。

尚未自動 reconcile（把 pending 清除或重試）；目前提供唯讀證據，供 recovery 判斷與後續的顯式 reconcile 流程。
