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
2. 在 spawn / status transition / terminal 時 append job record（與現有 journal/document 雙寫，先不改讀取）。
3. recovery / desktop catalog 改讀 job record；task document 只作為 projection，不一致時用既有 `inspectTaskProjection` 產生 warning。
4. 移除 task document 的可變寫入（或改成 write-behind），讓父會話不再因單一 job 的 debt 而封鎖。
5. 端到端測試：spawn → child session → job record → 父通知；崩潰重啟後只靠 child session + job record 重建。

## 驗證

- `packages/subagent/test/job-record.test.ts`：fold／terminal 不可逆／壞行容錯／schema 拒絕，3/3。
- 後續步驟需補：重啟重建、與 task projection 的一致性、desktop 顯示。
