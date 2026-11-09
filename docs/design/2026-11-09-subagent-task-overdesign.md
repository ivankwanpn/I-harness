# Subagent task persistence：是否過度設計？（2026-11-09）

## 問題回顧

實際 failure chain：

```text
spawn_agent
  → Earlier owned task save requires resolution
task-5
  → Original writer dependency cleanup unresolved
close_agent
  → unknown subagent: root/a14-bg-progress
session/error
  → Model request failed (model_error)   # 誤導性的 fallback
```

主模型 request 已完成；問題發生在 **parent task document** 與 **child session writer** 之間的協調層。

## IH 目前的資料層

一個 subagent 同時涉及：

1. parent session event log
2. parent task document（format v1/v2/v3，owned/strict capture）
3. child session event log
4. subagent runtime table（process-local）
5. job registry
6. team roster（team tools）

`TaskPersistence` 額外有：

- `#chain`、`#pending`、`#debt`、`#debtCause`
- `captureOwned`、`requiredOwned`、`retireConsumer`、`retry`
- `Earlier owned task save requires resolution`
- launch slots / binding save / terminalize

這是兩個 durable writer（parent task doc + child session）之間的事務協調。

## 參考項目怎麼做

| 專案 | subagent 的 durable truth | 額外 task ledger |
|---|---|---|
| **DSH** | child session（durable session id）；activation 是 process-local | **沒有** parent task document |
| **OpenCode** | child session，`parentID` 指向 parent | **沒有** task ledger；由 session list 查詢 |
| **Codex** | thread / rollout | thread store，不是 parent 的 second writer |
| **ZCode** | agent manager + child session | 較薄的 runtime table，沒有 owned-save debt |
| **Pi** | 同進程 agent，無 durable subagent ledger | 無 |

DSH 的 `SubagentManager.startLocal()` 直接建立 durable child session；parent 只保留 child id，結果以訊息送回。沒有「parent task save 成功才算 spawn 成功」這條路徑。

## 判斷：有過度設計

過度的地方不是「durable task 記錄」本身，而是：

1. **把 parent task document 當成第二個 source of truth**，而且放在 spawn 的 critical path；
2. 為它加了 ordered owned saves、strict v3、required captures、retire/debt/retry 狀態機；
3. parent task save 與 child session writer 的 cleanup 綁在一起；child writer 一個 `cleanup unresolved`，parent spawn 就永久被 debt 擋住；
4. runtime table、task ledger、child session 三者可以不同步，於是 `close_agent` 看到 ghost path；
5. 錯誤被折疊成 `model_error`，掩盖真正的 task recovery failure。

這是典型的 **double bookkeeping**：同一件事（subagent 是否存在、是否 terminal、結果是什麼）在兩個 durable store 各記一次，卻沒有 single-writer 或可重建投影。

## 建議的合理設計

### 原則

- **child session 是唯一 durable truth**；
- parent task ledger 只能是 **rebuildable projection / cache**；
- ledger 寫入失敗不得阻止 spawn、close、cancel、result delivery；
- terminal 狀態由 child session event 或 result artifact 決定；
- orphan child session 可以被 adopt 回 projection。

### 分階段

1. **停止 blocking（低風險）**
   - spawn 成功建立 child session 後即視為成功；
   - parent task save 改成 best-effort，失敗只記 warning；
   - `close_agent` 對 terminal/orphan idempotent（已做）。

2. **投影化（中風險）**
   - `list_agents` / `get_task_output` / `close_agent` 從 child session + job registry 推導；
   - task document 只保留 UI 需要的 label/notification，可重建；
   - 移除 `required capture → debt` 作為 admission gate。

3. **清理（可選）**
   - 若沒有外部格式承諾，移除 strict v3 / required capture / owned save 的複雜度；
   - 保留 result retention 與 cancellation，但掛在 child session 上。

### 不建議

- 不要只把 debt 自動 retry 當成長期解；那只是把 overdesign 的症狀壓下去。
- 不要讓 `model_error` 承擔 task recovery 的錯誤分類。

## 結論

IH 在 subagent 這一塊確實比參考項目多了一層 parent task 事務層，這一層在 child session writer 失敗時會把整個 spawn 卡死。合理的方向是把它降級成可重建 projection，而不是繼續補 debt 的例外處理。
