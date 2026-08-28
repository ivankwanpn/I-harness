# M24a Subagent/Team Resume Consistency + Nested Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 補 M23 ensureResidentAgent 未覆蓋的 resume 一致性契約（G1-G4）+ 開通巢狀委派（delegationDepth 遞推 + max_depth + wait/list 擴充）。

**Architecture:** 把 run.ts 的 host 鏡像迴圈收進 `restoreState`（帶 coordinator 內建 mirror 重建），job id 契約化，waiting 保真，mount-time pending-inbox sweep；spawnChild 深度遞推 + max_depth guard。CLI 退回薄殼。

**Tech Stack:** TypeScript (strict), ESM, pnpm workspace, vitest, @i-harness/* 既有包。

**Spec:** `docs/superpowers/specs/2026-08-28-i-harness-m24a-subagent-resume-design.md`（本計畫從該 spec 論述；執行者兩者都讀）

## Global Constraints

- **零新外部依賴**（避免其他產品的私有庫；通用套件可用但本 M24a 不需要）
- **ESM + strict TS**（strict/noUnusedLocals/noUnusedParameters）
- **snapshot `formatVersion` 維持 1**（id 欄位本已存在——行為修正非格式變更）
- **無新 session event type**、session-persistence format 不變、agent-team 域 resume 邏輯不變（fold/recoverRoot 已正確）
- **subagent 工具名 snake_case**（`[A-Za-z0-9_-]`、≤64）
- **Windows 優先測試主戰場**（本 M24a 跨平台邏輯，Linux/bare 順帶）
- **A4 sweep + G3 waiting→waiting** 等依研究裁定（B/A）——spec 為 binding authority

---

### Task 1: restoreState — 內建鏡像重建 + job id 契約化 + waiting 保真（G1/G2/G3）

**Files:**
- Modify: `packages/subagent/src/persist.ts:76-114`（restoreState 簽名 + G1a/G2/G3）
- Modify: `packages/subagent/src/jobs.ts:22-29`（registerJob id 參數 + updateJob 回 false）
- Modify: `packages/subagent/src/index.ts:80-84`（restore 傳 persistence）
- Test: `packages/subagent/test/persist.test.ts`（增 4 例）

**Interfaces:**
- Consumes: `restoreState(state, snapshot)`（既有）、`SubagentPersistence { coordinator, stateId, parentSessionId }`（persist.ts:40）、`JobRegistry.registerJob(owner, kind, label)`、`JobRegistry.updateJob(id, patch)`
- Produces: `restoreState(state, snapshot, persistence?)`（persistence 可選——不傳=stub 同現狀）；`registerJob(owner, kind, label, id?)`、`updateJob(id, patch): boolean`（改回 boolean——回 false 表示未知 id）

- [ ] **Step 1: 寫失敗測試（persist.test.ts 增）**

```ts
// G2: job id 契約化 — restore 保留 persisted id
it("restoreState preserves persisted job ids (no re-count)", () => {
  const fresh = { jobs: createJobRegistry(), table: createAgentTable(), roles: createRoleRegistry() }
  const snap = { formatVersion: 1, jobs: [{ id: "subagent-5", owner: "root", kind: "subagent", label: "helper", status: "completed", output: "done", terminal: true }], agentTable: [], roles: [] }
  restoreState(fresh, snap as never)
  expect(fresh.jobs.read("subagent-5").status).toBe("completed")
  expect(fresh.jobs.list("root").some((j) => j.id === "subagent-5")).toBe(true)
})

// G3: waiting 保真（running → error，waiting → waiting）
it("restoreState keeps waiting waiting; running → error", () => {
  const fresh = { jobs: createJobRegistry(), table: createAgentTable(), roles: createRoleRegistry() }
  const snap = { formatVersion: 1, jobs: [], agentTable: [
    { path: "root/wait", status: "waiting", session: { formatVersion: 1, events: [] }, controller: new AbortController(), mailbox: [], sessionId: "c1" },
    { path: "root/run", status: "running", session: { formatVersion: 1, events: [] }, controller: new AbortController(), mailbox: [], sessionId: "c2" },
  ], roles: [] }
  restoreState(fresh, snap as never)
  expect(fresh.table.get("root/wait")!.status).toBe("waiting")
  expect(fresh.table.get("root/run")!.status).toBe("error")
})
```
（**G1a mirror 測試移到 Task 3**——restoreState 保持 sync，G1a mirror 在 registerSubagent 的 async step（Task 3）；Task 1 只測 G2/G3 同步部分。）

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/subagent && pnpm vitest run test/persist.test.ts`
Expected: FAIL（restoreState 簽名 vs 測試、G2 註冊新 id 非 subagent-5、G3 waiting→error）

- [ ] **Step 3: 實作**

```ts
// persist.ts — restoreState 簽名加 persistence + 內建鏡像
export function restoreState(
  state: { jobs: JobRegistry; table: AgentTable; roles: RoleRegistry },
  snapshot: SubagentStateSnapshot,
  persistence?: SubagentPersistence,
): void {
  // ... roles restore (unchanged)
  for (const entry of snap.agentTable) {
    const wasRunning = entry.status === "running" // G3: 去掉 waiting
    const status: ChildStatus = wasRunning ? "error" : entry.status
    state.table.add(entry.path, {
      path: entry.path,
      status,
      session: createSessionFromEmpty(), // placeholder; mirror replaces below
      controller: new AbortController(),
      ...(entry.finalText !== undefined ? { finalText: entry.finalText } : {}),
      ...(wasRunning || entry.error !== undefined ? { error: wasRunning ? "interrupted by resume" : entry.error } : {}),
      mailbox: [...entry.mailbox],
      ...(entry.jobId !== undefined ? { jobId: entry.jobId } : {}),
      ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
      ...(entry.roleName !== undefined ? { roleName: entry.roleName } : {}),
      ...(entry.lastInboxSeq !== undefined ? { lastInboxSeq: entry.lastInboxSeq } : {}),
    })
  }
  // G1a: mirror rebuild for entries with sessionId + persistence.coordinator
  if (persistence) {
    for (const entry of state.table.entries().values()) {
      if (!entry.sessionId) continue
      try {
        // (G1a core: coordinator.load(entry.sessionId) → hooked mirror)
        // NOTE: restoreState is sync today; load is async. See Task 3 for the
        // async wrapper decision — this task keeps restoreState sync (mirror
        // rebuild is deferred to the A4 sweep's ensureResidentAgent path, which
        // is async and already rebuilds session from load). See step 5.
      } catch { /* load failed — keep stub, status→error already set */ }
    }
  }
  // G2: jobs restore with persisted id
  for (const rec of snap.jobs) {
    const wasRunning = rec.status === "running"
    const { id } = state.jobs.registerJob(rec.owner, rec.kind, rec.label, rec.id)
    state.jobs.updateJob(id, {
      status: wasRunning ? "error" : rec.status,
      output: wasRunning ? "interrupted by resume" : rec.output,
    })
  }
}
```

（**Controller note — G1a design refinement**: `restoreState` is currently SYNC; making the mirror rebuild async would ripple into `registerSubagent`'s sync call chain. The clean resolution per spec §5 (integration ordering) is: **keep restoreState sync for identity/status/jobs (Task 1), and move the mirror rebuild into an ASYNC step that runs right after restore in `registerSubagent`** (Task 3, alongside the A4 sweep — both async, both run before mountAgentTeams). The Task 1 test above asserts the **G2/G3** parts; the **G1a hooked-mirror** assertion moves to Task 3's async step. If the implementer finds restoreState CAN be made async without breaking callers, that's also acceptable — but the minimal-diff path is async-after-restore.)

- [ ] **Step 4: jobs.ts — registerJob id 參數 + updateJob 回 boolean**

```ts
// jobs.ts
export interface JobRegistry {
  registerJob(owner: string, kind: string, label: string, id?: string): { id: string }  // id optional
  updateJob(id: string, patch: Partial<Pick<JobSnapshot, "status" | "output">>): boolean // false = unknown id
  // ...
}
function nextId(kind: string): string { ... } // unchanged
registerJob(owner, kind, label, id) {
  const resolved = id ?? nextId(kind)
  if (records.has(resolved)) throw new Error(`duplicate job id: ${resolved}`) // fail-loud on collision
  records.set(resolved, { id: resolved, kind, label, status: "running", output: "", owner, terminal: false })
  return { id: resolved }
},
updateJob(id, patch) {
  const rec = records.get(id)
  if (!rec) return false // G2: observable, not silent
  if (rec.terminal && patch.status !== "running") return true
  if (patch.status === "running") rec.terminal = false
  if (patch.status !== undefined) rec.status = patch.status
  if (patch.output !== undefined) rec.output = patch.output
  if (rec.status !== "running") rec.terminal = true
  return true
},
```

- [ ] **Step 5: index.ts — restore 傳 persistence**

```ts
// subagent/src/index.ts L80-84
if (opts.restoredState) {
  restoreState({ jobs, table, roles }, opts.restoredState, opts.persist) // persistence optional
}
```

- [ ] **Step 6: 跑測試確認通過**

Run: `cd packages/subagent && pnpm vitest run test/persist.test.ts && pnpm vitest run test/jobs.test.ts`
Expected: PASS（既有 28 + 新 3；jobs.test.ts 既有均用 `registerJob` 3 參數——不破）

- [ ] **Step 7: Commit**

```bash
git add packages/subagent/src/persist.ts packages/subagent/src/jobs.ts packages/subagent/src/index.ts packages/subagent/test/persist.test.ts packages/subagent/test/jobs.test.ts
git commit -m "feat(M24a): restoreState — job-id contract (G2) + waiting fidelity (G3); registerJob persisted-id; updateJob fail-visible (returns boolean)"
```

---

### Task 2: delegateDepth 遞推 + max_depth guard（B1/B2） + wait/list 擴充（B4/B5）

**Files:**
- Modify: `packages/subagent/src/child.ts:53-65`（delegationDepth 遞推）
- Modify: `packages/subagent/src/tools.ts:15-31,52-64,73-103`（maxDepth + spawn_agent guard + wait/list 擴充）
- Test: `packages/subagent/test/child.test.ts`、`test/tools.test.ts`（增）

**Interfaces:**
- Consumes: `SubagentToolDeps`（tools.ts:15）、`spawnChild`（child.ts:34）、`wait_agent`/`list_agents` 既有工具
- Produces: `SubagentToolDeps.maxDepth?: number`（預設 1）；`spawnChild` 用 parent 深度；`wait_agent` 加 `target?`、timeout clamp；`list_agents` 加欄位/scope

- [ ] **Step 1: 寫失敗測試**

```ts
// child.test.ts — delegationDepth 遞推
it("spawnChild sets delegationDepth = parent depth + 1", async () => {
  const parent = createSession()
  parent.header = { delegationDepth: 1, origin: "subagent" }
  // spawnChild(deps with parentSession: parent, childSessions fake) → expect coordinator.create called with delegationDepth: 2
})

// tools.test.ts — max_depth
it("spawn_agent rejects when caller depth >= maxDepth", async () => {
  const deps = { ...setup(), maxDepth: 1, parentSession: sessionWithDepth(1) }
  await expect(spawnTool.execute({ message: "x", task_name: "y" })).rejects.toThrow(/max/)
})

// tools.test.ts — wait_agent target
it("wait_agent with target waits for that specific child", async () => { ... })

// tools.test.ts — list_agents descendants
it("list_agents with scope descendants returns nested entries", async () => { ... })
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/subagent && pnpm vitest run test/child.test.ts test/tools.test.ts`
Expected: FAIL（delegationDepth 仍 1 / maxDepth guard 不存在 / wait/list 不支援）

- [ ] **Step 3: 實作 child.ts**

```ts
// child.ts L53-65 — 遞推
const parentDepth = opts.parentSession.header?.delegationDepth ?? 0
const childDepth = parentDepth + 1 // dsh: resolveChildDepth = parent + 1
// coordinator.create: delegationDepth: childDepth
// childSession.header: delegationDepth: childDepth
```

- [ ] **Step 4: 實作 tools.ts**

```ts
// SubagentToolDeps + maxDepth
export interface SubagentToolDeps {
  // ...existing
  maxDepth?: number // default 1 — caller depth >= maxDepth rejects spawn (B2)
}
// spawn_agent execute (L54-64) — before spawnChild
const callerDepth = deps.parentSession.header?.delegationDepth ?? 0
const maxDepth = deps.maxDepth ?? 1
if (callerDepth >= maxDepth) {
  throw new Error(`subagent nesting depth limit reached (max ${maxDepth}) — cannot spawn from depth ${callerDepth}`)
}
// wait_agent — inputSchema 加 target?; timeout clamp
const timeoutMs = Math.min(300_000, Math.max(100, args.timeout_ms ?? 30_000))
if (args.target) { await waitForTarget(deps, args.target, deadline) } else { /* existing all-settled loop */ }
// list_agents — output 欄位 + scope
const out = [...deps.table.entries().values()].filter((e) => (args.scope === "descendants" ? e.path.startsWith((args.path_prefix ?? "root") + "/") : args.path_prefix ? e.path.startsWith(args.path_prefix) : true))
  .map((e) => ({ path: e.path, status: e.status, ...(e.roleName ? { roleName: e.roleName } : {}), ...(e.jobId ? { jobId: e.jobId } : {}), ...(e.sessionId ? { sessionId: e.sessionId } : {}), ...(e.finalText !== undefined ? { finalText: e.finalText } : {}), ...(e.error !== undefined ? { error: e.error } : {}) }))
```

- [ ] **Step 5: Run + Commit**

Run: `cd packages/subagent && pnpm vitest run test/child.test.ts test/tools.test.ts && pnpm vitest run`（全綠）
Commit:
```bash
git add packages/subagent/src/child.ts packages/subagent/src/tools.ts packages/subagent/test/child.test.ts packages/subagent/test/tools.test.ts
git commit -m "feat(M24a): nested delegation (delegationDepth recursion + max_depth guard) + wait_agent target/timeout clamp + list_agents fields/scope"
```

---

### Task 3: G4 sweep + G1a async mirror + host 薄殼（A4/G1a/G7）

**Files:**
- Modify: `packages/subagent/src/index.ts`（registerSubagent: restore 後 async mirror + A4 sweep + maxDepth 傳遞）
- Modify: `packages/subagent/src/tools.ts`（`sweepPendingInbox` 純函數——可測試）
- Modify: `apps/cli/src/run.ts:246-262`（鏡像迴圈刪除）、`:174-190`（main header 恢復）
- Test: `packages/subagent/test/resume.test.ts`（增 G1a/G4）、`apps/cli/test/cli.test.ts`（G7）

**Interfaces:**
- Consumes: `restoreState`（Task 1）、`ensureResidentAgent`/`driveFollowups`（tools.ts 既有）、`registerSubagent` opts.persist
- Produces: `sweepPendingInbox(deps: SubagentToolDeps, table: AgentTable): Promise<void>`（exported 可測）；registerSubagent 不再同步 restore 鏡像（改 async after-restore）

- [ ] **Step 1: 寫失敗測試（resume.test.ts 增）**

```ts
// G1a: registerSubagent (with persistence + restoredState) rebuilds hooked mirror (async after restore)
it("registerSubagent restores mirrored sessions (G1a) — append enqueues durably", async () => {
  const ctx = createContext()
  const parentReg = createToolRegistry(ctx)
  const coordinator = { load: vi.fn(async () => ({ session: { formatVersion: 1, events: [{ type: "user/message", text: "old", seq: 0 }], header: {} }, version: 1 })), enqueue: vi.fn(), flush: vi.fn(async () => {}) } as unknown as SessionCoordinator
  const restoredState = { formatVersion: 1, jobs: [], agentTable: [{ path: "root/helper", status: "waiting", session: { formatVersion: 1, events: [] }, controller: new AbortController(), mailbox: [], sessionId: "child-abc", roleName: "research", lastInboxSeq: 0 }], roles: [] }
  registerSubagent(ctx, parentReg, { parentSession: createSession(), parentCtx: ctx, parentModel: model, providers, exec, parentRegistry: parentReg, restoredState, persist: { coordinator, stateId: "main", parentSessionId: "main" } })
  const entry = table.get("root/helper")!
  append(entry.session, { type: "subagent/inbox", messageId: "m1", message: "hi" })
  expect(coordinator.enqueue).toHaveBeenCalledWith("child-abc", expect.anything())
})

// G4: sweepPendingInbox drives a waiting entry with unconsumed inbox
it("sweepPendingInbox drives a waiting entry with seq > lastInboxSeq", async () => {
  const { deps, table } = setup()
  const entry = restoredEntry("child-abc", "research")
  entry.status = "waiting" as const
  entry.lastInboxSeq = 0
  // durable inbox event seq 1 (already in table? — build session with an inbox event)
  append(entry.session, { type: "subagent/inbox", messageId: "m1", message: "hi" }) // seq 0 → lastInboxSeq 0 → NOT > 0? use seq 1
  // ... construct with seq=1 so lastInboxSeq=0 < 1
  table.add("root/helper", entry)
  const driven = vi.fn()
  // driveFollowups spy — inject via deps.rebuild? No — sweepPendingInbox calls driveFollowups internally.
  // Use the export: sweepPendingInbox(deps, table) with deps.agents empty + deps.rebuild present → ensureResident + drive.
  await sweepPendingInbox(deps, table)
  // assert the entry's followupChain ran (finalText updated or inbox consumed)
})
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd packages/subagent && pnpm vitest run test/resume.test.ts`
Expected: FAIL（sweepPendingInbox 不存在 + registerSubagent 不重建 mirror）

- [ ] **Step 3: 實作（tools.ts `sweepPendingInbox` + index.ts 接線）**

```ts
// tools.ts — export sweepPendingInbox (testable pure-ish)
export async function sweepPendingInbox(deps: SubagentToolDeps, table: AgentTable): Promise<void> {
  for (const entry of table.entries().values()) {
    if (entry.status !== "waiting" || !entry.sessionId) continue // A4 guard
    const hasPending = entry.session.events.some((e) => (e as { type: string }).type === "subagent/inbox" && (e as { seq?: number }).seq !== undefined && (e as { seq: number }).seq > (entry.lastInboxSeq ?? -1))
    if (!hasPending) continue
    if (!deps.agents.get(entry.sessionId)) {
      const ok = await ensureResidentAgent(deps, entry)
      if (!ok) continue // rebuild failed → skip (conservative)
    }
    void driveFollowups(deps, entry, entry.sessionId).catch(() => {
      // fail-visible log, not throw
      console.warn(`[subagent] pending inbox sweep failed for ${entry.sessionId}`)
    })
  }
}
```

**Ordering resolution (controller-verified, binding):** `restoreMirrorsAndSweep` MUST complete BEFORE `mountAgentTeams` runs `recoverRoot` (recoverRoot delivers to `entry.session` — sweep drives pending inbox). Fire-and-forget `void` would race. **Clean fix:** `RegisterSubagentResult` gains `ready: Promise<void>` (resolves after mirror+sweep; resolves immediately when no restore); run.ts awaits it before mountAgentTeams. Check the current `RegisterSubagentResult` interface (`packages/subagent/src/index.ts` — it's `{ roles, jobs, table, agents, ensureResident }`) and add `ready`.

```ts
// index.ts — RegisterSubagentResult gains ready
export interface RegisterSubagentResult {
  // ...existing (roles, jobs, table, agents, ensureResident)
  ready: Promise<void> // resolves when mirror+sweep complete (no-op if no restore)
}
// registerSubagent body:
let ready: Promise<void> = Promise.resolve()
if (opts.restoredState) {
  restoreState({ jobs, table, roles }, opts.restoredState, opts.persist) // Task 1
}
if (opts.persist) { wireSubagentPersistence(...) } // existing
const subagentDeps: SubagentToolDeps = { ...existing, maxDepth: opts.maxDepth }
if (opts.restoredState && opts.persist) {
  ready = restoreMirrorsAndSweep(subagentDeps, table)
}
// return { ...existing, ensureResident: ..., ready }
```

```ts
// index.ts — restoreMirrorsAndSweep (async; exported or internal)
async function restoreMirrorsAndSweep(deps: SubagentToolDeps, table: AgentTable): Promise<void> {
  for (const entry of table.entries().values()) {
    if (!entry.sessionId || !deps.childSessions) continue
    try {
      const loaded = await deps.childSessions.coordinator.load(entry.sessionId)
      const resumed = createSession((ev) => {
        deps.childSessions!.coordinator.enqueue(entry.sessionId!, [ev])
        if (ev.type === "turn/end") void deps.childSessions!.coordinator.flush(entry.sessionId!).catch(() => {})
      })
      resumed.events.push(...loaded.session.events)
      resumed.formatVersion = loaded.session.formatVersion
      resumed.header = loaded.session.header
      entry.session = resumed
    } catch {
      entry.status = "error"; entry.error = "child log unavailable after resume" // G1a fail-visible
    }
  }
  await sweepPendingInbox(deps, table)
}
```

```ts
// run.ts — await ready before mountAgentTeams (the team mount sits AFTER registerSubagent):
const subagent = registerSubagent(ctx, tools, { ... })
await subagent.ready // G1a/G4 complete before mountAgentTeams (recoverRoot)
// then mountAgentTeams(...)
```

- [ ] **Step 4: run.ts 薄殼**

```ts
// apps/cli/src/run.ts — 刪除 L246-262 鏡像迴圈（收進 registerSubagent），留 main header 恢復：
if (opts.resumeSessionId && opts.coordinator) {
  try {
    const { session: restored } = await opts.coordinator.load(opts.resumeSessionId)
    session.events.push(...restored.events)
    session.formatVersion = restored.formatVersion
    session.header = restored.header // G7: 補 header 恢復
  } catch (err) { ... } // existing
}
```

- [ ] **Step 5: Run + Commit**

Run: `cd packages/subagent && pnpm vitest run && cd packages/agent-team && pnpm vitest run && cd apps/cli && pnpm vitest run`（全綠——agent-team lifecycle 不破、cli resume e2e 不破）
Commit:
```bash
git add packages/subagent/src/index.ts packages/subagent/src/tools.ts packages/subagent/test/resume.test.ts apps/cli/src/run.ts apps/cli/test/cli.test.ts
git commit -m "feat(M24a): registerSubagent — async mirror rebuild (G1a) + pending-inbox sweep (G4); CLI thin-shell (mirror loop removed, main header restored G7)"
```

---

## 驗證（全文完）

- [ ] **Step: 全 workspace 測試**

```bash
cd /d/agent-complete/I-harness && pnpm -r test && pnpm -r typecheck
```
Expected: ALL PASS（subagent 既有 54 + 新、agent-team 92 不破、cli 50+1 不破——鏡像迴圈刪除後 cli resume e2e 仍綠）

## 自審紀錄（M24a plan）

1. **Spec 覆蓋**：G1a（Task 3 mirror rebuild）→ Task 1/3；G2（Task 1 job id）→ Task 1；G3（Task 1 waiting）→ Task 1；G4（Task 3 sweep）→ Task 3；B1/B2（Task 2 child/tools）→ Task 2；B4/B5（Task 2 wait/list）→ Task 2；G7（Task 3 run.ts header）→ Task 3。全覆蓋。
2. **Placeholder 掃描**：Task 1 Step 3 的 restoreState G1a mirror 是「pending + note」——**有意**（Controller note：restoreState 保持 sync，G1a mirror 移到 Task 3 async step——Task 1 只做 G2/G3 同步部分；測試斷言 G2/G3）。其餘步驟含實際代碼。
3. **型別一致**：`registerJob(owner, kind, label, id?)`、`updateJob(id, patch): boolean`、`sweepPendingInbox(deps, table)`、`SubagentToolDeps.maxDepth?`——跨任務一致。
4. **已知取捨**：restoreState 保持 sync（G1a mirror 是 async——registerSubagent 的 restore 呼叫鏈是 sync；async mirror 走 `restoreMirrorsAndSweep` 在 restore 後、mount 前——spec §5 整合時序相符）。**Ordering race resolved**：`RegisterSubagentResult.ready: Promise<void>`（mirror+sweep 完成才 resolve；無 restore 時立即 resolve）——run.ts `await subagent.ready` 後才 mountAgentTeams（此時 recoverRoot 對 entry.session 投遞、sweep 已 drive pending——無競態）。registerSubagent 現 return `{ roles, jobs, table, agents, ensureResident }`——`ready` 加進（additive）。
