# IH Runtime 重構研究：延遲與 Subagent 任務層（2026-11-09）

## 一、結論先講

現在有兩個獨立問題，不應該混在一起重寫：

1. **Subagent 任務層過度設計**：parent task document 是第二個 durable source of truth，會把 spawn 永久鎖死。
2. **主代理提示詞延遲**：目前證據顯示主要時間花在模型推理／請求，不是 gateway 建立連線；但 IH 的 admission 與 context 重建仍然偏重，需要拆開量測。

建議重構方向是「單一 durable truth + 可重建 projection + resident session actor」，而不是再往 gateway 進程模型加東西。

## 二、實際觀測

### 使用者 session 的 model request

```text
model/connecting   20:00:03.791
context/request    20:00:23.479   (+19.7s)
model/settled      20:00:26.314   completed
```

`context/request` 是 usage-capture 在請求完成後才送出的統計事件，所以這個 19.7 秒不是「送出前建立連線」，而是整個 model request 的實際時間。

請求內容：

```json
{"bodyBytes":524548,"inlineBinaryBytes":200068,"imageCount":1,
 "schemaTokens":12685,"reasoningTokens":9462,"reasoningBudget":65536}
```

UI 顯示推理強度為 **Max**。也就是：

- 524 KB request body；
- 200 KB inline binary（圖片直接進 body）；
- 9.4k reasoning tokens；
- Max reasoning effort。

這四項任何一項都會讓第一個可見回覆變慢。**不能只用 gateway 進程模型解釋。**

### 需要補的量測

目前 diagnostics 沒有分開：

- UI submit → durable admission 完成；
- admission → assembly ready；
- assembly → context projection ready；
- context ready → HTTP send；
- send → first byte；
- first byte → first visible token。

`context/request` 是完成後統計，不能拿來判斷 pre-send 延遲。重構第一步必須先加這些 timestamp。

## 三、IH 目前 prompt 路徑

`desktop/session/input/submit` 在 admission 階段做了：

1. per-session serial gate；
2. `coordinator.profile`；
3. `managedInputFor`；
4. token receipt document 讀取；
5. 第一次寫入 receipt；
6. 再讀回驗證；
7. `openManagedDocument` + `assertReady`；
8. `inbox.admit`（durable event append）；
9. 才 `schedulePending` → `service.submit`。

這是「多層 durable 協調」，不是單純 append 一則 user message。

## 四、IH 目前 subagent 路徑

一個 subagent 同時存在於：

```text
parent session event log
parent task document（format v3, owned/strict save）
child session event log
runtime table
job registry
team roster
```

`TaskPersistence` 有 `#chain`、`#pending`、`#debt`、`#debtCause`、required capture、retire/retry。

Child writer 的 `Original writer dependency cleanup unresolved` 會讓 parent 的 task save 留下 `Earlier owned task save requires resolution`，從此 spawn 永久失敗。

## 五、參考項目

| 專案 | Durable truth | Parent task ledger | Prompt runtime |
|---|---|---|---|
| **DSH** | child session | 沒有；parent 只留 child id | resident host + session manager |
| **OpenCode** | child session + `parentID` | 沒有；session list 查詢 | background service + 樂觀 UI／queue |
| **Codex** | thread / rollout | thread store，不是 parent second writer | app-server daemon |
| **ZCode** | child session + agent manager | 較薄 runtime table | per-window host |
| **Pi** | 同進程 agent | 無 | 進程內 |

DSH 的 `SubagentManager.startLocal()` 直接建 durable child session，activation 是 process-local；沒有「parent task save 成功才算 spawn 成功」。

DSH 的 reasoning effort 允許 provider-default（undefined），不是強制 Max。

## 六、目標架構

### 1. 單一 durable truth

```text
session event log = 唯一 durable truth
task list / task status / result index = 可重建 projection
```

- parent task document 不再阻塞 spawn；
- child session 建立成功即 spawn 成功；
- task projection 非同步更新，失敗只記 warning；
- orphan child session 可以被 adopt；
- close_agent 對 terminal/orphan 一律 idempotent。

### 2. 快速 admission

```text
submit → append user/message → return accepted（<100ms 目標）
       → session actor 非同步啟動 turn
```

- token receipt 改成 best-effort 或 optional；
- 不在 admission critical path 做 readback 驗證；
- clientToken 冪等保留，但用 append-only receipt，不阻塞回覆。

### 3. Resident session actor

- session/open 時建立／attach actor；
- assembly、tool registry、context projection 常駐；
- 切換會話不重建 assembly；
- actor 內序列化 turn，避免多個 durable writer。

### 4. Context projection

- 以 checkpoint + delta 維護 request context；
- 不每次重讀完整 event log、不重建 500KB body；
- 圖片／大型 tool result 用 artifact reference，body 只放 id；
- reasoning effort 預設跟 provider，不預設 Max；Max 要明確選擇並提示延遲。

### 5. Gateway

- 保留 supervisor／health／fatal IPC；
- 從「per-workspace child + 每次 session 冷組裝」往「host + per-session actor」演進；
- 不建議先重寫成 per-window host；目前 crash 隔離已足夠，延遲主因不在 process 數量。

## 七、涉及範圍

| 模組 | 改動 | 風險 |
|---|---|---|
| `packages/subagent/task/*` | 移除 parent task 的 blocking debt；改 projection | 高 |
| `packages/subagent/tools/*` | spawn/close 不再依賴 ledger save | 中 |
| `packages/desktop-gateway/src/input.ts` | admission 拆成 append + async start | 高 |
| `packages/core-agent` / `session-executor` | turn 啟動、first-token 量測 | 中 |
| context / compaction | checkpoint、artifact offload | 高 |
| `packages/desktop/src/renderer` | 狀態顯示、Max 警告、queue | 低 |
| diagnostics / usage | admissionMs、firstTokenMs、source | 低 |
| 資料遷移 | 舊 task document → projection，orphan adopt | 高 |

## 八、分階段

### Phase 0：量測（先做）

- admissionMs / assemblyMs / contextMs / firstByteMs / firstTokenMs；
- 每個 model_error 帶 source（main／subagent／title）與 requestId；
- 用一個 500KB context 的 session 做 baseline。

### Phase 1：停止 blocking

- task ledger 改成 best-effort projection；
- spawn 建好 child 即成功；
- close idempotent；
- admission 只 append user event 後回 accepted。

### Phase 2：Context 與 artifact

- projection checkpoint；
- 圖片／大結果 offload；
- 預設 reasoning effort 改 provider-default；Max 顯示延遲提示。

### Phase 3：Resident actor

- session/open attach actor；
- warm assembly；
- 背景預熱最近會話。

### Phase 4：清理

- 移除 strict v3／required capture／owned save 的舊路徑；
- 保留結果 retention 與 cancellation。

## 九、驗收指標

- submit → accepted p95 < 100ms；
- accepted → turn started p95 < 300ms（不含模型）；
- 500KB context 的 context projection p95 < 500ms；
- spawn 不再因 task save debt 失敗；
- `model_error` 必須帶來源與 provider facts，不再 generic；
- 同一 session 不再出現 `Earlier owned task save requires resolution`。

## 十、建議

不要先重寫 gateway。先把 **parent task ledger 從 critical path 移除**、把 **admission 改成 append + async**、把 **context projection 快取** 做起。這三件事完成後，再評估 resident actor 是否還需要更大規模的 gateway 改造。
