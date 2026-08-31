# M26 D — Durable Subagent Task Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 四件同批落地 R-D1..R-D4 —— durable 任務紀錄（state machine + recovery classification）、背景執行 + 父被 wake、取消樹 + 配額、get_task_output/stop_task 控制工具 —— 全部基於 M9 durable inbox / followup driver / M8 child-session / M24a resume 之上擴充，不重製。

**Architecture:** 新建 `@i-harness/subagent` 內建的 task protocol（`task-protocol.ts` store + registry + `task-notification.ts` outbox/drain），持久化走 session-persistence 既有 documents（新 document key `task:<stateId>`，formatVersion 1，與 M6 subagent-state document 同族 —— 零新表、雙後端（jsonl/sqlite）同通）。openocode 的三元 identity（parentSessionID, assistantMessageID, toolCallID）→ IH 的 `(parentSessionId, callEventSeq)`（durable tool/call 事件 seq，append-only 唯一；toolCallId 隨身 metadata + resumd-incarnation 防碰撞 fallback）。spawn 工具變「提交 + 訂閱」，完成經 outbox 通知（A-plan R-A1 admit 合成輸入 + wake；未接 A-plan 時退化為 durable-only 交付，fail-closed 不丟失）；取消樹/配額在 TaskRegistry 中央；R-D5/R-D6 遠期不動。

**Tech Stack:** TypeScript (strict), ESM, pnpm workspace, vitest, node:crypto（既有）, @i-harness/* 既有包。零新外部依賴。

**Spec:** `docs/roadmap/2026-08-31-roadmap-D-subagent.md`（本計畫從該 roadmap 論述；執行者讀 roadmap §2-6 + 本計畫。取捨紀錄：R-D1..R-D4 M26 立即、R-D5/R-D6 遠期）

## Global Constraints

- **零新外部依賴**（只有 `node:crypto` sha256/randomUUID —— 既有已用）
- **ESM + strict TS**（strict/noUnusedLocals/noUnusedParameters；無 enum，型別 union）
- **pnpm workspace**；測試命令統一 `cd packages/<pkg> && pnpm vitest run test/<file>.test.ts`
- **Windows 優先**（所有 vitest 在 win32 跑；無 POSIX-only 代碼）
- **Fail-closed**（爭議/未知一律明確錯誤或 recovery-required；不重發不丟失）
- **M-series 風格**：additive-only 擴充、既有 11 工具簽名不破、`formatVersion: 1` 不 bump、新 session event type 依 M19 team/* 先例（core-session inline union + session-persistence `registerEventType`）、工具名 snake_case、config camelCase
- **既有文件機製不動**：subagent-state snapshot（`SubagentStateSnapshot`）與 `isSubagentStateSnapshot` 驗證不變；task protocol 用**獨立 document**（見 §Storage）
- **本計畫與 A 區協調**：R-D2 消費 R-A1 的輸入接納契約（`ParentInputAdmission`，於 D2-T1 定義）；A-plan 尚未落地時退化為 durable-only + `subagent/end` 日誌事件（自行可測、可提交）
- **R-D5（外部進程子代理 provider）/ R-D6（Ed25519 身份/證明）遠期** —— 本計畫不實作，僅在 §Out of scope 各一行註記

## 1. Exact-Semantics 表（opencode → IH）

| opencode (`task_submission` / `task_notification`) | i-harness 對應 | 位置 |
|---|---|---|
| `(parentSessionID, assistantMessageID, toolCallID)` → submission | `(parentSessionId, callEventSeq)` → `TaskRecord.id`（toolCallId 作 metadata；`callEventSeq` = invoke 的 `tool/call` 事件 seq——append-only session log 內唯一，resume 後 callId 重用不碰撞） | D1-T2/T3 |
| exact retry adopts existing submission | `TaskRegistry.submit` 依 identity 查回既有 record，內容相符（prompt/agent/agentPath/delivery）→ adopted（回既有 task id，不重發 spawn） | D1-T3 |
| conflicting reuse fails (`InvocationConflict`) | 內容不符 → `TaskIdentityConflictError`（絕不採用） | D1-T3 |
| accepted → running → completed/error/cancelled/recovery-required | `TaskStatus`: `accepted → running → completed | error | cancelled | recovery-required`；`outcome === undefined ⇔ 非終態`（CAS 守衛：只有非終態可 terminalize） | D1-T3 |
| one-transaction child settlement + parent notification outbox | `terminalize` 在同一份 document snapshot 內寫下 task outcome + `pending` notification（單次 `putDocument`，天然同文檔原子） | D2-T1 |
| `background: false` escape hatch（completionDelivery=tool） | spawn_agent `background?: boolean`——false = tool body 阻塞至終態並直接回 summary（等於今日 wait_agent target 模式內聯）；true（default）= 立即回 handle | D2-T2 |
| `get_task_output` 1–20 ids、≤600s wait、非自有→identical failure | `get_task_output` `task_ids` 長度 1..20、timeout clamp [100ms, 600000ms]、任何未擁有 id（含 `bash-*` shell id、其他 session id、malformed id）→ 同一錯誤 `unknown task: <id>`（無 oracle；shell 擴充另列 follow-up） | D4-T1 |
| `stop_task` | `stop_task` → cancelTree（取消單筆 + 後代樹） | D4-T2 |
| recovery：ambiguous → recovery-required（不重發） | cold restore 時 `accepted|running` 任務依 durable child log 證據分類：log 有 seedLength 之後的 `turn/end` → `completed`（resultText = 最後 assistant/message）；log 缺/無 child → `recovery-required`（reason `dispatch-unknown`）；log 存在但 turn 未閉 → `recovery-required`（reason `response-interrupted`）；一律不重發 | D1-T5 |
| cancelTree recursive + descendant quiescence | `TaskRegistry.cancelTree`（agentPath 前綴樹 + 單次同文檔取消 mark + parent-delivery notification 入 outbox）+ 工具層 interrupt 既有 `entry.controller` + await `entry.followupChain` | D3-T2 |
| `subagent_max_concurrency` / `subagent_depth` | `maxConcurrency`（新，per-mount 配額 semaphore）/ `maxDepth`（M24a B2 既有，沿用） | D3-T1 |

## 2. Storage 決策：documents 而非新表（含理由）

- session-persistence 已有 generic per-key documents（jsonl 後端 = 檔案；sqlite 後端 = `documents` 表 `(key, data)`，見 `packages/session-persistence-sqlite/src/schema.ts:137-140` + `index.ts:162-169`）。**新增 sqlite 表只會活在 sqlite 後端**，jsonl 後端（M4 官方後端）無法同等覆蓋 —— 破壞後端對等。
- document 走 coordinator 的 `putDocument`（docChain 序列化 + M23 per-key `doc:<key>` lease + failure-report）；與 subagent-state snapshot 完全同一寫路徑、behavior 一致。
- **key**：`task:<stateId>`，與 M6 既有約定（stateId = main session id，run.ts `stateId: activeId`）同族；`SubagentStateSnapshot`（formatVersion 1 + `isSubagentStateSnapshot` 驗證檔）保持原樣 —— 加欄位進舊 doc = 格式變更，故獨立 document。
- 單一 document 載全部 records/notifications：documents store 無 key 枚舉 API（`getDocument` 只能按 key 查），per-task 多文檔無法冷啟列出 —— 與 jobs registry「entire snapshot」規模（per-mount，M6 既有同級）可接受。
- CAS-ish 欄位：`timeCreated/timeStarted/timeCompleted`（opencode `time_created/time_completed` 對位）+ `outcome !== undefined` 終態守衛（terminalize/cancelTree 都是只有 non-terminal 才能變更 —— 等效 CAS，單進程內無 race）。
- 寫入說明：submit/claim/cancel 沿用 M6 pattern `void save()`；**`terminalize` 在 enqueue notification 後 `await save()`**（wake 前的堅持久化點；若 putDocument 失敗，通知發不出——同一 doc 內的 outcome 亦沒寫成，冷啟時由 D1-T5 的 recovery classification 從 child log 自証回補——不重發不丟失的完整鏈）。

## 3. File Structure

**Created：**
- `packages/subagent/src/task-protocol.ts` — TaskStatus/TaskOutcome/TaskRecord/TaskNotificationRecord 型別、TaskProtocolDocument、`taskDocKey`、`notificationMessageId`、`createTaskRegistry`（submit/claim/terminalize/cancelTree/wait + outbox enqueue + doc load/restore/save）、`classifyRestoredTasks`（recovery classification）、`TaskIdentityConflictError`、`TaskConcurrencyLimitError`
- `packages/subagent/src/task-notification.ts` — `ParentInputAdmission`（A-plan 契約）、`renderTaskNotification`、`createNotificationDrain`（enqueue 在 registry；此處只有 delivery：admit → delivered → wake → woken，status-guard idempotent，attempts/error 轉移）
- `packages/subagent/test/task-protocol.test.ts`
- `packages/subagent/test/task-notification.test.ts`
- `packages/subagent/test/task-control.test.ts`（D3 cancelTree/配額 + D4 工具）
- `packages/core-session/test/subagent-event.test.ts`
- `packages/session-persistence/test/subagent-event.test.ts`

**Modified：**
- `packages/subagent/src/child.ts` — `SpawnOptions.onSettled`（additive: 現有 settle handler 尾部呼叫）
- `packages/subagent/src/tools.ts` — spawn_agent（identity 取用 exec、submit→spawn→claim、`background`、`task_id` 回傳）、`get_task_output`、`stop_task`、cancelSubtree、close_agent 終止 task record、SubagentToolDeps 增 `tasks`/`parentNotify`/`maxConcurrency`、subagent/start|end append
- `packages/subagent/src/index.ts` — 建立 task registry + notification drain；`ready` chain 增「task doc restore → classify → drain」；`RegisterSubagentOptions.parentNotify/maxConcurrency`、`RegisterSubagentResult.tasks`
- `packages/core-agent/src/index.ts` — runTurn 的 `BatchCall` push 帶 `eventSeq`
- `packages/core-agent/src/execute-tool-calls.ts` — `BatchCall.eventSeq?`、prepare identity 帶 `callId`/`callEventSeq`
- `packages/core-tools/src/index.ts` — `ToolExec.callId?/callEventSeq?`、`prepare` identity 型別擴大 + exec seeding
- `packages/core-session/src/index.ts` — `SessionEvent` union 增 `subagent/start`、`subagent/end`（inline shapes，M19 先例）；`deriveSearchText` 兩 case
- `packages/session-persistence/src/index.ts` — module-init 增 `registerEventType("subagent/start")`、`registerEventType("subagent/end")`
- `packages/core-agent/test/execute-tool-calls.test.ts`（identity seeding 測試）
- `packages/subagent/test/tools.test.ts`、`test/resume.test.ts`、`test/register.test.ts`（任務相關新例 + 工具數 11→13）
- `packages/subagent/test/child.test.ts`（onSettled 測試）
- `apps/cli/src/run.ts` — `MainOptions.parentNotify?` pass-through

**未動（重要邊界）：** `packages/subagent/src/persist.ts`（snapshot 保持原樣）、`packages/subagent/src/jobs.ts`、`agent-table.ts`、`roles.ts`、`fork.ts`、`packages/agent-team/*`（teams = 協作層，與任務協議「驅動層」共存，無互動修改）、`packages/exec/*`（get_task_output 的 shell extension 為 follow-up）。

## 4. Out of scope（一行註記）

- **R-D5（外部進程子代理）**：dsh 四 provider（claude-code/codex/acp/子進程）遠期——本計畫 spawn 仍為同進程 subagent；provider seam 留給 C 區 SDK 前置（R-C4）。
- **R-D6（agent 身份/證明）**：Ed25519 身份令牌 + 網絡證明遠期——本計畫以「非自有 → identical failure（no oracle）」為本區 fail-closed 姿態。

---

### Task 1: subagent/start|end session event 型別 + load-gate（core-session / session-persistence）

**Files:**
- Modify: `packages/core-session/src/index.ts:35-45`（SessionEvent union，加兩成員）+ `:265-299`（deriveSearchText 兩 case）
- Modify: `packages/session-persistence/src/index.ts:103-136`（KNOWN_EVENT_TYPES 旁 registerEventType 兩行）
- Test: `packages/core-session/test/subagent-event.test.ts`（新）
- Test: `packages/session-persistence/test/subagent-event.test.ts`（新，仿 todo-persistence.test.ts）

**Interfaces:**
- Consumes: `SessionEvent` union、`deriveSearchText`、`registerEventType`（既有）
- Produces（後續任務依賴）：
```ts
// core-session SessionEvent 新增兩成員（log-only；model 經 deriveMessages 不可見）
| { type: "subagent/start"; version: 1; taskId: string; agentPath: string; role: string; description: string; parentSessionId?: string; seq?: number }
| { type: "subagent/end"; version: 1; taskId: string; outcome: "completed" | "error" | "cancelled" | "recovery-required"; resultText?: string; error?: string; seq?: number }
```

- [ ] **Step 1: 寫失敗測試（core-session）**

```ts
// packages/core-session/test/subagent-event.test.ts
import { describe, expect, it } from "vitest"
import { append, createSession, deriveMessages, deriveSearchText } from "../src/index.ts"

describe("subagent/start | subagent/end log events", () => {
  it("appends with seq and stays model-invisible (deriveMessages skips them)", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "spawn now" })
    append(s, { type: "subagent/start", version: 1, taskId: "task-1", agentPath: "root/helper", role: "general", description: "helper", parentSessionId: "s-main" })
    append(s, { type: "subagent/end", version: 1, taskId: "task-1", outcome: "completed", resultText: "done" })
    expect(s.events.map((e) => e.seq)).toEqual([0, 1, 2])
    // log-only: the model surface only sees the user message
    expect(deriveMessages(s).map((m) => m.role)).toEqual(["user"])
    // searchable: description/agentPath and result text are FTS-visible
    expect(deriveSearchText(s.events[1]!)).toContain("helper")
    expect(deriveSearchText(s.events[1]!)).toContain("root/helper")
    expect(deriveSearchText(s.events[2]!)).toBe("done")
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/core-session && pnpm vitest run test/subagent-event.test.ts`
Expected: FAIL — `subagent/start` 不在 SessionEvent union（型別錯誤），typecheck/編譯失敗

- [ ] **Step 3: 實作 core-session**

`packages/core-session/src/index.ts` — 在 SessionEvent union 末尾（`compaction/reset` 之後、team/* 同層）加：

```ts
    // M26 (R-D1): subagent task protocol log events (version 1). INLINED like
    // team/* so core-session stays dependency-free. Log-only (deriveMessages
    // skips them — the parent wake input arrives via the A-plan input tier);
    // subagent/start is appended on task submit, subagent/end on terminalize.
    | { type: "subagent/start"; version: 1; taskId: string; agentPath: string; role: string; description: string; parentSessionId?: string; seq?: number }
    | { type: "subagent/end"; version: 1; taskId: string; outcome: "completed" | "error" | "cancelled" | "recovery-required"; resultText?: string; error?: string; seq?: number }
```

`deriveSearchText`（`packages/core-session/src/index.ts:285-299` 的 switch，`subagent/inbox` case 後）加：

```ts
    case "subagent/start":
      return `${ev.description} ${ev.agentPath}`
    case "subagent/end":
      return ev.resultText ?? ev.error ?? ""
```

- [ ] **Step 4: 跑測試確認通過 + 補 session-persistence 側**

Run: `cd packages/core-session && pnpm vitest run test/subagent-event.test.ts`
Expected: PASS

`packages/session-persistence/src/index.ts`（`registerEventType("todo/write")` 旁）加：

```ts
// M26 (R-D1): subagent task protocol log events — M19 team/* pattern: only
// this package loads on a plain persistence-only path, so without registration
// guardIgnorable would refuse the type at load.
registerEventType("subagent/start")
registerEventType("subagent/end")
```

新建 `packages/session-persistence/test/subagent-event.test.ts`（完全仿 todo-persistence.test.ts —— 真 jsonl backend + enqueue/flush/load round-trip）：

```ts
// M26-D1: subagent/start|end 事件型別 round-trip —— 仿 todo-persistence.test.ts
// 的 team/* 先例：registerEventType 於 module init 已註冊，load gate
// （guardIgnorable）需放行該二型別且不明文 drop。
import { describe, expect, it } from "vitest"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("subagent/* persistence", () => {
  it("survives append + JSONL load (KNOWN_EVENT_TYPES accepts them)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-subagent-event-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir), {})
      const { id } = await coordinator.create({})
      coordinator.enqueue(id, [
        { type: "subagent/start", version: 1, taskId: "task-1", agentPath: "root/helper", role: "general", description: "helper" },
        { type: "subagent/end", version: 1, taskId: "task-1", outcome: "completed", resultText: "done" },
      ])
      await coordinator.flush(id)
      const loaded = await coordinator.load(id)
      expect(loaded.session.events.map((e) => e.type)).toEqual(["subagent/start", "subagent/end"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 5: 跑測試確認通過**

Run: `cd packages/session-persistence && pnpm vitest run test/subagent-event.test.ts && pnpm vitest run test/coordinator.test.ts`
Expected: PASS（既有測試不破 —— 新增 type 無影響）

- [ ] **Step 6: Commit**

```bash
git add packages/core-session/src/index.ts packages/session-persistence/src/index.ts packages/core-session/test/subagent-event.test.ts packages/session-persistence/test/subagent-event.test.ts
git commit -m "feat(M26-D1): subagent/start|end session event types (core-session union + load-gate registration)"
```

---

### Task 2: ToolExec identity —— callId + callEventSeq（core-agent / core-tools）

**Files:**
- Modify: `packages/core-agent/src/index.ts:208-215`（tool_call append 後 capture eventSeq + batch.push）
- Modify: `packages/core-agent/src/execute-tool-calls.ts:5-27,84-95`（BatchCall.eventSeq? + prepare identity）
- Modify: `packages/core-tools/src/index.ts:19-27,195-201,255-258`（ToolExec 兩欄位 + prepare identity 擴大）
- Test: `packages/core-agent/test/execute-tool-calls.test.ts`（增 2 例）

**Interfaces:**
- Consumes: `ToolRegistry.prepare(call, signal?, identity?)`、`executeToolCalls`（既有）
- Produces（D1-T4/D2-T2 依賴——工具 body 用它構成 identity）：
```ts
// core-tools ToolExec（additive 兩欄位）
export interface ToolExec {
  abortSignal?: AbortSignal
  sessionId?: string
  callId?: string        // M26: the executing tool/call id (call_<n>)
  callEventSeq?: number  // M26: durable seq of the tool/call event in the session log
}

// core-agent BatchCall（additive 一欄位）
export interface BatchCall { callId: string; name: string; args: unknown; eventSeq?: number }

// core-tools prepare identity（擴大，相容既有 { sessionId? }）
prepare(call: ToolCall, signal?: AbortSignal, identity?: { sessionId?: string; callId?: string; callEventSeq?: number }): Promise<PreparedCall>
```

- [ ] **Step 1: 寫失敗測試**

`packages/core-agent/test/execute-tool-calls.test.ts` 追加：

```ts
describe("M26 tool identity plumbing", () => {
  it("seeds exec.callId + exec.callEventSeq from the batch", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    const seen: { callId?: string; callEventSeq?: number }[] = []
    tools.register({
      name: "idTool", description: "", inputSchema: {}, isConcurrencySafe: true,
      execute: async (_args, exec) => { seen.push({ callId: exec.callId, callEventSeq: exec.callEventSeq }) },
    })
    // c'tor of BatchCall: eventSeq = the tool/call event's durable seq (0,1 here)
    await executeToolCalls(ctx, session, tools, [
      { callId: "c0", name: "idTool", args: {}, eventSeq: 99 },
      { callId: "c1", name: "idTool", args: {}, eventSeq: 100 },
    ], { maxParallel: 2 })
    expect(seen).toEqual([
      { callId: "c0", callEventSeq: 99 },
      { callId: "c1", callEventSeq: 100 },
    ])
  })

  it("leaves exec.callId/callEventSeq undefined when the batch carries no eventSeq (backward compat)", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    const seen: { callId?: string; callEventSeq?: number }[] = []
    tools.register({
      name: "idTool", description: "", inputSchema: {}, isConcurrencySafe: true,
      execute: async (_args, exec) => { seen.push({ callId: exec.callId, callEventSeq: exec.callEventSeq }) },
    })
    await executeToolCalls(ctx, session, tools, [{ callId: "c0", name: "idTool", args: {} }], { maxParallel: 2 })
    expect(seen).toEqual([{ callId: undefined, callEventSeq: undefined }])
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/core-agent && pnpm vitest run test/execute-tool-calls.test.ts`
Expected: FAIL — `seen` 全 undefined（ToolExec 無 callId/callEventSeq 欄位）

- [ ] **Step 3: 實作 core-tools**

`packages/core-tools/src/index.ts`：

```ts
export interface ToolExec {
  abortSignal?: AbortSignal
  sessionId?: string
  // M26 (R-D1): the executing tool/call identity — seeded by the M13 scheduler
  // so tool bodies can durably key a submission to the invoking log event.
  callId?: string
  callEventSeq?: number
}
```

`prepare` identity 參數型別與 exec seeding（`:195-201,255-258`）：

```ts
async function prepare(call: ToolCall, signal?: AbortSignal, identity?: { sessionId?: string; callId?: string; callEventSeq?: number }): Promise<PreparedCall> {
  // ...existing...
  const exec: ToolExec = {}
  if (signal) exec.abortSignal = signal
  if (identity?.sessionId !== undefined) exec.sessionId = identity.sessionId
  if (identity?.callId !== undefined) exec.callId = identity.callId
  if (identity?.callEventSeq !== undefined) exec.callEventSeq = identity.callEventSeq
  return { call, tool, exec }
}
```

- [ ] **Step 4: 實作 core-agent**

`packages/core-agent/src/execute-tool-calls.ts`：

```ts
export interface BatchCall {
  callId: string
  name: string
  args: unknown
  // M26 (R-D1): durable seq of the invoking tool/call event (set by runTurn;
  // optional so pre-M26 callers / tests keep compiling).
  eventSeq?: number
}

export interface ExecuteToolCallsOptions {
  maxParallel: number
  signal?: AbortSignal
  sessionId?: string
  telemetry?: Telemetry
}
```

`startCall` 預備呼叫（`execute-tool-calls.ts:91`）：

```ts
const prepared = await tools.prepare(
  { name: call.name, args: call.args },
  opts.signal,
  { sessionId: opts.sessionId, callId: call.callId, callEventSeq: call.eventSeq },
)
```

`packages/core-agent/src/index.ts` runTurn tool_call append（`:209-214`）：

```ts
case "tool_call": {
  callSeq += 1
  const callId = `call_${callSeq}`
  // M26 (R-D1): capture the seq BEFORE append — append assigns seq =
  // events.length, so the value below IS the tool/call event's durable seq.
  const eventSeq = deps.session.events.length
  append(deps.session, { type: "tool/call", callId, name: ev.call.name, args: ev.call.args })
  batch.push({ callId, name: ev.call.name, args: ev.call.args, eventSeq })
  toolCallsThisStep += 1
  break
}
```

- [ ] **Step 5: 跑測試確認通過**

Run: `cd packages/core-agent && pnpm vitest run test/execute-tool-calls.test.ts && pnpm vitest run test/agent.test.ts`
Expected: PASS（既有全部不破 —— eventSeq 可選、identity 擴大相容）

- [ ] **Step 6: Commit**

```bash
git add packages/core-tools/src/index.ts packages/core-agent/src/index.ts packages/core-agent/src/execute-tool-calls.ts packages/core-agent/test/execute-tool-calls.test.ts
git commit -m "feat(M26-D1): ToolExec callId/callEventSeq identity plumbing (M13 scheduler + prepare seeding)"
```

---

### Task 3: Task protocol store + registry（task-protocol.ts）

**Files:**
- Create: `packages/subagent/src/task-protocol.ts`
- Test: `packages/subagent/test/task-protocol.test.ts`（新）

**Interfaces:**
- Consumes: `SessionCoordinator.putDocument/getDocument`（既有）、`TaskIdentity`（本 task 定義）
- Produces（D1-T4/T5、D2-T1、D3 全部、D4 依賴）——**本計畫的型別單一來源**：

```ts
export type TaskStatus = "accepted" | "running" | "completed" | "error" | "cancelled" | "recovery-required"
export type TaskOutcome = "completed" | "error" | "cancelled" | "recovery-required"
export type TaskDelivery = "tool" | "parent"
export type RecoveryReason = "dispatch-unknown" | "response-interrupted"
export type OutboxStatus = "pending" | "delivered" | "woken" | "error" | "suppressed"

export interface TaskIdentity {
  parentSessionId: string
  callEventSeq?: number
  toolCallId?: string
}

export interface TaskRecord {
  id: string                    // task-<n> ascending per-mount
  parentSessionId: string
  toolCallId?: string
  callEventSeq?: number
  childSessionId?: string       // child-<uuid> (M8); absent when the spawn was anonymous
  agentPath: string             // "root/<taskName>"
  description: string           // task_name
  prompt: string
  agent: string                 // role name
  delivery: TaskDelivery
  status: TaskStatus
  outcome?: TaskOutcome
  resultText?: string
  error?: string
  recoveryReason?: RecoveryReason
  timeCreated: number
  timeStarted?: number
  timeCompleted?: number
}

export interface TaskNotificationRecord {
  id: string                    // notif-<n> ascending per-mount
  submissionId: string          // the TaskRecord id
  parentSessionId: string
  messageId: string             // msg_task_<sha256(taskId)[:32]> (opencode convention)
  state: TaskOutcome
  description: string
  text: string
  status: OutboxStatus
  attempts: number
  timeCreated: number
  timeDelivered?: number
  timeWoken?: number
  error?: string
}

export interface TaskProtocolDocument {
  formatVersion: 1
  tasks: TaskRecord[]
  notifications: TaskNotificationRecord[]
}

export function taskDocKey(stateId: string): string
export function notificationMessageId(taskId: string): string
export class TaskIdentityConflictError extends Error { constructor(readonly identity: TaskIdentity) }
export class TaskConcurrencyLimitError extends Error { constructor(readonly limit: number) }

export interface TaskSubmissionInput {
  identity: TaskIdentity
  childSessionId?: string
  agentPath: string
  description: string
  prompt: string
  agent: string
  delivery: TaskDelivery
}

export interface TaskTerminalizeInput {
  taskId: string
  outcome: TaskOutcome
  resultText?: string
  error?: string
  recoveryReason?: RecoveryReason
}

export interface TaskRegistryOptions {
  coordinator?: SessionCoordinator
  stateId?: string            // with coordinator → doc key = task:<stateId>
  maxConcurrency?: number     // default Infinity (D3-T1 permit; enforced in submit)
  onTerminalized?: (task: TaskRecord) => void  // D2-T1: after save, drain trigger
}

export interface TaskRegistry {
  submit(input: TaskSubmissionInput): TaskRecord    // throws TaskIdentityConflictError / TaskConcurrencyLimitError
  get(taskId: string): TaskRecord | undefined
  getByIdentity(identity: TaskIdentity): TaskRecord | undefined
  getByChildSession(childSessionId: string): TaskRecord | undefined
  list(): TaskRecord[]
  notifications(): TaskNotificationRecord[]
  updateNotification(id: string, patch: Partial<Omit<TaskNotificationRecord, "id" | "submissionId">>): boolean
  claim(taskId: string, childSessionId?: string): boolean
  terminalize(input: TaskTerminalizeInput): boolean
  cancelTree(taskId: string, error?: string): { taskIds: string[]; cancelled: number }
  runningCount(): number
  wait(taskId: string, timeoutMs: number): Promise<TaskRecord | undefined>
  restore(doc: TaskProtocolDocument): void
  save(): Promise<void>
}

export async function classifyRestoredTasks(tasks: TaskRegistry, coordinator: SessionCoordinator): Promise<number>
```

- [ ] **Step 1: 寫失敗測試**

`packages/subagent/test/task-protocol.test.ts`：

```ts
import { describe, expect, it } from "vitest"
import { createTaskRegistry, taskDocKey, notificationMessageId, TaskIdentityConflictError, TaskConcurrencyLimitError } from "../src/task-protocol.ts"

function fakePersist(records: unknown[] = []) {
  const saved: unknown[] = []
  return {
    saved,
    coord: {
      putDocument: async (_k: string, data: unknown) => { saved.push(data) },
      getDocument: async () => records[0],
    } as never,
  }
}

describe("task protocol store", () => {
  it("taskDocKey namespaces by stateId", () => {
    expect(taskDocKey("sess-main")).toBe("task:sess-main")
  })

  it("submit creates an accepted record; exact retry adopts; conflicting reuse fails", () => {
    const { coord } = fakePersist()
    const tasks = createTaskRegistry({ coordinator: coord as never })
    const identity = { parentSessionId: "s-main", callEventSeq: 7, toolCallId: "call_4" }
    const input = { identity, agentPath: "root/helper", description: "helper", prompt: "probe the repo", agent: "general", delivery: "parent" }
    const first = tasks.submit(input)
    expect(first.id).toBe("task-1")
    expect(first.status).toBe("accepted")
    expect(first.timeCreated).toBeGreaterThan(0)
    // exact retry → adopted (same object, no second record)
    const again = tasks.submit(input)
    expect(again).toBe(first)
    expect(tasks.list()).toHaveLength(1)
    // conflicting reuse (different prompt) → TaskIdentityConflictError
    expect(() => tasks.submit({ ...input, prompt: "something else" })).toThrow(TaskIdentityConflictError)
  })

  it("an anonymous identity (no seq/callId) always mints a new task", () => {
    const { coord } = fakePersist()
    const tasks = createTaskRegistry({ coordinator: coord as never })
    const a = tasks.submit({ identity: { parentSessionId: "" }, agentPath: "root/a", description: "a", prompt: "p", agent: "general", delivery: "tool" })
    const b = tasks.submit({ identity: { parentSessionId: "" }, agentPath: "root/b", description: "b", prompt: "p", agent: "general", delivery: "tool" })
    expect(a.id).not.toBe(b.id)
  })

  it("claim transitions accepted→running and sets childSessionId; terminalize is CAS (non-terminal only)", () => {
    const { coord } = fakePersist()
    const tasks = createTaskRegistry({ coordinator: coord as never })
    const rec = tasks.submit({ identity: { parentSessionId: "s-main", callEventSeq: 1 }, agentPath: "root/h", description: "h", prompt: "p", agent: "general", delivery: "tool" })
    expect(tasks.claim(rec.id, "child-1")).toBe(true)
    expect(tasks.get(rec.id)!.status).toBe("running")
    expect(tasks.get(rec.id)!.childSessionId).toBe("child-1")
    // re-claim: already running → false
    expect(tasks.claim(rec.id)).toBe(false)
    expect(tasks.terminalize({ taskId: rec.id, outcome: "completed", resultText: "done" })).toBe(true)
    expect(tasks.get(rec.id)!.outcome).toBe("completed")
    expect(tasks.get(rec.id)!.status).toBe("completed")
    expect(tasks.get(rec.id)!.timeCompleted).toBeGreaterThan(0)
    // CAS: terminalized once — a second terminalize is a no-op
    expect(tasks.terminalize({ taskId: rec.id, outcome: "error", error: "late" })).toBe(false)
    expect(tasks.get(rec.id)!.outcome).toBe("completed")
  })

  it("terminalize enqueues a durable notification for parent-delivery tasks (same record state)", () => {
    const { coord } = fakePersist()
    const tasks = createTaskRegistry({ coordinator: coord as never })
    const rec = tasks.submit({ identity: { parentSessionId: "s-main", callEventSeq: 2 }, agentPath: "root/h", description: "h", prompt: "p", agent: "general", delivery: "parent" })
    tasks.terminalize({ taskId: rec.id, outcome: "completed", resultText: "ok" })
    const notifs = tasks.notifications()
    expect(notifs).toHaveLength(1)
    expect(notifs[0]).toMatchObject({ submissionId: rec.id, parentSessionId: "s-main", status: "pending", attempts: 0, state: "completed" })
    expect(notifs[0]!.id).toMatch(/^notif-/)
    expect(notifs[0]!.messageId).toBe(notificationMessageId(rec.id))
    expect(notifs[0]!.messageId).toMatch(/^msg_task_[0-9a-f]{32}$/)
    // tool-delivery tasks never notify
    const rec2 = tasks.submit({ identity: { parentSessionId: "s-main", callEventSeq: 3 }, agentPath: "root/h2", description: "h2", prompt: "p", agent: "general", delivery: "tool" })
    tasks.terminalize({ taskId: rec2.id, outcome: "error", error: "boom" })
    expect(tasks.notifications()).toHaveLength(1)
  })

  it("wait resolves with the terminal record or undefined on timeout", async () => {
    const { coord } = fakePersist()
    const tasks = createTaskRegistry({ coordinator: coord as never })
    const rec = tasks.submit({ identity: { parentSessionId: "s-main", callEventSeq: 4 }, agentPath: "root/h", description: "h", prompt: "p", agent: "general", delivery: "tool" })
    const pending = tasks.wait(rec.id, 30)
    tasks.terminalize({ taskId: rec.id, outcome: "completed", resultText: "ok" })
    const settled = await pending
    expect(settled?.outcome).toBe("completed")
    expect(await tasks.wait(rec.id, 10)).toBeDefined()
    expect(await tasks.wait("task-999", 10)).toBeUndefined()
  })

  it("save persists formatVersion-1 doc with tasks + notifications; restore round-trips", async () => {
    const p = fakePersist()
    let tasks = createTaskRegistry({ coordinator: p.coord as never })
    tasks.submit({ identity: { parentSessionId: "s-main", callEventSeq: 5 }, agentPath: "root/h", description: "h", prompt: "p", agent: "general", delivery: "parent" })
    await tasks.save()
    const doc = p.saved[0] as { formatVersion: number; tasks: unknown[]; notifications: unknown[] }
    expect(doc.formatVersion).toBe(1)
    expect(doc.tasks).toHaveLength(1)
    const fresh = createTaskRegistry({ coordinator: p.coord as never })
    fresh.restore(doc as never)
    expect(fresh.get("task-1")?.prompt).toBe("p")
    expect(fresh.notifications()).toHaveLength(0)
  })

  it("maxConcurrency fails closed on submit (non-terminal count)", () => {
    const { coord } = fakePersist()
    const tasks = createTaskRegistry({ coordinator: coord as never, maxConcurrency: 1 })
    tasks.submit({ identity: { parentSessionId: "s-main", callEventSeq: 6 }, agentPath: "root/a", description: "a", prompt: "p", agent: "general", delivery: "tool" })
    expect(() =>
      tasks.submit({ identity: { parentSessionId: "s-main", callEventSeq: 7 }, agentPath: "root/b", description: "b", prompt: "p", agent: "general", delivery: "tool" }),
    ).toThrow(TaskConcurrencyLimitError)
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/subagent && pnpm vitest run test/task-protocol.test.ts`
Expected: FAIL — `../src/task-protocol.ts` 不存在

- [ ] **Step 3: 實作 task-protocol.ts**

```ts
import { createHash, randomUUID } from "node:crypto"
import type { SessionCoordinator } from "@i-harness/session-persistence"

export type TaskStatus = "accepted" | "running" | "completed" | "error" | "cancelled" | "recovery-required"
export type TaskOutcome = "completed" | "error" | "cancelled" | "recovery-required"
export type TaskDelivery = "tool" | "parent"
export type RecoveryReason = "dispatch-unknown" | "response-interrupted"
export type OutboxStatus = "pending" | "delivered" | "woken" | "error" | "suppressed"

export interface TaskIdentity { parentSessionId: string; callEventSeq?: number; toolCallId?: string }
export interface TaskRecord {
  id: string
  parentSessionId: string
  toolCallId?: string
  callEventSeq?: number
  childSessionId?: string
  agentPath: string
  description: string
  prompt: string
  agent: string
  delivery: TaskDelivery
  status: TaskStatus
  outcome?: TaskOutcome
  resultText?: string
  error?: string
  recoveryReason?: RecoveryReason
  timeCreated: number
  timeStarted?: number
  timeCompleted?: number
}
export interface TaskNotificationRecord {
  id: string
  submissionId: string
  parentSessionId: string
  messageId: string
  state: TaskOutcome
  description: string
  text: string
  status: OutboxStatus
  attempts: number
  timeCreated: number
  timeDelivered?: number
  timeWoken?: number
  error?: string
}
export interface TaskProtocolDocument { formatVersion: 1; tasks: TaskRecord[]; notifications: TaskNotificationRecord[] }

export function taskDocKey(stateId: string): string { return `task:${stateId}` }

export function notificationMessageId(taskId: string): string {
  return `msg_task_${createHash("sha256").update(taskId).digest("hex").slice(0, 32)}`
}

export class TaskIdentityConflictError extends Error {
  constructor(readonly identity: TaskIdentity) {
    super(`task identity conflict: ${identity.parentSessionId}:${identity.callEventSeq ?? identity.toolCallId ?? "anon"}`)
    this.name = "TaskIdentityConflictError"
  }
}
export class TaskConcurrencyLimitError extends Error {
  constructor(readonly limit: number) {
    super(`subagent concurrency limit reached (max ${limit})`)
    this.name = "TaskConcurrencyLimitError"
  }
}

export interface TaskSubmissionInput {
  identity: TaskIdentity
  childSessionId?: string
  agentPath: string
  description: string
  prompt: string
  agent: string
  delivery: TaskDelivery
}
export interface TaskTerminalizeInput {
  taskId: string
  outcome: TaskOutcome
  resultText?: string
  error?: string
  recoveryReason?: RecoveryReason
}
export interface TaskRegistryOptions {
  coordinator?: SessionCoordinator
  stateId?: string
  maxConcurrency?: number
  onTerminalized?: (task: TaskRecord) => void
}
export interface TaskRegistry {
  submit(input: TaskSubmissionInput): TaskRecord
  get(taskId: string): TaskRecord | undefined
  getByIdentity(identity: TaskIdentity): TaskRecord | undefined
  getByChildSession(childSessionId: string): TaskRecord | undefined
  list(): TaskRecord[]
  notifications(): TaskNotificationRecord[]
  updateNotification(id: string, patch: Partial<Omit<TaskNotificationRecord, "id" | "submissionId">>): boolean
  claim(taskId: string, childSessionId?: string): boolean
  terminalize(input: TaskTerminalizeInput): boolean
  cancelTree(taskId: string, error?: string): { taskIds: string[]; cancelled: number }
  runningCount(): number
  wait(taskId: string, timeoutMs: number): Promise<TaskRecord | undefined>
  restore(doc: TaskProtocolDocument): void
  save(): Promise<void>
}

export function createTaskRegistry(opts: TaskRegistryOptions = {}): TaskRegistry {
  const records = new Map<string, TaskRecord>()
  const byIdentity = new Map<string, TaskRecord>()
  const byChild = new Map<string, TaskRecord>()
  const notifs: TaskNotificationRecord[] = []
  const maxConcurrency = opts.maxConcurrency ?? Infinity
  // Ruling M24a-T1a 同款：restore 時以已知最大編號 seed counter（M26-D1）
  let taskCounter = 0
  let notifCounter = 0
  let anonCounter = 0
  let saveChain: Promise<void> = Promise.resolve()

  function identityKey(identity: TaskIdentity): string {
    if (identity.callEventSeq !== undefined) return `${identity.parentSessionId}:${identity.callEventSeq}`
    if (identity.toolCallId !== undefined) return `${identity.parentSessionId}:call:${identity.toolCallId}`
    anonCounter += 1
    return `anon:${anonCounter}` // 每次全新 → 永不 adopt；identity-less 提交的逃逸規則
  }

  function matches(existing: TaskRecord, input: TaskSubmissionInput): boolean {
    return (
      existing.prompt === input.prompt &&
      existing.agent === input.agent &&
      existing.agentPath === input.agentPath &&
      existing.delivery === input.delivery
    )
  }

  function snapshot(): TaskProtocolDocument {
    return { formatVersion: 1, tasks: [...records.values()], notifications: [...notifs] }
  }

  function save(): Promise<void> {
    if (!opts.coordinator || !opts.stateId) return Promise.resolve()
    const p = saveChain.then(() => opts.coordinator!.putDocument(taskDocKey(opts.stateId!), snapshot()))
    saveChain = p.catch(() => {}) // M6: report, never reject
    return p
  }

  function enqueueNotification(task: TaskRecord): void {
    if (task.delivery !== "parent" || task.outcome === undefined) return
    notifCounter += 1
    const text = task.outcome === "completed"
      ? task.resultText ?? ""
      : task.error ?? task.resultText ?? ""
    notifs.push({
      id: `notif-${notifCounter}`,
      submissionId: task.id,
      parentSessionId: task.parentSessionId,
      messageId: notificationMessageId(task.id),
      state: task.outcome,
      description: task.description,
      text,
      status: "pending",
      attempts: 0,
      timeCreated: Date.now(),
    })
  }

  function terminalize(input: TaskTerminalizeInput): boolean {
    const t = records.get(input.taskId)
    if (!t || t.outcome !== undefined) return false // CAS: only non-terminal settles
    t.status = input.outcome
    t.outcome = input.outcome
    if (input.resultText !== undefined) t.resultText = input.resultText
    if (input.error !== undefined) t.error = input.error
    if (input.recoveryReason !== undefined) t.recoveryReason = input.recoveryReason
    t.timeCompleted = Date.now()
    enqueueNotification(t)
    void save()
    opts.onTerminalized?.(t)
    return true
  }

  return {
    submit(input) {
      // R-D3 配額：running(非終態) 計數 >= max → fail-closed
      if (runningCountUnsafe() >= maxConcurrency) throw new TaskConcurrencyLimitError(maxConcurrency)
      const key = identityKey(input.identity)
      const existing = byIdentity.get(key)
      if (existing) {
        if (matches(existing, input)) return existing // exact retry → adopt
        throw new TaskIdentityConflictError(input.identity)
      }
      taskCounter += 1
      const record: TaskRecord = {
        id: `task-${taskCounter}`,
        parentSessionId: input.identity.parentSessionId,
        ...(input.identity.toolCallId !== undefined ? { toolCallId: input.identity.toolCallId } : {}),
        ...(input.identity.callEventSeq !== undefined ? { callEventSeq: input.identity.callEventSeq } : {}),
        ...(input.childSessionId !== undefined ? { childSessionId: input.childSessionId } : {}),
        agentPath: input.agentPath,
        description: input.description,
        prompt: input.prompt,
        agent: input.agent,
        delivery: input.delivery,
        status: "accepted",
        timeCreated: Date.now(),
      }
      records.set(record.id, record)
      byIdentity.set(key, record)
      if (record.childSessionId) byChild.set(record.childSessionId, record)
      void save()
      return record
    },
    get: (taskId) => records.get(taskId),
    getByIdentity(identity) { return byIdentity.get(identityKey(identity)) },
    getByChildSession: (childSessionId) => byChild.get(childSessionId),
    list: () => [...records.values()],
    notifications: () => [...notifs],
    updateNotification(id, patch) {
      const n = notifs.find((x) => x.id === id)
      if (!n) return false
      Object.assign(n, patch)
      void save()
      return true
    },
    claim(taskId, childSessionId) {
      const t = records.get(taskId)
      if (!t || t.status !== "accepted") return false
      t.status = "running"
      t.timeStarted = Date.now()
      if (childSessionId !== undefined && t.childSessionId === undefined) {
        t.childSessionId = childSessionId
        byChild.set(childSessionId, t)
      }
      void save()
      return true
    },
    terminalize,
    cancelTree(taskId, error = "task cancelled by owner") {
      const root = records.get(taskId)
      if (!root) return { taskIds: [], cancelled: 0 }
      const tree = [root, ...[...records.values()].filter((r) => r.agentPath.startsWith(`${root.agentPath}/`))]
      const taskIds: string[] = []
      let cancelled = 0
      for (const t of tree) {
        if (t.outcome !== undefined) continue
        t.status = "cancelled"
        t.outcome = "cancelled"
        t.error = error
        t.timeCompleted = Date.now()
        enqueueNotification(t)
        taskIds.push(t.id)
        cancelled += 1
      }
      if (cancelled > 0) void save()
      return { taskIds, cancelled }
    },
    runningCount: runningCountUnsafe,
    async wait(taskId, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      while (true) {
        const t = records.get(taskId)
        if (!t || t.outcome !== undefined) return t
        if (Date.now() >= deadline) return t
        await new Promise((r) => setTimeout(r, 20))
      }
    },
    restore(doc) {
      // Counter seeding（Ruling M24a-T1a 同款）：還原的 id 是權威——task-<n> /
      // notif-<n> 從已知最大編號續增，避免 post-restore spawn 撞 id。
      for (const t of doc.tasks) {
        const m = /^task-(\d+)$/.exec(t.id)
        if (m) taskCounter = Math.max(taskCounter, Number(m[1]))
      }
      for (const n of doc.notifications) {
        notifs.push(n)
        const m = /^notif-(\d+)$/.exec(n.id)
        if (m) notifCounter = Math.max(notifCounter, Number(m[1]))
      }
      // anonymous 還原記錄用獨立命名空間（restored-anon:N），永不與新
      // anonymous submit 的 anon:<n> 相撞——anonymous 任務永不 adopt（Task 3 規約）。
      let restoredAnon = 0
      for (const t of doc.tasks) {
        if (records.has(t.id)) throw new Error(`duplicate task id on restore: ${t.id}`)
        records.set(t.id, t)
        const anon = t.callEventSeq === undefined && t.toolCallId === undefined
        if (anon) restoredAnon += 1
        byIdentity.set(
          t.callEventSeq !== undefined
            ? `${t.parentSessionId}:${t.callEventSeq}`
            : t.toolCallId !== undefined
              ? `${t.parentSessionId}:call:${t.toolCallId}`
              : `restored-anon:${restoredAnon}`,
          t,
        )
        if (t.childSessionId) byChild.set(t.childSessionId, t)
      }
    },
    save,
  }

  function runningCountUnsafe(): number {
    let n = 0
    for (const t of records.values()) if (t.status === "accepted" || t.status === "running") n += 1
    return n
  }
}

export async function classifyRestoredTasks(tasks: TaskRegistry, coordinator: SessionCoordinator): Promise<number> {
  let classified = 0
  for (const t of tasks.list()) {
    if (t.outcome !== undefined) continue
    const evidence = t.childSessionId === undefined
      ? undefined
      : await completedTurnEvidence(coordinator, t.childSessionId)
    if (evidence === undefined || evidence.turnEnd === false) {
      tasks.terminalize({
        taskId: t.id,
        outcome: "recovery-required",
        recoveryReason: evidence === undefined ? "dispatch-unknown" : "response-interrupted",
        error: "process restarted before the attempt settled",
      })
    } else {
      tasks.terminalize({ taskId: t.id, outcome: "completed", resultText: evidence.lastAssistantText })
    }
    classified += 1
  }
  return classified
}

async function completedTurnEvidence(
  coordinator: SessionCoordinator,
  sessionId: string,
): Promise<{ turnEnd: boolean; lastAssistantText?: string } | undefined> {
  try {
    const { session } = await coordinator.load(sessionId)
    const seedLength = session.header?.seedLength ?? 0
    const after = session.events.slice(seedLength)
    const turnEnd = after.some((e) => e.type === "turn/end")
    const lastAssistant = after.filter((e) => e.type === "assistant/message").at(-1)
    return {
      turnEnd,
      ...(turnEnd && lastAssistant ? { lastAssistantText: lastAssistant.text } : {}),
    }
  } catch {
    return undefined // log 缺/損 → dispatch-unknown（呼叫端 reclassify）
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd packages/subagent && pnpm vitest run test/task-protocol.test.ts`
Expected: PASS（11 例）

- [ ] **Step 5: Commit**

```bash
git add packages/subagent/src/task-protocol.ts packages/subagent/test/task-protocol.test.ts
git commit -m "feat(M26-D1): task protocol store + registry — submit/exact-retry/conflict/claim/terminalize CAS + notification enqueue + recovery evidence helpers"
```

---

### Task 4: spawnChild onSettled seam + spawn_agent task wiring

**Files:**
- Modify: `packages/subagent/src/child.ts:14-32,104-142`（SpawnOptions.onSettled + 兩 settle 路徑呼叫）
- Modify: `packages/subagent/src/tools.ts:48-110`（spawn tool：identity、submit→spawn→claim、subagent/start、task_id + background param）
- Modify: `packages/subagent/src/index.ts`（SubagentToolDeps.tasks）
- Test: `packages/subagent/test/child.test.ts`（onSettled 例）、`test/tools.test.ts`（spawn_agent task 記錄例）

**Interfaces:**
- Consumes: `TaskRegistry.submit/claim/terminalize`（Task 3）、`ToolExec.callId/callEventSeq`（Task 2）、`SubagentToolDeps`（既有）
- Produces（D2/D3/D4 依賴）：
```ts
// child.ts（additive）
export interface SpawnOptions {
  // ...既有欄位
  onSettled?: (info: { finalText?: string; error?: string; aborted: boolean }) => void
}

// tools.ts SubagentToolDeps 增（additive）
tasks: TaskRegistry
// tool.ts spawn_agent 新輸出欄位（additive）：
// { agent_path: string; job_id: string; task_id: string; background?: boolean }
```

- [ ] **Step 1: 寫失敗測試（child.test.ts 追加）**

```ts
describe("spawnChild onSettled seam (M26-D1)", () => {
  it("fires onSettled after a completed initial run with finalText", async () => {
    const ctx = createContext()
    const parentReg = createToolRegistry(ctx)
    parentReg.register(makeTool("read"))
    const roles = createRoleRegistry()
    roles.register({ name: "general", description: "d", systemPrompt: "p", tools: [] })
    const jobs = createJobRegistry()
    const table = createAgentTable()
    const model = createMockClient([{ role: "assistant", text: "ok" }])
    const settled: { finalText?: string; error?: string; aborted: boolean }[] = []
    const { path } = await spawnChild({
      taskName: "helper", message: "hi", parentPath: "root", parentRegistry: parentReg,
      parentSession: createSession(), parentCtx: ctx, role: roles.get("general")!,
      parentModel: model, providers: createProviderRegistry(), jobs, table,
      agents: createAgentRegistry(),
      onSettled: (info) => { settled.push(info) },
    })
    expect(path).toBe("root/helper")
    await new Promise((r) => setTimeout(r, 150))
    expect(settled).toHaveLength(1)
    expect(settled[0]).toEqual({ finalText: "ok", aborted: false })
  }, 10_000)
})
```

`tools.test.ts` 追加（task 記錄 + adopt/conflict + task_id）：

```ts
describe("M26-D1 spawn_agent task records", () => {
  it("submit→spawn→claim; returns task_id; terminalize lands in the registry", async () => {
    const { ctx, table, jobs, roles, parentReg, session, providers, model, exec } = setup()
    const tasks = createTaskRegistry()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers, exec, agents: createAgentRegistry(), tasks })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const out = await spawn.execute({ message: "do it", task_name: "helper" }, { sessionId: "s-main", callId: "call_1", callEventSeq: 9 })
    expect(out).toMatchObject({ agent_path: "root/helper", task_id: "task-1" })
    expect((out as { job_id: string }).job_id).toMatch(/^subagent-\d+$/)
    expect(tasks.get("task-1")).toMatchObject({ parentSessionId: "s-main", callEventSeq: 9, agentPath: "root/helper" })
    await new Promise((r) => setTimeout(r, 150))
    expect(tasks.get("task-1")!.outcome).toBe("completed")
    expect(tasks.get("task-1")!.resultText).toBe("child done")
    // claim 的狀態轉移已發生（record 現在是 running/terminal 而非 accepted）
    expect(["running", "completed"]).toContain(tasks.get("task-1")!.status)
  }, 15_000)

  it("exact-retry adopts the existing task (no re-spawn); conflicting reuse throws", async () => {
    const { ctx, table, jobs, roles, parentReg, session, providers, model, exec } = setup()
    const tasks = createTaskRegistry()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers, exec, agents: createAgentRegistry(), tasks })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const a = await spawn.execute({ message: "same", task_name: "h" }, { sessionId: "s-main", callEventSeq: 3 })
    const b = await spawn.execute({ message: "same", task_name: "h" }, { sessionId: "s-main", callEventSeq: 3 })
    expect(b.task_id).toBe(a.task_id)
    expect(tasks.list()).toHaveLength(1)
    await expect(spawn.execute({ message: "different", task_name: "h" }, { sessionId: "s-main", callEventSeq: 3 })).rejects.toThrow(/identity conflict/i)
  }, 15_000)
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/subagent && pnpm vitest run test/child.test.ts test/tools.test.ts`
Expected: FAIL — `onSettled`/`tasks` 不存在；`TaskIdentityConflictError` 未餵出

- [ ] **Step 3: 實作 child.ts**

`SpawnOptions` 加：

```ts
// M26-D1: settle callback — fires once when the initial run settles (the
// task protocol's spawn record transitions on it). Additive: absent = today.
onSettled?: (info: { finalText?: string; error?: string; aborted: boolean }) => void
```

兩個 settle handler（`:123-142`）尾端加：

```ts
initialRun.then(
  (result) => {
    // ...既有 entry/jobs 更新...
    opts.onSettled?.({ finalText: result.finalText, aborted: false })
  },
  (err) => {
    const aborted = controller.signal.aborted
    // ...既有 entry/jobs 更新...
    opts.onSettled?.({ error: err instanceof Error ? err.message : String(err), aborted })
  },
)
```

- [ ] **Step 4: 實作 tools.ts + index.ts**

`SubagentToolDeps` 加：`tasks: TaskRegistry`（import `TaskRegistry, TaskIdentity` from `./task-protocol.ts`）。

imports（tools.ts 頂部）加：

```ts
import { TaskIdentityConflictError, type TaskIdentity, type TaskOutcome, type TaskRecord, type TaskRegistry } from "./task-protocol.ts"
```

（tools.ts 只 type-import registry；`TaskIdentityConflictError` runtime 值用於包裝錯誤訊息。）

spawn tool 改為：

```ts
const spawnTool: Tool<
  { message: string; task_name: string; agent_type?: string; fork_turns?: string | number; background?: boolean },
  { agent_path: string; job_id: string; task_id: string; status?: string; outcome?: string; resultText?: string; error?: string; message?: string }
> = {
  name: "spawn_agent",
  description: "Launch a subagent. Returns an agent path, job id, and durable task id immediately (background: true, default). With background: false the call blocks until the task settles (escape hatch) and returns its summary.",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Initial task for the subagent." },
      task_name: { type: "string", description: "Short name used in the agent path." },
      agent_type: { type: "string", description: "Role name (default general)." },
      fork_turns: { type: ["string", "number"], description: "none, all, or N." },
      background: { type: "boolean", description: "false = block until the task settles (escape hatch); default true = return immediately and notify the parent on completion." },
    },
    required: ["message", "task_name"],
  },
  isReadOnly: false,
  execute: async (args, exec) => {
    const role = deps.roles.get(args.agent_type ?? "general")
    if (!role) throw new Error(`unknown role: ${args.agent_type}`)
    // ...既有 M24a B2 maxDepth guard 原樣...
    const callerDepth = deps.parentSession.header?.delegationDepth ?? 0
    const maxDepth = deps.maxDepth ?? 1
    if (callerDepth >= maxDepth) {
      throw new Error(`subagent nesting depth limit reached (max ${maxDepth}) — cannot spawn from depth ${callerDepth}`)
    }
    const turns = parseForkTurns(args.fork_turns)
    const delivery = args.background === false ? "tool" : "parent"
    // M26-D1 三元 identity（exact-semantics 表）：callEventSeq 唯一；toolCallId 隨身。
    const identity: TaskIdentity = {
      parentSessionId: exec.sessionId ?? deps.childSessions?.parentSessionId ?? "",
      ...(exec.callEventSeq !== undefined ? { callEventSeq: exec.callEventSeq } : {}),
      ...(exec.callId !== undefined ? { toolCallId: exec.callId } : {}),
    }
    let task: TaskRecord
    try {
      task = deps.tasks.submit({
        identity,
        agentPath: `root/${args.task_name}`,
        description: args.task_name,
        prompt: args.message,
        agent: role.name,
        delivery,
      })
    } catch (err) {
      if (err instanceof TaskIdentityConflictError) throw new Error(`task identity conflict for this call: ${err.message}`)
      throw err
    }
    append(deps.parentSession, { type: "subagent/start", version: 1, taskId: task.id, agentPath: task.agentPath, role: role.name, description: args.task_name, ...(identity.parentSessionId !== "" ? { parentSessionId: identity.parentSessionId } : {}) })
    const executed = await spawnChild({
      taskName: args.task_name,
      message: args.message,
      parentPath: "root",
      parentRegistry: deps.parentRegistry,
      parentSession: deps.parentSession,
      parentCtx: deps.parentCtx,
      role,
      parentModel: deps.parentModel,
      providers: deps.providers,
      jobs: deps.jobs,
      table: deps.table,
      agents: deps.agents,
      forkTurns: turns,
      childSessions: deps.childSessions,
      onSettled: (info) => {
        // M26-D1: settle → terminalize（interrupt 中止的初始 turn 視為 cancelled——
        // 被等待的回答不會到來；後續 followup 沿用 M9 job 流，不再入本 task）。
        const outcome: TaskOutcome = info.aborted
          ? "cancelled"
          : info.error !== undefined && info.finalText === undefined
            ? "error"
            : "completed"
        deps.tasks.terminalize({
          taskId: task.id,
          outcome,
          ...(info.finalText !== undefined ? { resultText: info.finalText } : {}),
          ...(info.error !== undefined ? { error: info.error } : {}),
        })
        // subagent/end —— parent 側的 durable 記號（D2 通知的資料源）。
        // 若已被 stop_task/close_agent 先行終態化（cancelTree 寫入 cancelled），
        // 本次 terminalize 為 no-op（CAS），但仍據 record 現值 append。
        const settled = deps.tasks.get(task.id)!
        append(deps.parentSession, {
          type: "subagent/end", version: 1, taskId: task.id,
          outcome: settled.outcome ?? outcome,
          ...(settled.resultText !== undefined ? { resultText: settled.resultText } : {}),
          ...(settled.error !== undefined ? { error: settled.error } : {}),
        })
      },
    })
    deps.tasks.claim(task.id, executed.sessionId)
    const base = { agent_path: executed.path, job_id: executed.jobId, task_id: task.id }
    if (args.background === false) {
      const settled = await deps.tasks.wait(task.id, 300_000)
      return { ...base, status: settled?.status ?? "unknown", ...(settled?.outcome !== undefined ? { outcome: settled.outcome } : {}), ...(settled?.resultText !== undefined ? { resultText: settled.resultText } : {}), ...(settled?.error !== undefined ? { error: settled.error } : {}), message: `subagent ${executed.path} settled: ${settled?.status ?? "unknown"}` }
    }
    return base
  },
}
```

注意：`Tool.execute` 本已接收第二參數 `exec: ToolExec`——既有 tools.test.ts 以 `spawn.execute({...})`（單參數）呼叫的用例自動得到 `undefined` exec：identity 退化成 anon（`parentSessionId: ""`），submit 每次都 mint 新 task，**既有斷言只查 job_id/agent_path，不破**。

`packages/subagent/src/index.ts` 匯出 + deps 接線（Task 4 只建「空 registry」——Task 5 升級為持久化/配額版本）：

```ts
export { createTaskRegistry, taskDocKey, notificationMessageId, classifyRestoredTasks, TaskIdentityConflictError, TaskConcurrencyLimitError } from "./task-protocol.ts"
export type { TaskRegistry, TaskRecord, TaskStatus, TaskOutcome, TaskDelivery, TaskIdentity, TaskNotificationRecord, TaskProtocolDocument, OutboxStatus } from "./task-protocol.ts"
```

`registerSubagent` 內（`subagentDeps` 之前）：

```ts
// M26-D1: task protocol registry — in-memory records + identity map.
// Task 5 升級成持久化版本（coordinator 文件 + restore/classify）。
const tasks = createTaskRegistry()
```

`subagentDeps` 物件加 `tasks,` 欄位（Task 4 必備——`SubagentToolDeps.tasks` 為 required，缺 `tasks` 的 deps literal 無法通過 typecheck）。

- [ ] **Step 4b: 更新既有測試的 deps literals（`SubagentToolDeps.tasks` 為 required）**

機械性改動（本步無新斷言）：

- `packages/subagent/test/tools.test.ts`：頂部加入 `import { createTaskRegistry } from "../src/task-protocol.ts"`，`setup()` 的 `createSubagentTools({...})` 加 `tasks: createTaskRegistry(),`；檔案內**其餘 8 處** inline `createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers, exec, agents: createAgentRegistry() })`（及兩處 `agents` 自建的變體）一律追加 `tasks: createTaskRegistry()[,]`——範例（:43 處）：

```ts
const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers, exec, agents: createAgentRegistry(), tasks: createTaskRegistry() })
```

- `packages/subagent/test/resume.test.ts`：`setup()` 的 `const deps: SubagentToolDeps = {...}` 加 `tasks: createTaskRegistry(),`（頂部 import 一併加）。
- `packages/subagent/test/register.test.ts`：不動（走 registerSubagent——Task 5 後含 tasks）。

- [ ] **Step 5: 跑測試確認通過（含既有）**

Run: `cd packages/subagent && pnpm vitest run test/child.test.ts test/tools.test.ts test/jobs.test.ts test/roles.test.ts`
Expected: PASS（既有 spawn/wait/list/send/interrupt/followup/close/resume 全部原樣）

- [ ] **Step 6: Commit**

```bash
git add packages/subagent/src/child.ts packages/subagent/src/tools.ts packages/subagent/src/index.ts packages/subagent/test/child.test.ts packages/subagent/test/tools.test.ts
git commit -m "feat(M26-D1): task registration in spawn_agent — onSettled seam + submit/spawn/claim wiring + subagent/start event"
```

---

### Task 5: 冷啟 recovery classification（task doc restore + classify）

**Files:**
- Modify: `packages/subagent/src/index.ts:79-137`（registerSubagent 建 registry + ready chain 擴充）
- Modify: `packages/subagent/src/tools.ts:20-46`（SubagentToolDeps 已妥，本 task 無）
- Test: `packages/subagent/test/resume.test.ts`（新增恢復分類例）

**Interfaces:**
- Consumes: `classifyRestoredTasks(tasks, coordinator)`（Task 3）、`taskDocKey`、`TaskProtocolDocument`、`SubagentPersistence`（既有）
- Produces（D2-T3 依賴——`ready` 已是「restore task doc → classify → (D2 drain)」鏈）：
```ts
// RegisterSubagentOptions 增
maxConcurrency?: number
parentNotify?: ParentInputAdmission  // D2-T1 型別，D2-T3 接
// RegisterSubagentResult 增
tasks: TaskRegistry
```

- [ ] **Step 1: 寫失敗測試**

`packages/subagent/test/resume.test.ts` 追加（頂部新增 `import { classifyRestoredTasks, createTaskRegistry } from "../src/task-protocol.ts"`）：

```ts
describe("M26-D1 recovery classification on cold restore", () => {
  it("classifies running→completed when the durable child log has a complete turn; recovery-required when not", async () => {
    const states: unknown[] = []
    const coord = {
      putDocument: async (_k: string, data: unknown) => { states.push(data) },
      getDocument: async (k: string) => {
        if (k === "task:sess-main") {
          return {
            formatVersion: 1,
            tasks: [
              { id: "task-1", parentSessionId: "sess-main", callEventSeq: 1, childSessionId: "child-done", agentPath: "root/done", description: "d", prompt: "p", agent: "general", delivery: "parent", status: "running", timeCreated: 1 },
              { id: "task-2", parentSessionId: "sess-main", callEventSeq: 2, childSessionId: "child-ambiguous", agentPath: "root/amb", description: "a", prompt: "p", agent: "general", delivery: "parent", status: "running", timeCreated: 2 },
              { id: "task-3", parentSessionId: "sess-main", callEventSeq: 3, agentPath: "root/nodispatch", description: "n", prompt: "p", agent: "general", delivery: "parent", status: "accepted", timeCreated: 3 },
            ],
            notifications: [],
          }
        }
        return undefined
      },
      load: async (sid: string) => {
        if (sid === "child-done") {
          return { session: { formatVersion: 1, header: { seedLength: 0 }, events: [
            { type: "turn/start", seq: 0 }, { type: "user/message", text: "p", seq: 1 },
            { type: "assistant/message", text: "final answer", seq: 2 }, { type: "turn/end", seq: 3 },
          ] } }
        }
        if (sid === "child-ambiguous") {
          return { session: { formatVersion: 1, header: { seedLength: 0 }, events: [
            { type: "turn/start", seq: 0 }, { type: "user/message", text: "p", seq: 1 },
          ] } }
        }
        throw new Error("no such session")
      },
    } as never
    const tasks = createTaskRegistry({ coordinator: coord, stateId: "sess-main" })
    await (async () => {
      const pre = await coord.getDocument("task:sess-main") // simulate mount restore
      tasks.restore(pre as never)
    })()
    const restored = await classifyRestoredTasks(tasks, coord)
    expect(restored).toBe(3)
    expect(tasks.get("task-1")).toMatchObject({ outcome: "completed", resultText: "final answer" })
    expect(tasks.get("task-2")).toMatchObject({ outcome: "recovery-required", recoveryReason: "response-interrupted" })
    expect(tasks.get("task-3")).toMatchObject({ outcome: "recovery-required", recoveryReason: "dispatch-unknown" })
    // recovery classification also enqueues durable notifications (parent delivery)
    expect(tasks.notifications().map((n) => n.state)).toEqual(["completed", "recovery-required", "recovery-required"])
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/subagent && pnpm vitest run test/resume.test.ts`
Expected: FAIL — `classifyRestoredTasks` 尚未匯出；`createTaskRegistry` 無 stateId 參數效果

（本步驟先確認匯出面已補：`createTaskRegistry`、`classifyRestoredTasks` 由 `index.ts` 匯出——Task 4 Step 4 已加。）

- [ ] **Step 3: 實作 index.ts 整合**

`registerSubagent` 內（`restoreState` 前後皆可，但須於工具建立前）：建 registry + ready chain 擴充：

```ts
// M26-D1: task protocol registry — durable task records + outbox behind the
// existing persistence seam (doc key `task:<stateId>`).
const tasks = createTaskRegistry({
  ...(opts.persist ? { coordinator: opts.persist.coordinator, stateId: opts.persist.stateId } : {}),
  maxConcurrency: opts.maxConcurrency,
})
```

`SubagentToolDeps` 建構加 `tasks`。

`ready` 邏輯取代（`:130-137` 現在是 `if (opts.restoredState && opts.persist) { ready = restoreMirrorsAndSweep(...) }`，改為統一 async 步驟）：

```ts
if (opts.persist) {
  ready = restoreTasksAndSweep(subagentDeps, table, tasks)
}
```

新增（function 置於 index.ts）：

```ts
// M26-D1/D2: post-restore task protocol chain — (1) load the durable task doc
// (records + outbox rows), (2) classify ambiguous accepted/running attempts from
// the durable child log (completed | recovery-required — never re-dispatch),
// (3) G1a mirrors + G4 sweep (existing M24a steps). Notifications drain (D2-T1)
// runs here too once wired.
async function restoreTasksAndSweep(deps: SubagentToolDeps, table: AgentTable, tasks: TaskRegistry): Promise<void> {
  if (deps.childSessions) {
    try {
      const doc = await deps.childSessions.coordinator.getDocument(taskDocKey(deps.childSessions.parentSessionId))
      if (doc !== undefined) tasks.restore(doc as TaskProtocolDocument)
    } catch {
      // task doc missing/corrupt → empty registry（既有 subagent-state 同姿態）
    }
    await classifyRestoredTasks(tasks, deps.childSessions.coordinator)
  }
  await restoreMirrorsAndSweep(deps, table)
}
```

（注意 key：task doc 的 stateId = parentSessionId = activeId——run.ts 狀態同源。`tasks` 需於 subagentDeps 之前建置。）

`RegisterSubagentOptions` 加 `maxConcurrency?: number`；`RegisterSubagentResult` 加 `tasks`，回傳加 `tasks`。

- [ ] **Step 4: 跑測試確認通過**

Run: `cd packages/subagent && pnpm vitest run test/resume.test.ts test/register.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/subagent/src/index.ts packages/subagent/test/resume.test.ts
git commit -m "feat(M26-D1): cold-restore recovery classification — task doc restore + durable-log evidence (completed | recovery-required, no re-dispatch)"
```

---

### Task 6: 通知 outbox —— ParentInputAdmission 契約 + drain（task-notification.ts）

**Files:**
- Create: `packages/subagent/src/task-notification.ts`
- Modify: `packages/subagent/src/task-protocol.ts:115-122`（TaskRegistry 型別無需動——drain 用既有 notifications/updateNotification/save）
- Test: `packages/subagent/test/task-notification.test.ts`（新）

**Interfaces:**
- Consumes: `TaskRegistry`（Task 3）、`TaskNotificationRecord`、`notificationMessageId`
- Produces（D2-T2/T3、D3-T2 依賴——**A-plan R-A1 契約**）：
```ts
// A-plan (R-A1 輸入分級) 契約——本計畫消費的單一接納面；
// A-plan 落地時由 host 注入（run.ts opts.parentNotify），未注入 = durable-only（fail-closed）。
export interface ParentInputAdmission {
  admit(input: { sessionId: string; text: string; description: string }): Promise<void>
  wake(sessionId: string): void
}

export function renderTaskNotification(state: TaskOutcome, taskId: string, description: string, text: string): string
export function createNotificationDrain(opts: {
  tasks: TaskRegistry
  admit: ParentInputAdmission | undefined
  isSessionCancelled?: (sessionId: string) => boolean  // D3-T2: cancelTree root 判斷; 預設 () => false
}): { drain: () => Promise<number> }
```

- [ ] **Step 1: 寫失敗測試**

`packages/subagent/test/task-notification.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest"
import { createTaskRegistry } from "../src/task-protocol.ts"
import { createNotificationDrain, renderTaskNotification } from "../src/task-notification.ts"

describe("task notification outbox", () => {
  it("drain admits pending rows (renderPayload → admit → delivered → wake → woken)", async () => {
    const tasks = createTaskRegistry()
    tasks.submit({ identity: { parentSessionId: "s-main", callEventSeq: 1 }, agentPath: "root/h", description: "helper", prompt: "p", agent: "general", delivery: "parent" })
    tasks.terminalize({ taskId: "task-1", outcome: "completed", resultText: "ok done" })
    const admits: { sessionId: string; text: string; description: string }[] = []
    const wake = vi.fn()
    const drain = createNotificationDrain({ tasks, admit: { admit: async (a) => { admits.push(a) }, wake } })
    const n = await drain.drain()
    expect(n).toBe(1)
    expect(admits).toHaveLength(1)
    expect(admits[0]).toMatchObject({ sessionId: "s-main", description: "helper" })
    expect(admits[0]!.text).toContain("task-1")
    expect(admits[0]!.text).toContain("completed")
    expect(wake).toHaveBeenCalledWith("s-main")
    const notif = tasks.notifications()[0]!
    expect(notif.status).toBe("woken")
    expect(notif.attempts).toBe(1)
    expect(notif.timeWoken).toBeGreaterThan(0)
    await expect(drain.drain()).resolves.toBe(0) // idempotent — no re-admit
  })

  it("a failed admit errors the row (status error) and is retried on the next drain", async () => {
    const tasks = createTaskRegistry()
    tasks.submit({ identity: { parentSessionId: "s-main", callEventSeq: 1 }, agentPath: "root/h", description: "h", prompt: "p", agent: "general", delivery: "parent" })
    tasks.terminalize({ taskId: "task-1", outcome: "error", error: "bad turn" })
    let calls = 0
    const drain = createNotificationDrain({ tasks, admit: { admit: async () => { calls += 1; if (calls === 1) throw new Error("queue down"); await Promise.resolve() }, wake: () => {} } })
    await drain.drain()
    expect(tasks.notifications()[0]!.status).toBe("error")
    expect(tasks.notifications()[0]!.error).toBe("queue down")
    await drain.drain() // retry succeeds
    expect(tasks.notifications()[0]!.status).toBe("woken")
    expect(tasks.notifications()[0]!.attempts).toBe(2)
  })

  it("suppresses delivery when the parent session chain is cancelled (D3 hook)", async () => {
    const tasks = createTaskRegistry()
    tasks.submit({ identity: { parentSessionId: "s-main", callEventSeq: 1 }, agentPath: "root/h", description: "h", prompt: "p", agent: "general", delivery: "parent" })
    tasks.terminalize({ taskId: "task-1", outcome: "completed", resultText: "x" })
    const wake = vi.fn()
    const drain = createNotificationDrain({ tasks, admit: { admit: async () => {}, wake }, isSessionCancelled: (sid) => sid === "s-main" })
    const n = await drain.drain()
    expect(n).toBe(0)
    expect(tasks.notifications()[0]!.status).toBe("suppressed")
    expect(wake).not.toHaveBeenCalled()
  })

  it("absent admit (no A-plan yet) keeps rows pending — durable-only delivery", async () => {
    const tasks = createTaskRegistry()
    tasks.submit({ identity: { parentSessionId: "s-main", callEventSeq: 1 }, agentPath: "root/h", description: "h", prompt: "p", agent: "general", delivery: "parent" })
    tasks.terminalize({ taskId: "task-1", outcome: "completed", resultText: "x" })
    const drain = createNotificationDrain({ tasks, admit: undefined })
    expect(await drain.drain()).toBe(0)
    expect(tasks.notifications()[0]!.status).toBe("pending")
  })

  it("renderTaskNotification renders the opencode payload shape", () => {
    const text = renderTaskNotification("completed", "task-1", "helper", "ok done")
    expect(text).toBe("<task id=\"task-1\" state=\"completed\">\n<summary>helper</summary>\n<task_result>\nok done\n</task_result>\n</task>")
  })
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/subagent && pnpm vitest run test/task-notification.test.ts`
Expected: FAIL — 檔案不存在

- [ ] **Step 3: 實作 task-notification.ts**

```ts
import type { TaskNotificationRecord, TaskOutcome, TaskRegistry } from "./task-protocol.ts"

/**
 * A-plan (R-A1 輸入分級與持久化) 契約 —— 本計畫（R-D2）消費的單一輸入接納面。
 * 由 A-plan 提供實作（admit = 合成輸入進 parent session 輸入層 + 收件箱 splice；
 * wake = 喚醒 parent 執行器）。未注入（undefined）= durable-only 交付（fail-closed）。
 */
export interface ParentInputAdmission {
  admit(input: { sessionId: string; text: string; description: string }): Promise<void>
  wake(sessionId: string): void
}

export function renderTaskNotification(state: TaskOutcome, taskId: string, description: string, text: string): string {
  const tag = state === "completed" ? "task_result" : "task_error"
  return [
    `<task id="${taskId}" state="${state}">`,
    `<summary>${description}</summary>`,
    `<${tag}>`,
    text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

export interface NotificationDrainOptions {
  tasks: TaskRegistry
  admit: ParentInputAdmission | undefined
  // R-D3: 父 session 本身已被取消（cancelTree root chain）→ 不交付（opencode suppress）。
  isSessionCancelled?: (sessionId: string) => boolean
}

export function createNotificationDrain(opts: NotificationDrainOptions): { drain: () => Promise<number> } {
  const isCancelled = opts.isSessionCancelled ?? (() => false)
  return {
    // Idempotent: pending|error|(delivered && !woken) are the only candidates;
    // every transition re-checks the row's current status so a coalesced drain
    // cannot double-admit. Single-threaded per mount; the coordinator doc lease
    // covers cross-process (M23) for the underlying write.
    async drain(): Promise<number> {
      if (!opts.admit) return 0
      let delivered = 0
      for (const n of opts.tasks.notifications()) {
        const candidate =
          n.status === "pending" || n.status === "error" ||
          (n.status === "delivered" && n.timeWoken === undefined)
        if (!candidate) continue
        opts.tasks.updateNotification(n.id, { attempts: n.attempts + 1, ...(n.status === "error" ? { error: undefined } : {}) })
        if (isCancelled(n.parentSessionId)) {
          opts.tasks.updateNotification(n.id, { status: "suppressed", error: "parent session cancelled before notification delivery", timeWoken: Date.now() })
          continue
        }
        try {
          await opts.admit.admit({
            sessionId: n.parentSessionId,
            text: renderTaskNotification(n.state, n.submissionId, n.description, n.text),
            description: n.description,
          })
          opts.tasks.updateNotification(n.id, { status: "delivered", timeDelivered: Date.now(), error: undefined })
          opts.tasks.updateNotification(n.id, { status: "woken", timeWoken: Date.now(), error: undefined })
          opts.admit.wake(n.parentSessionId)
          delivered += 1
        } catch (err) {
          opts.tasks.updateNotification(n.id, { status: "error", error: err instanceof Error ? err.message : String(err) })
        }
      }
      await opts.tasks.save()
      return delivered
    },
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd packages/subagent && pnpm vitest run test/task-notification.test.ts && pnpm vitest run test/task-protocol.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/subagent/src/task-notification.ts packages/subagent/test/task-notification.test.ts
git commit -m "feat(M26-D2): notification outbox drain — ParentInputAdmission (A-plan contract) + render payload + status-guarded idempotent delivery"
```

---

### Task 7: spawn_agent 背景契約 —— `background:false` 逃逸門 + terminalize 觸發即時交付

**Files:**
- Modify: `packages/subagent/src/tools.ts`（spawn tool `background` 已於 Task 4 完成本體；本 task：通知觸發 `onTerminalized` + drain 即時呼叫、`background:false` 之 wait 時限微調）
- Modify: `packages/subagent/src/index.ts`（drain 建置 + onTerminalized 綁定 + ready 鏈末 drain）
- Test: `packages/subagent/test/tools.test.ts`（`background:false` 阻塞例）、`test/task-notification.test.ts`（即時觸發例——實以 index 層整合測試代替，用 registerSubagent mount 驗證）

**Interfaces:**
- Consumes: `createNotificationDrain`（Task 6）、`TaskRegistryOptions.onTerminalized`（Task 3）、`ParentInputAdmission`
- Produces（D2-T3 依賴）：
```ts
// task-notification.ts（本 task 匯出點不變）— index.ts 內部：
// const notifDrain = createNotificationDrain({ tasks, admit: opts.parentNotify, isSessionCancelled: (sid) => taskCancelledChain(deps, tasks, sid) })
```

- [ ] **Step 1: 寫失敗測試**

`packages/subagent/test/tools.test.ts` 追加（背景交付鏈測試——用 registerSubagent 完整 mount）：

```ts
describe("M26-D2 background delivery", () => {
  it("background:false blocks until the task settles and returns the summary", async () => {
    const { ctx, table, jobs, roles, parentReg, session, providers, model, exec } = setup()
    const tasks = createTaskRegistry()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers, exec, agents: createAgentRegistry(), tasks })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const out = await spawn.execute({ message: "do it", task_name: "helper", background: false }, { sessionId: "s-main", callEventSeq: 5 })
    expect(out).toMatchObject({ agent_path: "root/helper", task_id: "task-1", status: "completed", outcome: "completed", resultText: "child done" })
    expect(table.get("root/helper")?.status).toBe("waiting")
  }, 15_000)

  it("terminalize delivers to the parent immediately (parentNotify wired)", async () => {
    const ctx = createContext()
    const parentReg = createToolRegistry(ctx)
    parentReg.register({ name: "read", description: "read", inputSchema: {}, execute: async () => ({}) })
    const session = createSession()
    const jobs = createJobRegistry()
    const table = createAgentTable()
    const roles = createRoleRegistry()
    for (const r of builtinRoles()) roles.register(r)
    const providers = createProviderRegistry()
    const exec = createExecService()
    // slow child so terminalize happens after spawn returns
    const model = createMockClient([{ role: "assistant", text: "late answer" }])
    // let-deferred: onTerminalized 只在 terminalize 時執行（那時 drainRef 已賦值）
    let drainRef: { drain: () => Promise<number> } | undefined
    const tasks = createTaskRegistry({ onTerminalized: () => { void drainRef?.drain() } })
    const admits: string[] = []
    drainRef = createNotificationDrain({
      tasks,
      admit: { admit: async (a) => { admits.push(a.text) }, wake: () => {} },
    })
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers, exec, agents: createAgentRegistry(), tasks })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    await spawn.execute({ message: "do it", task_name: "helper" }, { sessionId: "s-main", callEventSeq: 7 })
    expect(admits).toHaveLength(0) // still running
    await new Promise((r) => setTimeout(r, 200))
    await new Promise((r) => setTimeout(r, 20))
    expect(admits).toHaveLength(1)
    expect(tasks.notifications()[0]!.status).toBe("woken")
  }, 15_000)
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/subagent && pnpm vitest run test/tools.test.ts`
Expected: FAIL — `createNotificationDrain` 未接入（第一例之 blocking 若 Task 4 已做會過；若未做，先確認 Task 4 的 blocking 段落已落地）

- [ ] **Step 3: 實作 index.ts drain 整合**

```ts
// registerSubagent 內（subagentDeps 之後）：
const notifDrain = createNotificationDrain({
  tasks,
  admit: opts.parentNotify,
  isSessionCancelled: (sessionId) => isSessionCancelledChain(tasks, sessionId),
})
// tasks 於建立時即須綁 onTerminalized —— 建 tasks 前先建 notifDrain 無法閉合順序；
// 解決：tasks 以 let 宣告、onTerminalized 用 deferred binding：
```

（實裝細節——順序調整：建立 registry 時 `onTerminalized` 用 const hook 變數，其後 assign：）

```ts
let notifDrainHook: (() => void) | undefined
const tasks = createTaskRegistry({
  ...(opts.persist ? { coordinator: opts.persist.coordinator, stateId: opts.persist.stateId } : {}),
  maxConcurrency: opts.maxConcurrency,
  onTerminalized: () => { notifDrainHook?.() },
})
// ...建立 deps...
const notifDrain = createNotificationDrain({ tasks, admit: opts.parentNotify, isSessionCancelled: (sessionId) => isSessionCancelledChain(tasks, sessionId) })
notifDrainHook = () => { void notifDrain.drain().catch(() => {}) }
```

`ready` 鏈尾（`restoreTasksAndSweep` 內 `classifyRestoredTasks` 之後）：`await notifDrain.drain()`——冷啟先交付（前次 run 的完成通知 = 本次啟動時父 session 的收件箱輸入）。

`isSessionCancelledChain`（task-protocol.ts 匯出或 tools.ts 內）：

```ts
// R-D3: parent 是否落在已取消的 delegation chain 上（task 以 childSessionId
// 連結祖先；1 hop 每層）。用於 outbox suppression。
export function isSessionCancelledChain(tasks: TaskRegistry, sessionId: string): boolean {
  let cur = sessionId
  for (let i = 0; i < 64; i++) {
    const t = tasks.getByChildSession(cur)
    if (!t) return false
    if (t.outcome === "cancelled") return true
    if (t.parentSessionId === "") return false
    cur = t.parentSessionId
  }
  return false
}
```

此函式置於 `task-protocol.ts` 並匯出（D3-T2 共用）。

`RegisterSubagentOptions` 加：

```ts
// M26-D2: A-plan 輸入接納（R-A1）—— 由 host（run.ts）注入。缺省 = durable-only。
parentNotify?: ParentInputAdmission
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd packages/subagent && pnpm vitest run test/tools.test.ts test/task-notification.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/subagent/src/index.ts packages/subagent/src/task-protocol.ts packages/subagent/src/task-notification.ts packages/subagent/test/tools.test.ts
git commit -m "feat(M26-D2): background delivery — onTerminalized drain hook + ready-chain drain + isSessionCancelledChain suppression walk"
```

---

### Task 8: host 注入面 —— run.ts `parentNotify` pass-through + 工具面 subagent/end 檢查

**Files:**
- Modify: `apps/cli/src/run.ts`（MainOptions + registerSubagent 呼叫）
- Modify: `packages/subagent/test/register.test.ts`（mount 測試確認 tasks 回傳 + 12→13 工具數預告於 Task 13 更新，本 tasks 不改數）
- Test: `apps/cli/test/cli.test.ts`（若有既有 registerSubagent 相關 mount 例則加一行斷言）

**Interfaces:**
- Consumes: `ParentInputAdmission`（Task 6）、`RegisterSubagentOptions.parentNotify`（Task 7）
- Produces（A-plan 整合點——A1 落地時 run.ts 內唯一新增一行）：
```ts
// run.ts MainOptions 增（additive）
parentNotify?: import("@i-harness/subagent").ParentInputAdmission
// run.ts registerSubagent 呼叫增（additive）
...(opts.parentNotify ? { parentNotify: opts.parentNotify } : {}),
```

- [ ] **Step 1: 實作（本 task 為純 pass-through，無獨立新測試——Step 2 驗證既有不破 + 一例通過）**

`apps/cli/src/run.ts`：

```ts
// MainOptions 增
// M26-D2: A-plan 輸入接納（R-A1）——host 注入 ParentInputAdmission；
// 缺省（A-plan 未落地）時 subagent 的完成通知只走 durable outbox + subagent/end 日誌。
parentNotify?: import("@i-harness/subagent").ParentInputAdmission
```

`registerSubagent` 呼叫（`:283-296`）增：

```ts
...(opts.parentNotify ? { parentNotify: opts.parentNotify } : {}),
```

- [ ] **Step 2: 驗證**

Run: `cd apps/cli && pnpm vitest run test/cli.test.ts`
Run: `cd packages/subagent && pnpm vitest run test/register.test.ts`
Expected: PASS（純 additive；現有 CLI 測試不破）

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/run.ts
git commit -m "feat(M26-D2): run.ts parentNotify pass-through (A-plan R-A1 admission seam)"
```

---

### Task 9: 配額 —— `maxConcurrency` permit（submit fail-closed）

**Files:**
- Modify: `packages/subagent/src/task-protocol.ts`（runningCountUnsafe 已於 Task 3 實作——本任務只接線 config + 測試）
- Modify: `packages/subagent/src/index.ts`（RegisterSubagentOptions.maxConcurrency → tasks）
- Test: `packages/subagent/test/task-control.test.ts`（新，permit 例）

**Interfaces:**
- Consumes: `TaskRegistryOptions.maxConcurrency`、`TaskConcurrencyLimitError`（Task 3）、`RegisterSubagentOptions.maxConcurrency`（Task 5）
- Produces：`RegisterSubagentOptions.maxConcurrency?: number`（host 設定；缺省 Infinity）

- [ ] **Step 1: 寫失敗測試**

`packages/subagent/test/task-control.test.ts`：

```ts
import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { createSession } from "@i-harness/core-session"
import { createMockClient } from "@i-harness/llm-mock"
import { createAgentRegistry } from "@i-harness/core-agent"
import { createProviderRegistry } from "@i-harness/provider"
import { createExecService } from "@i-harness/exec"
import { createJobRegistry } from "../src/jobs.ts"
import { createRoleRegistry, builtinRoles } from "../src/roles.ts"
import { createAgentTable } from "../src/agent-table.ts"
import { createSubagentTools } from "../src/tools.ts"
import { createTaskRegistry, TaskConcurrencyLimitError } from "../src/task-protocol.ts"

function setupWith(maxConcurrency?: number) {
  const ctx = createContext()
  const parentReg = createToolRegistry(ctx)
  parentReg.register({ name: "read", description: "read", inputSchema: {}, execute: async () => ({}) })
  const session = createSession()
  const jobs = createJobRegistry()
  const table = createAgentTable()
  const roles = createRoleRegistry()
  for (const r of builtinRoles()) roles.register(r)
  const tasks = createTaskRegistry({ maxConcurrency })
  const exec = createExecService()
  const model = createMockClient([{ role: "assistant", text: "done" }])
  const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers: createProviderRegistry(), exec, agents: createAgentRegistry(), tasks })
  return { all, tasks }
}

describe("M26-D3 concurrency permit (tool-level)", () => {
  it("a pre-occupied permit rejects a new spawn; settlement frees it", async () => {
    const { all, tasks } = setupWith(1)
    // Manually occupy the single permit with an accepted record — deliberately
    // NOT through spawn (a mock child settles within one tick, which would race
    // the count). This is a deterministic occupied-permit setup.
    tasks.submit({ identity: { parentSessionId: "s1", callEventSeq: 0 }, agentPath: "root/occupy", description: "occupy", prompt: "p", agent: "general", delivery: "tool" })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    await expect(spawn.execute({ message: "blocked", task_name: "b" }, { sessionId: "s1", callEventSeq: 1 })).rejects.toThrow(TaskConcurrencyLimitError)
    tasks.terminalize({ taskId: "task-1", outcome: "cancelled", error: "freed" })
    await expect(spawn.execute({ message: "ok", task_name: "c" }, { sessionId: "s1", callEventSeq: 2 })).resolves.toMatchObject({ task_id: "task-2" })
  }, 15_000)
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/subagent && pnpm vitest run test/task-control.test.ts`
Expected: FAIL — spawn 通路未拋出 `TaskConcurrencyLimitError`（`RegisterSubagentOptions.maxConcurrency` 尚未接進 tasks registry；registry 級 limit 檢查已於 Task 3 測試覆蓋）

- [ ] **Step 3: 接線 index.ts**

`RegisterSubagentOptions` 的 JSDoc（index.ts）加註（會同 Task 5 的 `maxConcurrency?: number` 欄位）並確認傳遞鏈：

```ts
// M26-D3 (R-D1-T3): subagent 並行配額——非終態（accepted+running）任務數 >=
// maxConcurrency 時 submit 以 TaskConcurrencyLimitError 失敗閉合（fail-closed）。
// 缺省 Infinity（host 開啟才生效——零行為變更）。R-D1 的 depth 配額由既存
// maxDepth（M24a B2）擔當，本欄位是 concurrency 軸。
maxConcurrency?: number
```

（傳遞鏈：`registerSubagent` 內 createTaskRegistry 已帶 `maxConcurrency: opts.maxConcurrency`——Task 7 Step 3 已實作；本任務只確認。）

- [ ] **Step 4: 跑測試確認通過**

Run: `cd packages/subagent && pnpm vitest run test/task-control.test.ts && pnpm vitest run test/task-protocol.test.ts && pnpm vitest run test/register.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/subagent/src/index.ts packages/subagent/test/task-control.test.ts
git commit -m "feat(M26-D3): subagent concurrency permit wiring (TaskConcurrencyLimitError fail-closed at submit)"
```

---

### Task 10: cancelTree —— 遞迴取消 + descendant quiescence（registry 中央單次寫 + 工具層 abort/等待）

**Files:**
- Modify: `packages/subagent/src/task-protocol.ts`（cancelTree 已於 Task 3 實作；`isSessionCancelledChain` 已於 Task 7）
- Modify: `packages/subagent/src/tools.ts`（`cancelSubtree` helper：registry.cancelTree + 依 agentPath 找 table entry → abort + job kill + await followupChain）
- Test: `packages/subagent/test/task-control.test.ts`（cancelTree 例）

**Interfaces:**
- Consumes: `TaskRegistry.cancelTree(taskId, error?)`（Task 3）、`ChildAgentEntry.followupChain/controller`（既有）
- Produces（D4-T2 依賴）：
```ts
// tools.ts（內部）
async function cancelSubtree(deps: SubagentToolDeps, taskId: string, reason?: string): Promise<{ taskIds: string[]; cancelled: number }>
```

- [ ] **Step 1: 寫失敗測試**

`packages/subagent/test/task-control.test.ts` 追加（直接測本 task 匯出的 `cancelSubtree`；stop_task 工具層面在 Task 13 測；頂部新增 `import type { SubagentToolDeps } from "../src/tools.ts"`）：

```ts
import { cancelSubtree } from "../src/tools.ts"

describe("M26-D3 cancelTree", () => {
  it("cancels the target + descendant records; aborts and awaits quiescence of the live table subtree", async () => {
    const ctx = createContext()
    const parentReg = createToolRegistry(ctx)
    parentReg.register({ name: "read", description: "read", inputSchema: {}, execute: async () => ({}) })
    const session = createSession()
    const jobs = createJobRegistry()
    const table = createAgentTable()
    const roles = createRoleRegistry()
    for (const r of builtinRoles()) roles.register(r)
    const model = createMockClient([{ role: "assistant", text: "child done" }])
    const tasks = createTaskRegistry()
    // 重建兩層鏈：task-1 (root/a) + task-2 (root/a/b)
    tasks.restore({
      formatVersion: 1,
      tasks: [
        { id: "task-1", parentSessionId: "s-1", callEventSeq: 1, agentPath: "root/a", description: "a", prompt: "p", agent: "general", delivery: "parent", status: "accepted", timeCreated: 1 },
        { id: "task-2", parentSessionId: "s-2", callEventSeq: 2, childSessionId: "child-2", agentPath: "root/a/b", description: "b", prompt: "p", agent: "general", delivery: "parent", status: "running", timeCreated: 2 },
      ],
      notifications: [],
    })
    const deps: SubagentToolDeps = {
      table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx,
      parentModel: model, providers: createProviderRegistry(), exec: createExecService(),
      agents: createAgentRegistry(), tasks,
    }
    // 活體 entry（供 quiescence）：running stub —— cancelSubtree 會 abort 其 controller
    table.add("root/a/b", { path: "root/a/b", status: "running", session: createSession(), controller: new AbortController(), mailbox: [] })
    const result = await cancelSubtree(deps, "task-1", "scope changed")
    expect(result).toEqual({ taskIds: ["task-1", "task-2"], cancelled: 2 })
    expect(tasks.get("task-1")).toMatchObject({ outcome: "cancelled", error: "scope changed" })
    expect(tasks.get("task-2")).toMatchObject({ outcome: "cancelled" })
    expect(table.get("root/a/b")!.controller.signal.aborted).toBe(true)
    // parent-delivery 的已取消任務入 outbox（cancelTree 路徑，同一 doc 寫）
    expect(tasks.notifications().map((n) => n.state)).toEqual(["cancelled", "cancelled"])
  }, 15_000)

  it("misses an unknown id (identity error) and no-ops for an already-terminal root", async () => {
    const ctx = createContext()
    const parentReg = createToolRegistry(ctx)
    const session = createSession()
    const tasks = createTaskRegistry()
    const deps: SubagentToolDeps = {
      table: createAgentTable(), jobs: createJobRegistry(), roles: createRoleRegistry(),
      parentRegistry: parentReg, parentSession: session, parentCtx: ctx,
      parentModel: createMockClient([]), providers: createProviderRegistry(),
      exec: createExecService(), agents: createAgentRegistry(), tasks,
    }
    await expect(cancelSubtree(deps, "task-99")).rejects.toThrow(/unknown task/)
    tasks.restore({
      formatVersion: 1,
      tasks: [{ id: "task-1", parentSessionId: "s1", callEventSeq: 1, agentPath: "root/x", description: "x", prompt: "p", agent: "general", delivery: "tool", status: "completed", outcome: "completed", timeCreated: 1 }],
      notifications: [],
    })
    expect(await cancelSubtree(deps, "task-1")).toEqual({ taskIds: [], cancelled: 0 })
  }, 15_000)
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/subagent && pnpm vitest run test/task-control.test.ts`
Expected: FAIL — `cancelSubtree` 未匯出

- [ ] **Step 3: 實作 tools.ts 的 cancelSubtree**

```ts
// M26-D3: cancel a task + its whole descendant tree (agentPath prefix = the
// delegation tree), durable marks in ONE doc write (registry.cancelTree —
// terminalizes + enqueues notifications), then interrupt the live table subtree
// (existing controller channel) and await quiescence via each entry's
// followupChain (covers the initial run + all chained followups).
export async function cancelSubtree(
  deps: SubagentToolDeps,
  taskId: string,
  reason?: string,
): Promise<{ taskIds: string[]; cancelled: number }> {
  const root = deps.tasks.get(taskId)
  if (!root) throw new Error(`unknown task: ${taskId}`)
  if (root.outcome !== undefined) return { taskIds: [], cancelled: 0 }
  const result = deps.tasks.cancelTree(taskId, reason ?? "task cancelled by owner")
  const prefix = `${root.agentPath}/`
  const entries = [...deps.table.entries().values()].filter(
    (e) => e.path === root.agentPath || e.path.startsWith(prefix),
  )
  for (const e of entries) {
    e.controller.abort()
    if (e.jobId) deps.jobs.kill(e.jobId)
  }
  await Promise.allSettled(entries.map((e) => e.followupChain ?? Promise.resolve()))
  return result
}
```

（注意：`stop_task` 工具的 `already-finished`/`unknown task` 語義在 Task 12 綁定。）

- [ ] **Step 4: 跑測試確認通過**

Run: `cd packages/subagent && pnpm vitest run test/task-control.test.ts`
Expected: PASS（cancelTree 兩例）

- [ ] **Step 5: Commit**

```bash
git add packages/subagent/src/tools.ts packages/subagent/test/task-control.test.ts
git commit -m "feat(M26-D3): cancelSubtree — agentPath-prefix cancel tree + controller abort + followupChain quiescence"
```

---

### Task 11: cancel tree 與 restore/interrupt/close 一致性

**Files:**
- Modify: `packages/subagent/src/tools.ts`（close_agent：移除前 terminalize task cancelled；interrupt 語義註記不改）
- Modify: `packages/subagent/src/task-protocol.ts`（無修改——已驗證）
- Test: `packages/subagent/test/task-control.test.ts`（close 一致性例）+ `test/resume.test.ts`（cancelled 任務 restore 不再被分類）

**Interfaces:**
- Consumes: `TaskRegistry.terminalize`、`TaskRegistry.cancelTree`
- Produces：`close_agent` 現在會先把該 entry 對應的 task 記錄終態化（cancelled，僅當 task 記錄尚非終態）

- [ ] **Step 1: 寫失敗測試**

`packages/subagent/test/task-control.test.ts`：

```ts
it("close_agent terminalizes its task record as cancelled (not left running)", async () => {
  const ctx = createContext()
  const parentReg = createToolRegistry(ctx)
  parentReg.register({ name: "read", description: "read", inputSchema: {}, execute: async () => ({}) })
  const session = createSession()
  const jobs = createJobRegistry()
  const table = createAgentTable()
  const roles = createRoleRegistry()
  for (const r of builtinRoles()) roles.register(r)
  const model = createMockClient([{ role: "assistant", text: "done" }])
  const tasks = createTaskRegistry()
  const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers: createProviderRegistry(), exec: createExecService(), agents: createAgentRegistry(), tasks })
  const spawn = all.find((t) => t.name === "spawn_agent")!
  const close = all.find((t) => t.name === "close_agent")!
  await spawn.execute({ message: "go", task_name: "h" }, { sessionId: "s1", callEventSeq: 1 })
  await close.execute({ target: "root/h" })
  expect(tasks.get("task-1")!.outcome).toBe("cancelled")
})
```

`packages/subagent/test/resume.test.ts` 追加（並於該檔頂部 import 行加入 `import { classifyRestoredTasks, createTaskRegistry } from "../src/task-protocol.ts"`）：

```ts
it("cancelled/terminal tasks on restore are kept terminal (never reclassified)", async () => {
  const tasks = createTaskRegistry()
  tasks.restore({
    formatVersion: 1,
    tasks: [
      { id: "task-1", parentSessionId: "s1", callEventSeq: 1, childSessionId: "child-c", agentPath: "root/x", description: "x", prompt: "p", agent: "general", delivery: "tool", status: "cancelled", outcome: "cancelled", timeCreated: 1, timeCompleted: 2 },
    ],
    notifications: [],
  })
  // classification must never touch terminal records — the coordinator is not
  // consulted at all (a throw proves no load call happened below).
  const classified = await classifyRestoredTasks(tasks, { load: async () => { throw new Error("should not load") } } as never)
  expect(classified).toBe(0)
  expect(tasks.get("task-1")!.outcome).toBe("cancelled")
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/subagent && pnpm vitest run test/task-control.test.ts test/resume.test.ts`
Expected: FAIL — close_agent 未 terminalize（outcome 仍 undefined 或 completed）

- [ ] **Step 3: 實作 close_agent**

`tools.ts` close tool（`:239-255`）：

```ts
const closeTool: Tool<{ target: string }, { previous_status: string }> = {
  name: "close_agent",
  description: "Close a subagent and reclaim its resources (abort execution, unmount child scope, remove from the agent and job tables). Its task record terminalizes as cancelled.",
  ...
  execute: async (args) => {
    const entry = deps.table.get(args.target)
    if (!entry) throw new Error(`unknown subagent: ${args.target}`)
    const previous = entry.status
    entry.controller.abort()
    // M26-D3: a closed chat no longer has an outstanding settlement — terminalize
    // its task record as cancelled so a cold restore never reclassifies it.
    for (const t of deps.tasks.list()) {
      if (t.agentPath === entry.path && t.outcome === undefined) {
        deps.tasks.terminalize({ taskId: t.id, outcome: "cancelled", error: "subagent closed" })
      }
    }
    entry.unmount?.()
    if (entry.jobId) deps.jobs.kill(entry.jobId)
    deps.table.remove(args.target)
    if (entry.sessionId) deps.agents.remove(entry.sessionId)
    return { previous_status: previous }
  },
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd packages/subagent && pnpm vitest run test/task-control.test.ts test/resume.test.ts test/tools.test.ts test/persist.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/subagent/src/tools.ts packages/subagent/test/task-control.test.ts packages/subagent/test/resume.test.ts
git commit -m "feat(M26-D3): close_agent terminalizes its task record cancelled; restored terminal tasks never reclassify"
```

---

### Task 12: get_task_output（1–20 ids、bounded wait、non-owned identical failure）

**Files:**
- Modify: `packages/subagent/src/tools.ts`（新工具 + return 陣列）
- Test: `packages/subagent/test/task-control.test.ts`（追加）

**Interfaces:**
- Consumes: `TaskRegistry.get/wait/task-field`（Task 3）
- Produces（D4-T3 依賴）：
```ts
// createSubagentTools 回傳增一工具：
// name: "get_task_output"
Tool<{ task_ids: string[]; wait?: boolean; timeout_ms?: number }, {
  tasks: {
    task_id: string; status: TaskStatus; outcome?: TaskOutcome;
    agent_path: string; description: string; resultText?: string; error?: string; time_created: number;
  }[]
}>
```

- [ ] **Step 1: 寫失敗測試**

`packages/subagent/test/task-control.test.ts` 追加：

```ts
describe("M26-D4 get_task_output", () => {
  it("returns durable views for 1..20 owned task ids; bounded wait; non-owned identical failure", async () => {
    const ctx = createContext()
    const parentReg = createToolRegistry(ctx)
    parentReg.register({ name: "read", description: "read", inputSchema: {}, execute: async () => ({}) })
    const session = createSession()
    const jobs = createJobRegistry()
    const table = createAgentTable()
    const roles = createRoleRegistry()
    for (const r of builtinRoles()) roles.register(r)
    const model = createMockClient([{ role: "assistant", text: "child done" }])
    const tasks = createTaskRegistry()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers: createProviderRegistry(), exec: createExecService(), agents: createAgentRegistry(), tasks })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const get = all.find((t) => t.name === "get_task_output")!
    await spawn.execute({ message: "go", task_name: "h" }, { sessionId: "s1", callEventSeq: 1 })
    await tasks.wait("task-1", 10_000)
    const out = await get.execute({ task_ids: ["task-1"] })
    expect(out.tasks).toHaveLength(1)
    expect(out.tasks[0]).toMatchObject({ task_id: "task-1", status: "completed", agent_path: "root/h" })
    expect(out.tasks[0]!.resultText).toBe("child done")
    // non-owned → identical failure (no oracle)
    await expect(get.execute({ task_ids: ["task-999"] })).rejects.toThrow("unknown task: task-999")
    await expect(get.execute({ task_ids: ["bash-1"] })).rejects.toThrow("unknown task: bash-1")
    await expect(get.execute({ task_ids: ["not-a-task"] })).rejects.toThrow("unknown task: not-a-task")
    // bounds: 0 ids and 21 ids fail identically-shaped validation errors
    await expect(get.execute({ task_ids: [] })).rejects.toThrow(/between 1 and 20/)
    await expect(get.execute({ task_ids: Array.from({ length: 21 }, (_, i) => `task-${i}`) })).rejects.toThrow(/between 1 and 20/)
    // wait mode clamps [100, 600000]
    const waitOut = await get.execute({ task_ids: ["task-1"], wait: true, timeout_ms: 5000 })
    expect(waitOut.tasks[0]!.status).toBe("completed")
  }, 15_000)
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/subagent && pnpm vitest run test/task-control.test.ts`
Expected: FAIL — `get_task_output` 未註冊（tools 回傳缺）

- [ ] **Step 3: 實作**

`tools.ts`（新增於 jobOutputTool 後、回傳陣列加入）：

```ts
const getTaskOutputTool: Tool<
  { task_ids: string[]; wait?: boolean; timeout_ms?: number },
  { tasks: { task_id: string; status: string; outcome?: string; agent_path: string; description: string; resultText?: string; error?: string; time_created: number }[] }
> = {
  name: "get_task_output",
  description: "Read the durable output of 1..20 subagent tasks (task ids). wait: true polls each until terminal (timeout_ms clamped 100..600000). An id this session does not own fails identically to an unknown id (task or otherwise).",
  inputSchema: {
    type: "object",
    properties: {
      task_ids: { type: "array", items: { type: "string" }, description: "1..20 task ids." },
      wait: { type: "boolean", description: "Poll until every task is terminal (default false = snapshot only)." },
      timeout_ms: { type: "number", description: "Max wait in ms (default 30000, clamped 100..600000)." },
    },
    required: ["task_ids"],
  },
  isReadOnly: true,
  execute: async (args) => {
    if (!Array.isArray(args.task_ids) || args.task_ids.length < 1 || args.task_ids.length > 20) {
      throw new Error("get_task_output expects between 1 and 20 task ids")
    }
    // Ownership gate: EVERY id must be owned by this registry — a non-owned id
    // (foreign session, shell job, malformed) fails identically to an unknown
    // task: nothing here distinguishes them (R-D6 no-oracle posture).
    for (const taskId of args.task_ids) {
      if (!deps.tasks.get(taskId)) throw new Error(`unknown task: ${taskId}`)
    }
    const timeoutMs = Math.min(600_000, Math.max(100, args.timeout_ms ?? 30_000))
    if (args.wait === true) {
      const deadline = Date.now() + timeoutMs
      for (const taskId of args.task_ids) {
        await deps.tasks.wait(taskId, Math.max(0, deadline - Date.now()))
      }
    }
    return {
      tasks: args.task_ids.map((taskId) => {
        const t = deps.tasks.get(taskId)!
        return {
          task_id: t.id,
          status: t.status,
          ...(t.outcome !== undefined ? { outcome: t.outcome } : {}),
          agent_path: t.agentPath,
          description: t.description,
          ...(t.resultText !== undefined ? { resultText: t.resultText } : {}),
          ...(t.error !== undefined ? { error: t.error } : {}),
          time_created: t.timeCreated,
        }
      }),
    }
  },
}
```

回傳陣列：`return [spawnTool, waitTool, listTool, sendTool, interruptTool, followupTool, closeTool, resumeTool, jobOutputTool, jobListTool, jobKillTool, getTaskOutputTool, stopTaskTool]`（stopTaskTool 於 Task 13；本 task 只加 getTaskOutputTool → 12 支）。

- [ ] **Step 4: 跑測試確認通過**

Run: `cd packages/subagent && pnpm vitest run test/task-control.test.ts && pnpm vitest run test/tools.test.ts`
Expected: PASS（tools.test.ts 既有 `registers spawn_agent, wait_agent, list_agents` 例不受影響）

- [ ] **Step 5: Commit**

```bash
git add packages/subagent/src/tools.ts packages/subagent/test/task-control.test.ts
git commit -m "feat(M26-D4): get_task_output — 1..20 ids, bounded wait (100ms..600s), non-owned identical failure"
```

---

### Task 13: stop_task

**Files:**
- Modify: `packages/subagent/src/tools.ts`（新工具，刪除 Task 10 測試墊底中暫用 cancelSubtree——保留匯出）
- Modify: `packages/subagent/test/register.test.ts:11`（工具數 11 → 13）
- Test: `packages/subagent/test/task-control.test.ts`（D4 側）

**Interfaces:**
- Consumes: `cancelSubtree`（Task 10）
- Produces：
```ts
// name: "stop_task"
Tool<{ task_id: string; reason?: string }, { outcome: "cancellation-requested" | "already-finished"; cancelled: number; task_ids: string[] }>
```

- [ ] **Step 1: 寫失敗測試**

`packages/subagent/test/task-control.test.ts` 追加：

```ts
describe("M26-D4 stop_task", () => {
  it("stop_task cancels the task tree via cancelSubtree; unknown id fails identically", async () => {
    const ctx = createContext()
    const parentReg = createToolRegistry(ctx)
    parentReg.register({ name: "read", description: "read", inputSchema: {}, execute: async () => ({}) })
    const session = createSession()
    const jobs = createJobRegistry()
    const table = createAgentTable()
    const roles = createRoleRegistry()
    for (const r of builtinRoles()) roles.register(r)
    const model = createMockClient([{ role: "assistant", text: "done" }])
    const tasks = createTaskRegistry()
    // Deterministic setup: restore an accepted record (never via spawn — a mock
    // child settles within one tick, which would race the cancel). The live
    // table entry pins the abort + quiescence path with a deferred chain.
    tasks.restore({
      formatVersion: 1,
      tasks: [
        { id: "task-1", parentSessionId: "s1", callEventSeq: 2, agentPath: "root/h", description: "h", prompt: "p", agent: "general", delivery: "parent", status: "running", timeCreated: 1 },
      ],
      notifications: [],
    })
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers: createProviderRegistry(), exec: createExecService(), agents: createAgentRegistry(), tasks })
    const stop = all.find((t) => t.name === "stop_task")!
    const gate = Promise.withResolvers<void>()
    table.add("root/h", { path: "root/h", status: "running", session: createSession(), controller: new AbortController(), mailbox: [], followupChain: gate.promise })
    const out = await stop.execute({ task_id: "task-1", reason: "scope changed" })
    expect(out).toEqual({ outcome: "cancellation-requested", cancelled: 1, task_ids: ["task-1"] })
    expect(tasks.get("task-1")!.outcome).toBe("cancelled")
    expect(table.get("root/h")!.controller.signal.aborted).toBe(true)
    gate.resolve() // release quiescence so the test can exit cleanly
    // idempotent second call
    expect(await stop.execute({ task_id: "task-1" })).toEqual({ outcome: "already-finished", cancelled: 0, task_ids: [] })
    await expect(stop.execute({ task_id: "task-9" })).rejects.toThrow("unknown task: task-9")
  }, 15_000)
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/subagent && pnpm vitest run test/task-control.test.ts`
Expected: FAIL — stop_task 未註冊

- [ ] **Step 3: 實作**

```ts
const stopTaskTool: Tool<{ task_id: string; reason?: string }, { outcome: string; cancelled: number; task_ids: string[] }> = {
  name: "stop_task",
  description: "Cancel a subagent task and its whole descendant tree (durable cancelled markers + interrupt + quiescence wait). Already-terminal tasks report finished.",
  inputSchema: { type: "object", properties: { task_id: { type: "string" }, reason: { type: "string" } }, required: ["task_id"] },
  isReadOnly: false,
  execute: async (args) => {
    const existing = deps.tasks.get(args.task_id)
    if (!existing) throw new Error(`unknown task: ${args.task_id}`)
    if (existing.outcome !== undefined) return { outcome: "already-finished", cancelled: 0, task_ids: [] }
    const result = await cancelSubtree(deps, args.task_id, args.reason)
    return { outcome: "cancellation-requested", cancelled: result.cancelled, task_ids: result.taskIds }
  },
}
```

回傳陣列加入 stopTaskTool（13 支）。

`packages/subagent/test/register.test.ts` 兩處更新：

```ts
// :11 標題
it("seeds built-in roles, mounts the 13 tools, and returns the registries", () => {
// :27-32 schemas() 斷言
    expect(parentReg.schemas().map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "spawn_agent", "wait_agent", "list_agents", "send_message", "interrupt_agent",
        "followup_task", "close_agent", "resume_agent", "job_output", "job_list", "job_kill",
        "get_task_output", "stop_task",
      ]),
    )
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd packages/subagent && pnpm vitest run test/task-control.test.ts test/register.test.ts && pnpm vitest run`
Expected: PASS（subagent 全量——含既有 resume/persist/roles/jobs/child/tools）

- [ ] **Step 5: Commit**

```bash
git add packages/subagent/src/tools.ts packages/subagent/test/task-control.test.ts packages/subagent/test/register.test.ts
git commit -m "feat(M26-D4): stop_task — subtree cancel, idempotent already-finished, unknown id identical failure"
```

---

### Task 14: 整合驗證 + 相容性確認（wait_agent/list_agents/job_* 不破、事件型別全量）

**Files:**
- Modify: `packages/subagent/test/register.test.ts`（mount 完成後 tasks registry 可用例）
- Modify: `packages/subagent/test/tools.test.ts`（相容性例：job_output 對 subagent job 仍工作）
- Test: `packages/session-persistence/test/subagent-event.test.ts`（已於 Task 1；此 task 只跑全量）

**Interfaces:**
- Consumes: 全部既有工具 + task protocol
- Produces：無新介面——純驗證任務

- [ ] **Step 1: 寫整合測試**

`packages/subagent/test/register.test.ts` 追加（放在既有第一個 it 之後；`registerSubagent` 回傳值新增 `tasks` 欄位）：

```ts
it("returns a live task registry (durable records behind the mount)", () => {
  const ctx = createContext()
  const parentReg = createToolRegistry(ctx)
  const providers = createProviderRegistry()
  const exec = createExecService()
  const model = createMockClient([{ role: "assistant", text: "ok" }])
  const session = createSession()

  const { tasks } = registerSubagent(ctx, parentReg, {
    providers, exec, parentModel: model, parentSession: session,
  })

  expect(typeof tasks.submit).toBe("function")
  expect(typeof tasks.terminalize).toBe("function")
  expect(tasks.list()).toEqual([])
})
```

`packages/subagent/test/tools.test.ts` 追加（相容性）：

```ts
it("job_output still reads subagent jobs (unchanged path)", async () => {
  const { ctx, table, jobs, roles, parentReg, session, providers, model, exec } = setup()
  const tasks = createTaskRegistry()
  const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers, exec, agents: createAgentRegistry(), tasks })
  const spawn = all.find((t) => t.name === "spawn_agent")!
  const jobOut = all.find((t) => t.name === "job_output")!
  const spawned = await spawn.execute({ message: "do it", task_name: "h" }, { sessionId: "s", callEventSeq: 1 })
  await tasks.wait(spawned.task_id, 10_000)
  const out = await jobOut.execute({ job_id: spawned.job_id })
  expect(out.status).toBe("completed")
}, 15_000)
```

- [ ] **Step 2: 跑測試確認通過（全量）**

Run: `cd packages/subagent && pnpm vitest run`
Run: `cd packages/core-agent && pnpm vitest run`
Run: `cd packages/core-session && pnpm vitest run`
Run: `cd packages/session-persistence && pnpm vitest run`
Expected: PASS（零既有失敗；core-tools 無測試目錄，改靠全工作區 typecheck）

- [ ] **Step 3: typecheck 全工作區**

Run: `pnpm -r typecheck`
Expected: PASS（strict 全綠）

- [ ] **Step 4: Commit**

```bash
git add packages/subagent/test/register.test.ts packages/subagent/test/tools.test.ts
git commit -m "test(M26-D4): integration — 13-tool mount + task registry live; job_output compat unchanged"
```

---

## 5. 序列相依摘要

```
T1 (event types) → T4 (append)
T2 (ToolExec identity) → T4 (identity 取用)
T3 (store/registry) → T4 (submit/claim/terminalize/cancelTree/wait)
T4 (spawn wiring + blocking) → T5 (doc 格式)
T5 (recovery classify + mount) → T7 (ready chain 擴充)
T6 (drain) → T7 (hook + ready drain)
T7 (index.ts 整合) → T8
T8 (run.ts pass-through) → A-plan A1 整合一詞（opts.parentNotify）
T9 (permit) → 依 T3 submit
T10 (cancelSubtree) → 依 T3 cancelTree
T11 (close/interrupt 一致性) → 依 T10
T12 (get_task_output, 12 工具) → T13
T13 (stop_task, 13 工具) → T14
T14 (integration/typecheck) → 全量綠
```
