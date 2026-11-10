# Teammate 設計對照與 hang 分析（2026-11-10）

## 截圖現象

- `spawn_teammate` 顯示「已發送，等待結果」，長時間沒有 tool result；
- 同一 session 的 `spawn_agent` 有成功也有失敗；
- 子代理列表有 `a14b-rc82` 失敗、`a13b-rc82` 失敗；
- teammate `worker-a` 沒有進入 active，也沒有 failed。

## IH teammate 的實際流程

`spawn_teammate` 不是單純建立 child session，而是：

1. 寫入 `team/member` provisioning 事件；
2. 呼叫 subagent 的 spawnChild（內含 task document、child birth、binding）；
3. 等待 child session 在 `startupTimeoutMs`（預設 10s）內 durably holds prompt；
4. 寫入 `team/member` active 事件；
5. 才回傳 member。

外層工具呼叫沒有整體 deadline；`startupTimeoutMs` 只包住第 3 步。

如果第 2 步的 spawnChild 卡住（task slot flight、child birth、binding），`spawn_teammate` 會一直停在 provisioning，UI 就顯示「已發送，等待結果」。

## IH teammate 的額外層數

一個 teammate 同時涉及：

- parent session event log；
- team ledger（team/member、mailbox、task board）；
- subagent parent task document；
- child session header／event log；
- agent table；
- job registry。

`agent-team` 本身有 scheduler、roster、mailbox、task-board、transact、recovery，約 1,900 行。

## 參考項目

| 專案 | 多代理單位 | 是否有 team roster／mailbox／task board |
|---|---|---|
| DSH | durable child session；parent 只留 child id | 沒有 team 層 |
| OpenCode | child session + parentID | 沒有 team 層 |
| Codex | child thread + 可選 message board | 沒有 named teammate roster；child thread 是 truth |
| Pi | 擴充式 subagent | 沒有 team 層 |
| ZCode | subagent profile | 沒有 named team scheduler |

參考項目的共通點：

- spawn 回傳 child id／session；
- 子代理的狀態由 child session events 推導；
- 沒有「provisioning → checkpoint → active」這種把工具呼叫卡住的階段；
- 失敗直接回 tool error，或由 child session 的 error 呈現。

## 主要差異

1. **IH 把 teammate 做成獨立的 durable state machine**，其他項目只有 child session。
2. **spawn_teammate 的 critical path 太長**：provisioning、spawnChild、prompt checkpoint、active 都在 tool call 內。
3. **沒有整體 timeout**：spawnChild 卡住時，工具永遠不會回 error。
4. **managed caller 失敗路徑只 throw**：`opts.originalCaller` 分支不會寫 failed member 事件，容易留下 provisioning 殘留。
5. **team scheduler 疊在 subagent task document 之上**，任何一層 debt 都會放大成 teammate hang。

## 建議

### 短期（低風險）

- 對整個 `spawn_teammate` 加 deadline（例如 30s），用 AbortSignal 取消 spawnChild；
- timeout 時寫入 `team/member failed`，關閉已建立的 child，回傳 TOOL_FAILED；
- managed caller 失敗路徑也寫 failed 事件，不再只 throw；
- UI 顯示 provisioning 已等待秒數。

### 中期

- spawn_teammate 回傳 child id 後立即回 tool result；prompt checkpoint／active 改非同步事件；
- roster 狀態由 child session 推導，team ledger 只作 projection；
- `wait_for_teammates` 預設有上限，不讓 Lead 永久阻塞。

### 長期

- 把 team 層降級成 optional plugin；預設只用 child session／subagent；
- 若保留 team，mailbox／task board 應是 child session 的 projection，不是第二套 durable truth。
