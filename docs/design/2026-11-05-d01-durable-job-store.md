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
4. **（部分完成）** recovery 的 `classifyRestoredTasks` 先看 job record：terminal job 可直接結案（child session 遺失時仍能恢復 completed／error／cancelled，error 取 job terminal 的 reason，completed 則在 child session 仍在時補 resultText）。task document 仍是可變寫入來源；移除可變寫入與 D-08 的 per-job 隔離留待下一步。
5. 端到端測試：spawn → child session → job record → 父通知；崩潰重啟後只靠 child session + job record 重建。

## 驗證

- `packages/subagent/test/job-record.test.ts`：fold／terminal 不可逆／壞行容錯／schema 拒絕，3/3。
- 後續步驟需補：重啟重建、與 task projection 的一致性、desktop 顯示。
