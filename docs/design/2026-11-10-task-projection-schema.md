# Task projection schema 設計（rc81）

## 目標

讓 catalog 在沒有 task document 時，仍能知道 child session 的 taskId／agentPath，而不是只靠 task document hint。

## 現況

- child session meta 只有 `origin`、`parentSession`、`delegationDepth`、`subagentProtocolVersion`；
- task document 提供 `taskId → childSessionId`、`agentPath`；
- catalog 已能從 child session 建列，但 closed row 的 path 仍依賴 task document。

## 方案

在 child session header 增加兩個 optional、immutable 欄位：

```ts
subagentTaskId?: string
subagentAgentPath?: string
```

由 `spawn_agent` 建立 child 時寫入。

### 需要修改

1. `core-session/src/events/types.ts`：SessionHeader 增加欄位；
2. `session-persistence/src/coordinator/bootstrap-types.ts`：BootstrapLineage 增加欄位；
3. `bootstrap-header.ts` / `child-bootstrap-intent.ts`：欄位白名單與驗證；
4. `format/validation.ts`：meta 輸出；
5. `task-parent-metadata.ts`：parent metadata keys；
6. `subagent/src/child.ts`：coordinator.create 傳入；
7. `subagent/src/tools/spawn.ts`：把 task.id／agentPath 傳給 spawnChild；
8. `desktop-gateway/src/subagents/catalog.ts`：優先使用 meta 欄位。

## 風險

- header schema / bootstrap validation 是跨套件契約，任何漏改都會讓舊 session 讀取失敗；
- 需要 backward compatibility：沒有欄位的舊 child session 仍由 task document fallback；
- 需要測試 header round-trip、舊 session 載入、catalog fallback。

## 建議

這是一個獨立的 schema 變更，不應與 receipt／context 改動混在一起。

若要做，應：

1. 先加欄位與 validation，不改 catalog；
2. 跑 session-persistence header round-trip；
3. 再讓 spawn 寫入；
4. 最後 catalog 使用，task document 只留 fallback。

目前 rc81 不做這個 schema 變更；先保持 task document hint，避免 destabilize header。
