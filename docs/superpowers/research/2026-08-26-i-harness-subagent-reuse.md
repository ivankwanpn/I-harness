# i-harness Subagent 系統 × M19（Subagent Teams）重用性研究

日期：2026-08-26 ｜ 範圍：packages/subagent、core-session、session-persistence(-jsonl/-sqlite)、core-plugin、core-agent、apps/cli/src/run.ts ｜ 全部只讀
（內容由並行研究子代理產出，協調代理落盤）

## 1. packages/subagent（src + test）

### 1.1 child.ts — spawnChild

關鍵簽名（`packages/subagent/src/child.ts:13-31`）：

```ts
interface SpawnOptions {
  taskName: string; message: string
  parentPath: string; parentRegistry: ToolRegistry
  parentSession: ReturnType<typeof createSession>; parentCtx: PluginContext
  role: SubagentRole; parentModel: ModelClient; providers: ProviderRegistry
  jobs: JobRegistry; table: AgentTable; agents: AgentRegistry
  forkTurns?: "none" | "all" | number
  childSessions?: { coordinator: SessionCoordinator; parentSessionId: string }  // M8
}
async function spawnChild(opts): Promise<{ path; jobId; sessionId? }>
```

流程（`child.ts:33-151`）：
- `childPath = ${parentPath}/${taskName}`（:44）；`childCtx = parentCtx.scope.mount()`（:48）。
- **fork vs fresh**（:51-56）：`forkTurns` 預設 `"all"`；`none` → 空 seed；N → `forkTurns(parentSession.events, N)`。
- **durable 化（M8）**（:61-91）：`sessionId = child-<uuid>`；`coordinator.create({ sessionId, parentSession, seedLength, origin: "subagent", delegationDepth: 1 })`（depth 硬編碼 1）；`createSession(ev => { coordinator.enqueue(sessionId,[ev]); if turn/end → flush })`（每事件即時 enqueue，turn/end 觸發 flush）；seed 經 `append(childSession, {...ev})`（append hook 會重複 enqueue，seq 從 0 開始）；`childSession.header` 手動設 `{ parentSession, seedLength, origin, delegationDepth: 1 }`。無 childSessions → 純 memory session。
- **child registry / model**（:94-108）：child 用 `createToolRegistry(childCtx)`，只註冊 `role.tools` 中可在 parentRegistry 解析到的工具；`role.model` → `buildModelClient(provider, model, extra)`，否則繼承 `parentModel`。
- **job 建立**（:117）：`jobs.registerJob("root", "subagent", taskName)`（owner 固定 "root"）。
- **table.add**（:118-131）：`{ path, status: "running", session, controller, mailbox: [], jobId, sessionId?, roleName, followupChain: initialRun.then(()=>{},()=>{}), unmount: () => childCtx.scope.unmount() }`。**followupChain 以 initialRun 起頭**——中期 followup_task 會等第一輪 turn 結束（queue-then-run 語意）。
- **initialRun 回呼**（:133-148）：成功 → `waiting` + finalText + job `completed`；失敗 → 仍 `waiting`（abort 可再 followup）+ error（`aborted` 或訊息）+ job `killed`/`error`。

### 1.2 agent-table.ts

`agent-table.ts:2-16`：

```ts
type ChildStatus = "running" | "waiting" | "completed" | "killed" | "error"
interface ChildAgentEntry {
  path: string; status: ChildStatus
  session; controller: AbortController
  finalText?; error?; mailbox: string[]
  jobId?; unmount?; sessionId?; roleName?; followupChain?; lastInboxSeq?
}
```

`AgentTable` 就是 `Map<string, ChildAgentEntry>`（:17-30），`add` 直接 `table.set(path, entry)` — **同名 path 靜默覆蓋，無唯一性保護**。

### 1.3 persist.ts

- `DurableAgentEntry`（:9-21）：durable 子集（path/status/finalText/error/mailbox/jobId/sessionId/roleName/lastInboxSeq）；**永遠不序列化 session/controller/unmount**。
- `SubagentStateSnapshot`（:30-34）：`{ formatVersion: 1, jobs: DurableJobRecord[], agentTable: DurableAgentEntry[], roles: SubagentRole[] }`。
- `snapshotState`（:44-65）：jobs 取 `jobs.list("root")`（硬編碼 owner）；agentTable 映射 durable 子集；roles 全量。
- `restoreState`（:68-124）：roles 先註冊（`if (!state.roles.get(name))` 防重複）；agentTable 每項：`running|waiting → status "error"` + error `"interrupted by resume"`，session 換成 `createSessionFromEmpty()` stub + fresh AbortController，mailbox 拷貝；jobs **重新 `registerJob`（id 漂移！）**，running → error。
- persistent 包裝（:143-185）：`persistentJobRegistry/AgentTable/RoleRegistry` 在每次 mutation 後 `void save()`（**fire-and-forget，不 await**）。
- `wireSubagentPersistence`（:187-197）：`saveAll = coordinator.putDocument(stateId, snapshotState(state))`；回傳包裝後的 registries（無就地 mutation）。

### 1.4 jobs.ts

`jobs.ts:9-15` API：`registerJob(owner, kind, label)→{id}`（per-kind counter → `subagent-N`）；`updateJob`（**terminal 保護：terminal 且非 running → no-op**；patch status "running" 可 re-open）；`read`；`list(owner)`；`wait(id, timeoutMs)`（**10ms 輪詢**，:40-47）；`kill→"cancellation-requested"|"already-finished"`。

### 1.5 roles.ts

`SubagentRole { name, description, systemPrompt, tools[], model? }`（:3-9）。`builtinRoles()`（:38-63）：general/explore/research/worker，全部**無 model**（繼承 parent model）。

### 1.6 fork.ts

`forkTurns(events, n)`：以 `turn/start` 為切割點；`turnStarts.length <= n` → 回傳全部；否則從倒數第 n 個 turn/start 起 slice（:1-11）。

### 1.7 tools.ts — 11 個工具語意

`SubagentToolDeps`（:13-32）：table/jobs/roles/parentRegistry/parentSession/parentCtx/parentModel/providers/exec/agents/`childSessions?`。

| 工具 | 語意 | 位置 |
|---|---|---|
| spawn_agent | **parentPath 硬編碼 `"root"`**（:54）；回 `{agent_path, job_id}` | :37-72 |
| wait_agent | **poll 所有 entry `status === "running"`（20ms）**，非 edge event | :75-95 |
| list_agents | path_prefix 過濾 | :97-108 |
| send_message | **queue-only（quiet）**：`append(entry.session, {type:"subagent/inbox", messageId, message})` + `mailbox.push`，無 wake | :110-124 |
| interrupt_agent | `entry.controller.abort()`，agent 保留 | :126-140 |
| followup_task | **queue + wake**：append inbox + mailbox.push + `if (sessionId) driveFollowups(...)` | :142-158 |
| close_agent | abort + unmount + job kill + table.remove + agents.remove | :160-179 |
| resume_agent | resident agent → 直接 re-drive；否則按 role 重建 agent（session 沿用既有） | :181-231 |
| job_output | subagent JobRegistry 優先，`unknown job` → exec 橋接 | :233-262 |
| job_list | subagent + shell 合併 | :264-278 |
| job_kill | jobs.kill，fallback exec.killJob | :280-296 |

`driveFollowups`（:329-378）——**per-child serialized chain**：
- 透過 `entry.followupChain` 串接（`prev.then(...)`，回傳 `.catch(()=>{})`）。
- pending = session events 中 `type==="subagent/inbox" && seq > (lastInboxSeq ?? -1)`。
- 每則 inbox：`lastInboxSeq = ev.seq`；status → running；**每次 turn 換新 AbortController**（interrupt 目標為當前 turn）；job 重開 running→completed/killed/error；成功清除 stale error。
- `entry.followupChain` 一次只跑一個 turn；close 中途移除 entry → 檢查 `deps.table.get(entry.path)` 後停止。
- **cold resume 不重播已消費 inbox**（lastInboxSeq 游標，M9 Task5 修掉 duplicate-turn bug，見 tools.test.ts "cold resume skips a previously-consumed inbox"）。

### 1.8 index.ts（register.ts 併入此檔）

`RegisterSubagentOptions`（:53-67）：`{ providers, exec, parentModel, parentSession, persist?: { coordinator, stateId, parentSessionId }, restoredState? }`。

`registerSubagent`（:75-110）：
- builtin roles seed（除非 restoredState——snapshot roles 為 authority，避免 duplicate）。
- `restoreState` 在 wrap 之前執行（首次 save 就持久化還原態）。
- `wireSubagentPersistence` 包裝 jobs/table/roles。
- `agents = createAgentRegistry()`（M9）；tools = createSubagentTools。
- **childSessions 只在 `opts.persist` 存在時傳遞**（:92-95）→ 有 coordinator 的 spawn 才 durable。
- 工具註冊 `if (!parentRegistry.get(name))` → **idempotent**。

測試覆蓋：child.test.ts（fork/spawn/durable create 參數斷言）、tools.test.ts（serialize followup、interrupt→retry、cold-resume cursor、close mid-drain）、persist.test.ts（round-trip sessionId/roleName/lastInboxSeq）、register.test.ts（idempotent）、jobs.test.ts、roles.test.ts。

## 2. packages/core-session（src/index.ts）

- `SessionEvent` union（:4-22）：turn/start、step/start、user/message（+images, source plugin）、assistant/chunk、assistant/message、tool/call、tool/result、step/end、turn/end、**subagent/inbox {messageId, message}**、compaction/start/end/summary、**sandbox/mode {mode, source?}**（M16）；全部交 `& { ignorable?: true }`。
- `SessionHeader { parentSession?, seedLength?, delegationDepth?, origin? }`（:27-32）；`Session { formatVersion, events, header? }`；`CURRENT_FORMAT_VERSION = 1`。
- `createSession(onAppend?)`：hook 存 WeakMap（:50-53），Session shape 不變。
- `append`（:56-74）：**`seq = session.events.length`**（append 強制賦值，覆寫傳入 seq）；assistant/message 帶 source 拒絕；image 驗證 fail-loud；最後 firing onAppend hook。**subagent/inbox 就是直接進事件 log**。
- `deriveMessages`（:105-160）：user/message→user、assistant/message→assistant、compaction/summary→user（shadow 前置集）、tool pair 緩衝 flush（assistant toolCalls 先、tool results 後）、step/end 觸發 flush；**subagent/inbox 與 sandbox/mode 無分支 → 靜默跳過（model 不可見）**；assistant/chunk 跳過。
- `deriveSearchText`（:165-195）：subagent/inbox → `ev.message`（FTS 可搜）。
- toJSONL/fromJSONL/assertVersion/migrate（:199-236）。
- **事件 map 擴充方式**：無 runtime registration——直接改 union + 相關 chain（append 驗證、deriveMessages、deriveSearchText）。

## 3. packages/session-persistence（+ jsonl/sqlite）

### 3.1 核心（src/index.ts）

```ts
interface PersistenceBackend {          // :24-41
  create(id, meta): Promise<void>
  append(id, events): Promise<void>
  read(id): Promise<{version, events, meta?}>
  list(); repair(id)
  capabilities: { seekableRead, rawArtifacts }
  putDocument(key, data): Promise<void>   // M6 generic doc store
  getDocument(key): Promise<unknown|undefined>
}
interface SessionCoordinator {          // :52-67
  create(meta?): {id}; append; enqueue; load→{session}; list; flush; close
  putDocument; getDocument
}
```

- **KNOWN_EVENT_TYPES gate**（:88-94）：hardcoded 14 字串 Set（含 subagent/inbox；**不含 sandbox/mode**）。
- `guardIgnorable`（:132-139）：KNOWN → 保留；非 KNOWN + `ignorable:true` → **drop**；否則 `throw SessionFormatUnsupportedError("unknown event type ...")`。→ **M19 加 team/* events 若走 coordinator.load 會被擋**，除非 a) 加進 Set（改源碼）b) 標 ignorable（資料被丟）c) 新增 register 擴充點。
- `load`（:158-175）：backend.read → assertVersionSupported → backend.repair → guardIgnorable → migrate（registerUpgrade chain，:78-86）→ header 由 meta 重建。
- **write-behind**：`enqueue` 走 per-session `SessionWriteBehind`（200ms 窗口）；`flush` = quiescence barrier；`close` 全量 flush + cancel timers。`SessionWriteBehind`（write-behind.ts）：pending 佇列、fixed deadline、失敗時把 batch 加回 pending（retention）、background failure 只 report、close 時 barrier 排水。
- `putDocument`（:191-197）：**docChain 序列化**（串行寫入防交錯），失敗只 report **never rejects caller**。
- **已知坑（現存）**：M16 加的 `sandbox/mode` 未進 KNOWN_EVENT_TYPES → 含 sandbox/mode 的 session 在 coordinator.load 會 throw（目前生產路徑沒有真正 append 它，屬潛伏雷）。

### 3.2 JSONL backend（session-persistence-jsonl）

- Session 檔 `<id>.jsonl`；**document sidecar `<key>.doc.jsonl`**（:10-11）——與 session id 同 namespace 但不同副檔名，list() 正確排除（:46-50）。
- `putDocument`：atomic tmp + rename（:86-95）；`getDocument` 讀檔或 undefined。
- `repair`：torn-tail + missingClosers（step/turn 未閉合補 closers；:103-116）。
- `parseHeader`（format.ts）只還原已知 lineage 欄位（unknown 丟棄），formatVersion/sessionId 必填。

### 3.3 SQLite backend（session-persistence-sqlite）

- sessions 表已有 lineage 欄位 + incarnation/revision；events `PRIMARY KEY (session_id, seq)`（schema.ts:102-110）；documents `(key PRIMARY KEY, data)`（:123）。
- `putDocument` = `INSERT ... ON CONFLICT(key) DO UPDATE`（**last-write-wins，無 CAS/revision 檢查**，index.ts:148-151）。
- FTS5 `events_fts` 每事件一列（deriveSearchText）；repair 會重建 FTS。
- SCHEMA_VERSION=2，MIGRATIONS[1] 只建 FTS；`closeSqliteBackends()` 外部釋放點（Windows 檔案鎖）。

## 4. packages/core-plugin（index.ts）

- `PluginContext`（:25-47）：services（register/get，parent chain fallback）、**scope.mount()/unmount()**、on/emit（listener 先跑、其 return 值 seed waterfall；decision 記錄 nearest-wins）、waterfall（**必須呼叫 next，雙次 throw**）、cascade/onCascade（around hooks，root-first 組合，**跳過 next = short-circuit**）、guard/checkGuards（self→root 聯集，first deny wins）、resolveDecision/resolveAncestorDecision（nearest-wins；ancestor-only 供 M13 防 race）、mount(plugin)/unmount(name)。
- `createScope`：child scope 共享 parent service store；`emit` **child→parent 傳播**；scope.unmount() 只 `scopes.delete(ctx)`（:194-201）——**不清理已註冊 tools（child registry 獨立）、不回收 services**。
- unmount(plugin)（:216+）：同步釋放 registry + 呼叫 disposer（5s timeout race）+ 遞迴 nested + 清理 listener/waterfall/cascade。M17/M18 模式 = mount 回傳 handle（connect+register），finally 中反向 unmount（run.ts:296-311）。

## 5. packages/core-agent（index.ts）

- `createAgent(ctx, deps: AgentDeps & AgentConfig)`（:69）；`Agent { run, followup, compact? }`（:61-67）。
- 共享 `runTurn(message, signal?)`（:92-178）：append `turn/start` + `user/message` → step loop（maxTurns 防護、compactor maybeCompact、emit "agent/pre-step"、deriveMessages + **assertMessagesFromLog** 不變量、model.stream、工具批次收集、executeToolCalls M13 併發池、assistant/message、step/end）→ 無 tool call 結束 → `turn/end`。
- **followup = runTurn**：把訊息變成同一 session 的下一個 `user/message` turn；steps/callSeq/reasoning 跨 turn 共享（:114-116）。
- `AgentRegistry`（:179-193）：Map by sessionId，`register/get/remove/entries`，無 disposal 語意。
- execute-tool-calls.ts：M13 bounded pool、model-order commit（head-of-line cursor）、abort 時 `TOOL_ABORTED_BEFORE_DISPATCH`。

## 6. apps/cli/src/run.ts

- **session wire**（:157-166）：`activeId = resumeSessionId ?? sessionId`；`createSession(ev => { coordinator.enqueue(activeId,[ev]); if turn/end → flush })`。
- **恢復路徑（M6/M8/M9）**：
  1. `coordinator.load(resumeSessionId)` → `session.events.push(...restored.events)`（不重 append；durable 已存在），:168-180。
  2. `coordinator.getDocument(activeId)` → `isSubagentStateSnapshot(doc)`（shape guard：formatVersion===1 + jobs/agentTable/roles 皆陣列，:62-70）→ `restoredState`；getDocument 失敗/不符 → undefined（fresh registries），:186-195。
  3. `registerSubagent(ctx, tools, { providers, exec, parentModel, parentSession: session, persist: { coordinator, stateId: activeId, parentSessionId: activeId }, restoredState? })`，:222-235。**document key = session id**（spec：stateId derived from session id）。
  4. **每個有 sessionId 的 restored entry**：`coordinator.load(entry.sessionId)` → 新 mirror session（enqueue+turn/end flush hook）→ push events + formatVersion + header → `entry.session = resumed`（:236-263）。**注意：只重建 session 物件；agents registry 仍空、controller 是 restoreState 的 fresh stub——真正 resume 要等模型呼叫 resume_agent 才重建 agent**。
- M17/M18：mcp/lsp handles mount before run；finally reverse unmount best-effort（:293-311）。

---

## M19 可重用面（現有 subagent 已具備的）

1. **teammate = durable child 的 90% 底子**：spawnChild 已給 `child-<uuid>` 持久 session、lineage header（parentSession/seedLength/origin/delegationDepth）、mirror write-behind、cold-resume 重建（resume_agent），全部可直接作為 team member 的 container。
2. **多輪 driver**：`agent.followup` + `driveFollowups`（per-child serialized chain + fresh AbortController per turn + job 生命週期重開），等於 team member 的「下一 FIFO turn」引擎。
3. **interrupt/resume 全套**：interrupt_agent（保留 alive）、close_agent（資源回收）、resume_agent（resident 或 rebuild），close→resume 語意即 member 移除/重新加入。
4. **durable inbox 游標**：`subagent/inbox` event + `lastInboxSeq` + cold-resume 防重播——正是 mailbox 的 consumption cursor 雛形。
5. **jobs 基礎**：`subagent-N` id、running→completed/killed/error、terminal 保護、wait/read/kill；可擴充為 team task 的 job 表示。
6. **role 抽象**：SubagentRole（tools/systemPrompt/model）即 team member 的 profile（planner/researcher/worker 等）。
7. **快照持久化管道**：wireSubagentPersistence（mutation→putDocument 全量快照）+ restoreState + run.ts 的 stateId=sessionId keying 與 shape guard，M19 可沿用同一 document 機制放 team 投影。
8. **taskName path 空間**：`parentPath/taskName`（spawnChild 支援任意 parentPath，只有工具層硬編碼 "root"）。

## M19 缺口（對照 dsh agent-team，2026-08-20-dsh-rc8-delta.md）

1. **具名 roster 不存在**：名字 = path（`root/<taskName>`），`table.add` 靜默覆蓋同名（agent-table.ts:24-25）；無「名字保留永不重用」語意（dsh：names reserved never reused）、無 provisioning/recovery reconciliation。
2. **跨 session team 域狀態不存在**：subagent 狀態是 `SubagentStateSnapshot` 文件（keyed by sessionId, last-write-wins），**不是** Lead session log events；dsh 的 team 狀態是事件源（team/member、team/message/queued→delivered、task board）。
3. **mailbox 是 per-child 非全域**：目前 inbox 是「目標 child session 內部的 subagent/inbox event」+ `mailbox: string[]` live mirror；dsh 是 Lead-log 全域 mailbox（`team/message/queued` → `delivered` ack）。I-harness 的 send_message **無 delivered 確認、無 retry、無 de-dup**（dsh 有 process-local retry + target-session de-dup）。
4. **task board 完全沒有**：無 team-local task ids、無 monotonic revisions、無 CAS（`expectedRevision`）、無 DAG deps、無 tombstones、無 writeScopes。
5. **waitForChange 不存在**：wait_agent 是 20ms poll 所有 running（tools.ts:75-95）；jobs.wait 是 10ms poll；無 edge-driven blocking（roster/mailbox/task/live-status edges）。
6. **invariant 弱**：restoreState 有 shape guard（run.ts isSubagentStateSnapshot）但**無 event replayer**；snapshot 非 append-only，狀態漂移時無法回溯；無 revision/CAS（SQLite `ON CONFLICT DO UPDATE`）。

## 基礎設施注意事項

1. **KNOWN_EVENT_TYPES 是 closed set，無註冊 API**（session-persistence/src/index.ts:88-94）。新增 `team/*` events 到 lead log 時，三選一：(a) 改 Set（改核心源碼）；(b) 標 `ignorable:true`（load 時被丟棄——**資料會不見，不可用**）；(c) 加 `registerEventType(type)` 擴充點（推薦，M16 sandbox/mode 已暴露此坑：core-session union 有 sandbox/mode 但 Set 沒有 → 含該 event 的 session 在 coordinator.load 會 throw，目前僅因生產尚未真正 append 而沒爆）。
2. **事件 map 擴充慣例**：core-session 手動 union + deriveMessages/deriveSearchText chain。新增 type 若不接 chain = model-hidden（**安全預設**：default 分支跳過，與 subagent/inbox 學到的教訓一致）；若要 FTS 可搜需接 deriveSearchText。
3. **coordinator document keying**：stateId = session id（run.ts:227）；JSONL sidecar `<key>.doc.jsonl` 與 session 檔名不衝突；SQLite 分表。可再開新 key（如 `<sessionId>.team`）放全新 team 投影，不影響既有 subagent 快照。
4. **restoreState shape guard 對新欄位的影響**：guard（run.ts:62-70）只查 3 個陣列存在 + formatVersion===1；M8/M9 加 sessionId/roleName/lastInboxSeq 都是 additive-safe（缺欄位→undefined→可選型別）。若 M19 在 snapshot 加 teams/roster 欄位：a) 維持 formatVersion 1 + additive（舊檔向後相容，但舊 build 讀新檔會自行忽略不認識欄位？——restoreState 直接 map 已知欄位，新增欄位不會 throw）；b) 或 bump formatVersion 2 + guard 需升級（**必須同步改 run.ts guard，否則新版寫 v2、舊版讀 v2 直接被拒或誤判**）。
5. **save 是 fire-and-forget**（persist.ts persistent wrappers `void save()`）：snapshot 持久化不阻塞 hot path，但 spawn 返回時快照可能未落地；team 若需要「任務下達後必定持久」語意（dsh task board CAS），需在 team 層自行 await putDocument 或改用 lead-log events（enqueue 也有 200ms write-behind——真正 durabilty point 是 flush）。
6. **restoreState 的 job id 漂移**：jobs 重新 registerJob 產生新 id，"jobId link 是 advisory"（persist.ts 註解）；team 若要引用 job 需要自己的穩定 id 命名空間。

## 嫁接策略建議

**(a) 獨立 new package `@i-harness/agent-team` 掛在 subagent 之上 — 推薦**

- 重用：`spawnChild`、`driveFollowups` 語意（複製或導出）、`roles`、`jobs`、`agents` registry、child 持久化 mirror。
- 新增於新 package：TeamRoster（名字 registry：唯一 + never-reuse + provisioning/recovery reconciliation，對照 dsh）、全域 mailbox（Lead session events `team/message/queued`→`delivered`，**經 parentSession append 寫入 lead log——主 session 的 mirror hook 免費持久化**）、task board（team-local id + revision + CAS，可放 `<sessionId>.team` document 或完全記憶體+replay）、edge-driven wait（新 package 自帶 emitter，不改 jobs.wait）。
- 重量級觸碰：`KNOWN_EVENT_TYPES` 加法（加 `team/*` 字串或 registerEventType 擴充）+ core-session union 加法；對既有 11 工具零改動；subagent 套件 zero-touch（頂多導出幾個內部函式）。
- 權衡：需在 subagent 公開面加 export（或接受 package 內 import——monorepo 內部可直接 `../subagent/src/*` via workspace? 現有慣例是包內自 import；跨包則需 exports 暴露）。隔離最乾淨，符合 dsh experimental-package policy 先例；回歸風險最小。

**(b) 擴充 subagent package 加 team 模組 — 最省力但污染最深**

- pros：table/jobs/driveFollowups 直接可見、persist.ts 直接擴充 snapshot（加 roster/tasks 欄位）、單一掛載點（run.ts 只改 registerSubagent 選項）。
- cons：SubagentStateSnapshot 契約與 11 工具測試綁死（snapshot formatVersion/restore 游標、send_message 語意、wait_agent 行為都是既有測試斷言）；團隊加成後「subagent」包意義模糊；M19 若退回 snapshot-doc 而非 events，留下的技術債最大。

**(c) 新 package 但重寫持久化為 events — 最對齊但最重**

- pros：完整對齊 dsh lead-log / event-replayer；restore 統一走 coordinator.load（去掉 doc shape guard + last-write-wins）；跨 session team 域狀態真正事件源。
- cons：必須改 KNOWN_EVENT_TYPES + core-session union + deriveMessages 顯式分支 + repair/missingClosers 認知 new types；或完全重構 coordinator；且主 session 的 resume 流程（run.ts:168-180 push events 不重播）不含 team replayer → 需要新 recovery 層。工作量大約 (a) 的 2-3 倍，且動到 6 個已驗證套件的核心。

**結論**：選 **(a) 為主體、(c) 的 lead-log mailbox 子集為輔**——新 package `@i-harness/agent-team`，member 建立/信箱/task 狀態投影的行為**增量寫成 lead session 的 events**（`team/member/provisioned`、`team/message/queued|delivered`、`team/task/*`，經 parentSession append + 既有 write-behind），僅在 session-persistence 加 `registerEventType`（或最小 Set 加法）與 core-session union 加型別；task board 的快照/投影用獨立 document key（`<sessionId>.team`）或純記憶體+重播，不動既有 subagent 快照。理由：durable child 的 spawn/followup/interrupt/resume/inbox cursor 已就緒，唯一真正的架構缺口是「team 域狀態放哪、怎麼唯一命名、怎麼 edge-driven 等待」——lead-log events 讓這三者都有事件源可播（M19 invariant 需求），而對既有行為零破壞；若先做 (b) 會把 11 工具契約與 team 語意耦合，後期要拆更貴。
