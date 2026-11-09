# 日常完整流程：IH 與參考項目對照（2026-11-09）

## 一、流程基準

以一個日常流程為標準，拆成 9 段：

```text
F0 啟動 App／後端就緒
F1 開啟專案／選擇既有會話
F2 輸入提示詞並送出
F3 建立 turn／session assembly
F4 建立請求 context
F5 連接模型、first token、串流
F6 工具呼叫與結果回填
F7 subagent spawn／結果／close
F8 排隊、steer、停止
F9 重新開啟、持久化、crash recovery
```

## 二、逐段對照

### F0 啟動與後端

| 專案 | 流程 |
|---|---|
| **IH** | Electron main → 每個 workspace spawn 一個 gateway child（stdio）→ supervisor／health check |
| **DSH** | Electron main → 一個 desktop-host child（Web server）→ 所有 session 在同一個 host |
| **OpenCode** | Electron main → CLI `serve` background service（sidecar）→ 多個 window 共用；有 reconnect |
| **ZCode** | Electron main → 每個 window 一個 utilityProcess host → ChannelServer |
| **Codex** | client → app-server daemon（pidfile、detached） |
| **Pi** | 無獨立後端，agent 在 CLI 進程內 |

**差異**：IH 是 per-workspace child；DSH／OpenCode 是一個 host 管全部 session；ZCode 是 per-window host。IH 的 process 數量與冷啟動成本最高。

### F1 開啟專案／會話

| 專案 | 流程 |
|---|---|
| **IH** | renderer `desktop/session/open` → main 並行 dashboard／history／input state；event window 快取；assembly 尚未建立 |
| **DSH** | client session store；Host 已有 resident session；conversation shell 直接 attach |
| **OpenCode** | app 向 background service 查 session；messages 由服務載入 |
| **ZCode** | host 回 session metadata；conversation 由 host 提供 |

**差異**：IH 的 F1 只載入 event window，**真正 assembly 要等第一次 prompt（F3）**；DSH／OpenCode 的 session runtime 已經是 resident。

### F2 輸入提示詞／admission

| 專案 | 流程 |
|---|---|
| **IH** | `desktop/session/input/submit` → per-session serial gate → coordinator.profile → token receipt 讀寫＋讀回 → managed document assertReady → `inbox.admit` → 才 accepted |
| **DSH** | `SubmitMachine` 把 prompt 交給 Host；Host admit 到 session log；UI 在 Host 接受前保持唯讀 |
| **OpenCode** | composer 先把 prompt 放入本地 handoff／queue；server 接受後才有 row |
| **ZCode** | renderer → main → host ChannelServer；host 接納後回傳 |

**差異**：IH 的 admission 有 **多個 durable 文件步驟**（receipt 寫入＋讀回、managed doc、inbox），DSH／OpenCode 主要是「admit 到 session log／queue」。IH 的 accepted 比較晚。

### F3 建立 turn／assembly

| 專案 | 流程 |
|---|---|
| **IH** | `input.ts` schedule → `service.submit` → 需要時建立 assembly、tool registry、model binding |
| **DSH** | Host 已有 session Agent；只建立下一個 turn |
| **OpenCode** | background service 已有 session；prompt 進入 agent loop |
| **ZCode** | host 內 agent manager 已有 session |

**差異**：IH 是 **lazy assembly**，第一次 prompt 要付 assembly 成本；參考項目多為 resident session。

### F4 建立 context

| 專案 | 流程 |
|---|---|
| **IH** | 每次 turn 從 event log 重建 request context；大型 tool result／圖片 inline |
| **DSH** | session views／incremental projection；大型輸出用 artifact／result ref |
| **OpenCode** | session store + message projection；tool result 有 retention |
| **Codex** | thread rollout；context 由 rollout 重建，但有 checkpoint |

**差異**：IH 的 request body 實測 524 KB，其中 200 KB 是 inline binary；每次重投影成本高。

### F5 模型連線／串流

| 專案 | 流程 |
|---|---|
| **IH** | provider runtime → anthropic-messages HTTP → SSE；UI 顯示思考過程 |
| **DSH** | LLM runtime → provider stream；events 進 session log |
| **OpenCode** | Effect stream → SSE／WebSocket |
| **Codex** | app-server → provider stream → turn events |

**差異**：這一層都差不多；IH 的延遲主要被 **reasoning effort Max + 524 KB context** 放大。

### F6 工具呼叫

| 專案 | 流程 |
|---|---|
| **IH** | core-agent tool batch → session event → tool dispatch → result event |
| **DSH** | tool runtime → session event；result artifact |
| **OpenCode** | tool call → server handler → event |
| **ZCode** | host tool manager → ChannelServer |

**差異**：IH 的 tool result 大量 inline，會增加下一次 F4 的 context。

### F7 Subagent

| 專案 | 流程 |
|---|---|
| **IH** | parent task document（owned/strict save）＋ child session＋ runtime table＋ job registry＋ team roster |
| **DSH** | durable child session；parent 只留 child id；activation process-local |
| **OpenCode** | child session + `parentID`；由 session list 查詢 |
| **ZCode** | agent manager + child session |
| **Codex** | thread / rollout |

**差異**：只有 IH 把 parent task 當第二個 transactional source of truth；這是 `Earlier owned task save requires resolution` 的來源。

### F8 排隊／停止

| 專案 | 流程 |
|---|---|
| **IH** | durable inbox + queue state + input cancel；draft session stop 需要 fallback |
| **DSH** | QueueDock + submit machine；Host 管理佇列 |
| **OpenCode** | queue panel + inbox API |
| **ZCode** | host task queue |

**差異**：IH 的 queue 與 durable input 是兩套 projection，容易不同步。

### F9 重新開啟／recovery

| 專案 | 流程 |
|---|---|
| **IH** | session/open + event window 快取；gateway supervisor；task document debt 可能永久卡住 |
| **DSH** | Host resident；session store 載入；Host crash 顯示 fatal |
| **OpenCode** | background service reconnect／ensure |
| **Codex** | daemon restart |

**差異**：IH 的 recovery 同時要處理 gateway、session managed facts、task document debt，層數最多。

## 三、最大差異（按影響排序）

1. **Subagent durable truth 重複**：IH parent task document vs 參考項目的 child session。
2. **Session lazy assembly**：IH 第一次 prompt 才建 assembly；參考項目 resident。
3. **Admission 太重**：IH 多個 durable write／readback；參考項目以 append／queue 為主。
4. **Context 全量重建＋inline binary**：IH 524 KB；參考項目 incremental／artifact。
5. **Reasoning effort 預設 Max**：IH session 顯示 Max；DSH 允許 provider-default。
6. **Queue 與 durable input 雙 projection**：IH 容易不同步。

## 四、以包為單位的調整範圍

| 包 | 責任 | 調整 |
|---|---|---|
| `packages/desktop-gateway` | admission、session routing、queue | 把 `input.ts` 改成 append + async start；session actor attach |
| `packages/session-executor` | submit、assembly、queue | assembly cache／resident；turn scheduling |
| `packages/core-agent` | model step、tools、context | first-token metrics；incremental context |
| `packages/context` / `compaction` | projection、budget | checkpoint + artifact ref |
| `packages/subagent` | task、spawn、close、result | 移除 parent task blocking；child session truth |
| `packages/desktop` | renderer composer／queue／history | Max 警告、queue 單一 projection、fast ack |
| `packages/sdk` | protocol | session/open、turn events、metrics |
| `packages/usage-stats` | request metrics | admissionMs、firstByteMs、firstTokenMs |

## 五、分階段與驗收

### Phase 0：量測

- submit → accepted；
- accepted → turn start；
- turn start → context ready；
- context ready → first byte；
- first byte → first token；
- subagent source／requestId。

驗收：每個階段有 p50／p95，不再只有 `model_error`。

### Phase 1：subagent projection

- parent task document 不再是 source of truth；
- spawn 建 child session 即成功；
- close terminal idempotent；
- task list 由 child session 推導。

驗收：不再出現 `Earlier owned task save requires resolution`。

### Phase 2：fast admission + context

- admission 只 append user event；
- context checkpoint／artifact offload；
- reasoning effort 預設 provider-default；Max 要提示。

驗收：accepted p95 <100ms；500KB context projection p95 <500ms。

### Phase 3：resident actor

- session/open attach actor；
- warm assembly；
- queue 單一 projection。

驗收：第二次 prompt 不再付 assembly 成本。

## 六、Codex 的完整流程

Codex 的日常流程是 thread/turn 協議：

```text
F0 client → app-server daemon（thread store、turn admission）
F1 thread/start | thread/resume → ThreadManager 載入 rollout
F2 turn/start → TurnAdmission permit；queue 進 LocalQueueStore
F3 ThreadManager 建立 turn context → core 執行
F4 provider stream → turn events
F5 tool calls / approvals
F6 subagent = thread/start with SubAgentSource::ThreadSpawn
F7 queue / cancel = LocalQueueStore + TurnAdmission
F8 rollout / thread store 持久化
```

與 IH 的差異：

- Codex 的 durable truth 是 **thread / rollout**；subagent 是 child thread，不是 parent task document。
- queue 是 **LocalQueueStore**，和 turn admission 分開，但沒有 IH 的 owned-save debt。
- app-server daemon 常駐；thread manager 已有 thread，不需要每次 prompt 重建 assembly。
- 有 turn admission gate，但 gate 只控制 shutdown／並發，不是第二個 task ledger。

## 七、Pi 的完整流程

Pi 的路徑最短：

```text
F0 CLI / TUI 進程
F1 載入 session context
F2 agentLoop(prompts, context) 直接開始，回傳 EventStream
F3 沒有 backend hop、沒有 IPC admission
F4 context 已在記憶體；只在 LLM 邊界轉 Message[]
F5 provider stream → tool loop
F6 abort signal 停止
F7 session／durable documents 由 app 層處理
```

與 IH 的差異：

- Pi 沒有 gateway、沒有 durable input admission、沒有 parent task ledger；prompt 直接進 agent loop。
- 優點是延遲最低；代價是沒有多視窗／daemon／跨進程 durability。
- Pi 的 `durable` 套件是文件／任務資料，不是 IH 那種 per-subagent transactional task ledger。
- Pi 沒有原生 subagent 任務層，不能直接類比 IH 的 spawn_agent。

## 八、四種流程的關鍵對照

| 階段 | IH | Codex | Pi | DSH |
|---|---|---|---|---|
| 後端 | per-workspace gateway child | app-server daemon | 單進程 | desktop-host |
| prompt admission | token receipt＋managed doc＋inbox | TurnAdmission + queue store | 直接 agentLoop | Host session log |
| assembly | lazy，第一次 prompt 才建 | thread 常駐 | context 在記憶體 | resident session |
| durable truth | session log＋task document | thread/rollout | session/context | session |
| subagent | parent task doc＋child session | child thread | 無 | child session |
| 停止／queue | durable inbox＋queue projection | LocalQueueStore | AbortSignal | Host queue |

## 九、Codex 與 Pi 給 IH 的啟示

- **Codex** 證明：即使需要 daemon、thread store、turn admission、queue，仍然不需要 parent task document 這種第二個 durable writer；subagent 用 child thread 就夠。
- **Pi** 證明：prompt 可以 append 後直接進 agent loop；但 IH 需要多視窗與 durable recovery，不能完全照搬。
- IH 的合理位置是 **Codex 的 thread/child-thread 模型 + DSH 的 resident host + Pi 的輕量 admission**，而不是現在的 parent task document。

## 十、結論

IH 與參考項目在 F5 模型串流本身差距不大；主要差距在 **F2 admission、F3 assembly、F4 context、F7 subagent**。這四段正好分布在不同的包，可以分開調整，不需要一次重寫整個 gateway。
