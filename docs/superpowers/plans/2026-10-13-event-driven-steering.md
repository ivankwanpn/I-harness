# Event-driven Steering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release eligible parent observations on durable user steer without restarting or canceling owned work, and push child durable updates into Desktop history.

**Architecture:** A finite observation helper in core-tools listens to exact owner lifecycle changes and pending user input. Exec accepts only a structural promotion wake source; Code Mode releases its outer observer while retaining nested invocations. An assembly-local child monitor supplies scoped live history and coalesced Desktop invalidations.

**Tech Stack:** Existing TypeScript/Node.js >=22.18, pnpm >=10, Vitest 3, core Session subscriptions, existing exec supervisor and React Desktop bridge. No new package or dependency.

**Spec:** `docs/superpowers/specs/2026-10-13-event-driven-steering-design.md`.

## Global Constraints

- Implementation starts on `codex/event-driven-steering` only after the external remediation source is merged and checked out on main.
- Implementation tasks add no package, global event bus, runtime dependency, profile/model/protocol selection change, or retry policy change. Versioning and release artifacts belong only to final delivery.
- Steer never aborts a job, child, cell, guest invocation, execution capture, or owner signal; stop/close/dispose retain cancellation and drain ownership.
- Never launch, submit, admit, resolve policy, request approval, or publish a final tool result twice to resume work after steer.
- Direct tools use trusted `ToolExec.session`; callbacks and wake sources never enter model JSON or durable events.
- Only currently pending `intent === "user" && delivery === "steer"` inputs release an observation. Queue inputs, system inputs, canceled inputs, and previously promoted inputs do not.
- `Inbox.claimAtStepBoundary()` remains the sole promotion path. Observation never consumes an inbox input or appends a user message.
- `ToolExec.resultConsumer === "code"` disables inner user-steer release. The outer cell observer yields; nested JS promises retain their actual result semantics.
- Foreground spawn retains `delivery: "tool"`; a yielded result includes its existing `task_id` for later `get_task_output`. No automatic parent notification promotion.
- Existing timeout clamps, unknown/foreign-ID errors, tool result pairing, process lifetime restrictions, output retention, and restoration semantics remain authoritative.
- Tests use mock/controlled models, temporary storage, isolated workflow stores, and local controlled processes. Never use saved user profiles or running app data as fixtures.

## Execution and review contract

The remediation was merged as PR #15 at 19d42e91. Implement on codex/event-driven-steering, with a plan-owned ledger. Each task is a testable deliverable with its own commit and review. Use one fresh implementer per task with no worker-spawned agents, then a fresh task reviewer given task brief/report/full BASE..HEAD diff and global constraints. Review must report spec compliance and quality independently. The controller resolves cross-task “cannot verify” items before advancing. Follow the SDD fix loop; do not run implementers concurrently.

Before each dispatch, extract its full task text plus global constraints and the exact interfaces it consumes. Capture BASE before dispatch, not HEAD~1 after completion. Reports include changed paths, commits, exact test commands/results, and unresolved concerns. Final whole-branch review receives the complete merge-base diff and ledger rulings/deferred findings. Tests already run on unchanged code need not be repeated by reviewers.

## File ownership map

| Task | Main responsibility | New files |
| --- | --- | --- |
| 1 | Finite observer + registry signals + producer migration | `packages/core-tools/src/observation.ts`, `packages/core-tools/test/observation.test.ts`, `packages/subagent/test/agent-table.test.ts` |
| 2 | Exec/workflow signals and same-capture shell promotion | none required; extend existing capture/exec/shell/workflow tests |
| 3 | Tool observations and outer Code Mode steer | none required; extend existing tools/runtime/register/broker tests |
| 4 | Child monitor, scoped history, complete Desktop route | `packages/session-executor/src/child-observation.ts`, `packages/session-executor/test/child-observation.test.ts` |
| 5 | Real assembly proof, docs and source delivery | `packages/session-executor/test/event-driven-steering.test.ts`, tracked design/plan docs |

### Task 1: Finite observation waits and coherent owner lifecycle changes

**Files:**
- Create: `packages/core-tools/src/observation.ts`, `packages/core-tools/test/observation.test.ts`, `packages/subagent/test/agent-table.test.ts`.
- Modify: `packages/core-tools/src/index.ts`; `packages/subagent/src/jobs.ts`, `task-protocol.ts`, `agent-table.ts`, `persist.ts`, `child.ts`, `tools.ts` (producer mutations only), `index.ts`; `packages/agent-team/src/scheduler.ts` where real lifecycle writes/wrappers occur.
- Test: `packages/subagent/test/jobs.test.ts`, `task-protocol.test.ts`, `persist.test.ts`, `task-control.test.ts`, `tools.test.ts`; existing agent-team scheduler tests found by `rg --files packages/agent-team/test`.

**Interfaces:**
- Consumes existing `ToolExec.session/resultConsumer`, core-session `subscribe` and `Inbox.pending`, registry producer APIs and identity objects.
- Produces `ObservationChanges`, `UserSteerSource`, `ObservationReason`, `ObservationOptions`, `waitForObservation(options): Promise<ObservationReason>`, `userSteerForTool(exec): UserSteerSource | undefined` exactly as design §1.
- Produces required `JobRegistry.subscribe(id, listener: (snapshot: JobSnapshot) => void): () => void`, `TaskRegistry.subscribe(taskId, listener: (record: Readonly<TaskRecord>) => void): () => void`, `AgentTable.update(path, expected, patch): boolean`, `AgentTable.subscribe(listener: (change: AgentTableChange) => void): () => void` exactly as design §2. Existing wait return types are unchanged.

- [ ] **Step 1: Add failing helper tests with real Session inbox and controlled sources.** Include this standalone test in observation.test.ts:

```ts
import { afterEach, expect, it, vi } from "vitest"
import { createSession, Inbox } from "@i-harness/core-session"
import { userSteerForTool, waitForObservation } from "../src/observation.ts"
afterEach(() => vi.useRealTimers())
it("broadcasts steer without consuming input or keeping timers/listeners", async () => {
  vi.useFakeTimers()
  const session = createSession(), inbox = new Inbox(session)
  const listeners = new Set<() => void>()
  const changes = { subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } } }
  const userSteer = userSteerForTool({session})
  const waits = [0, 1].map(() => waitForObservation({ready: () => false, changes, timeoutMs: 30_000, userSteer}))
  expect(vi.getTimerCount()).toBe(2)
  inbox.admit({inputId: "steer-1", text: "change focus", intent: "user", delivery: "steer"})
  expect(await Promise.all(waits)).toEqual(["user-steer", "user-steer"])
  expect(inbox.pending().map(row => row.inputId)).toEqual(["steer-1"])
  expect(session.events.some(row => row.type === "user/message")).toBe(false)
  expect(listeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  expect(userSteerForTool({session, resultConsumer: "code"})).toBeUndefined()
})
```

Also add exact cases: ready before subscription; ready during subscribe; steer pending before wait; cancellation/promotion before wait does not release; queue and system admissions do not release; pending at admission does release every observer; aborted before/during wait; ready and deadline same tick; thrown ready/pending rejects with zero retained resources; synchronously firing subscribe cleans up its late-returned disposer; after 10 seconds fake time only the original deadline timer exists. Each asynchronous test has an external deadline safety bound but does not use elapsed wall time as its correctness assertion.

- [ ] **Step 2: Run the new tests to observe missing API failures.** Run `pnpm --filter @i-harness/core-tools exec vitest run test/observation.test.ts`. Expected: import/API missing failure before implementation, not a test setup or unrelated type error. Record the result.

- [ ] **Step 3: Implement the helper and adapter.** Export symbols from index.ts. Use a cleanup-registration function that disposes immediately if already settled, one `setTimeout`, and a guarded check. Core decision logic:

```ts
// These locals belong inside waitForObservation's Promise executor.
const cleanups: (() => void)[] = []
let settled = false
const own = (off: () => void) => { if (settled) off(); else cleanups.push(off) }
const clear = () => { for (const off of cleanups.splice(0)) off() }
const finish = (reason: ObservationReason) => {
  if (settled) return
  settled = true; clear(); resolve(reason)
}
const check = () => {
  if (settled) return
  try {
    if (options.abortSignal?.aborted) finish("aborted")
    else if (options.ready()) finish("ready")
    else if (options.userSteer?.pending()) finish("user-steer")
    else if (Date.now() >= deadline) finish("deadline")
  } catch (error) { settled = true; clear(); reject(error) }
}
```

Define `deadline = options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs` after validating a present value as finite/nonnegative; `resolve/reject` come from the Promise executor. Subscribe owner then steer, register abort listener with own, register one remaining-time timer only for a finite deadline, and call check. Add an absent-timeout test proving zero timers while readiness and steer still settle. Surround subscription setup in try/catch using the same cleanup/reject path. Each setup step checks settled or uses own to prevent leaks after synchronous callbacks. Adapter subscription listens only to admitted/promoted/cancelled events and invokes the helper check; pending reads the Session inbox without promotion.

- [ ] **Step 4: Add failing registry/table tests before changing producers.** Add this jobs test:

```ts
it("observes a terminal transition even if the same job immediately reopens", async () => {
  const jobs = createJobRegistry(), {id} = jobs.registerJob("root", "subagent", "work")
  const seen: string[] = []
  const off = jobs.subscribe(id, snapshot => seen.push(snapshot.status))
  const waiting = jobs.wait(id, 30_000)
  jobs.updateJob(id, {status: "completed", output: "first"})
  jobs.updateJob(id, {status: "running", output: ""})
  await waiting
  expect(jobs.read(id).status).toBe("running")
  expect(seen).toEqual(["completed", "running"])
  off()
})
```

For tasks assert cancelTree emits once per affected ID only after all outcomes exist, terminal CAS does not emit twice, restored records complete immediately, unknown legacy wait resolves undefined, and subscribe rejects unknown ID before registering. For table use actual createSession/AbortController entries and assert update publishes coherent status/finalText/error; replacing entry then calling update with old expected returns false and emits nothing; removal emits old entry identity; Session replacement emits a change. For persistence wrapper assert one save per successful patch and no extra save for false/failed update. Run `pnpm --filter @i-harness/subagent exec vitest run test/jobs.test.ts test/task-protocol.test.ts test/agent-table.test.ts` and record expected API failures.

- [ ] **Step 5: Implement registry notifications, event waits, and producer migration.** Per-ID subscriber maps have unsubscribe pruning empty sets and guarded synchronous fanout over copied listener lists. Apply all mutation fields before notify. Legacy waits return early for unknown/current terminal IDs and otherwise use waitForObservation with a synchronous terminal latch in the change callback. Preserve producer.finish enrichment after kill and retryable cancel exceptions. Atomic table update core:

```ts
update(path, expected, patch) {
  if (table.get(path) !== expected) return false
  Object.assign(expected, patch)
  publish({kind: "update", path, entry: expected})
  return true
}
```

Here `table` is the existing private Map and `publish` is the new guarded synchronous table listener fanout. Migrate child.ts settlement to update using the entry originally launched; close/rebuild/followup in tools.ts, and restoreMirrorsAndSweep/dispose in index.ts use update. Apply each full lifecycle patch once, including clearing stale finalText at followup start. persistentAgentTable forwards subscribe and saves once after successful update. Preserve promise/mailbox bookkeeping without emitting. Inspect `rg -n 'status\s*=|session\s*=|closing\s*=|finalText\s*=|error\s*=' packages/subagent/src packages/agent-team/src` and account for every lifecycle writer, distinguishing reads and durable non-table objects.

- [ ] **Step 6: Verify and commit.** Run `pnpm --filter @i-harness/core-tools test`, `pnpm --filter @i-harness/subagent test`, `pnpm --filter @i-harness/agent-team test`, then `pnpm --filter @i-harness/core-tools --filter @i-harness/subagent --filter @i-harness/agent-team typecheck`. Confirm no recurring wait timers in registry tests and no altered notification/outbox counts. Stage only Task 1 paths and commit `feat: add event-driven observation and child lifecycle signals`.

**Review gate:** Helper race/cleanup proof, legacy wait compatibility, terminal/reopen semantics, correct persistence forwarding, all real producers migrated, and no stop/steer conflation. Task 2 consumes these exports only after this gate passes.

### Task 2: Exec/workflow observation and same-capture shell promotion

**Files:**
- Modify: `packages/exec/src/index.ts`, `service.ts`; `packages/workflow/src/runner.ts`, `index.ts` if exports need forwarding; `packages/shell/src/index.ts`; `packages/session-executor/src/assembly.ts` only if an actual facade requires forwarding (currently it passes the concrete workflow executor directly).
- Test: `packages/exec/test/exec.test.ts`, `capture-lifecycle.test.ts`, `enforcement.test.ts`, `wsl-target.test.ts`; `packages/workflow/test/workflow.test.ts`; `packages/shell/test/shell.test.ts`, `agent-shell.test.ts`, `sandbox-per-call.test.ts`; typed service fixtures in touched dependent tests.

**Interfaces:**
- Consumes Task 1 `userSteerForTool(exec)`; its source structurally satisfies ExecPromotionWake.
- Produces `ExecRunOptions.promotionWake?: ExecPromotionWake`, `PromotedRun.promotionReason?: "deadline" | "user-steer"`, required `ExecService.subscribeJob(jobId, listener): () => void` and `WorkflowExecutor.subscribeJob(jobId, listener): () => void` with `BackgroundJobView` callbacks. ExecPromotionWake has pending/subscribe only; exec imports neither core-tools nor Session.
- Produces WorkflowJobStore.subscribeJob plus update(jobId, patch) defined in design §3. All concrete and assembly-scoped facades preserve existing access control.

- [ ] **Step 1: Extend controlled exec fixtures with a steer source and failing tests.** Reuse the file's fake backend/handle factory and deferred settlement controls; this test-local source is complete:

```ts
function steerFixture() {
  let pending = false
  const listeners = new Set<() => void>()
  return {
    source: {pending: () => pending, subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } }},
    admit() { pending = true; for (const fn of [...listeners]) fn() },
    listenerCount: () => listeners.size,
  }
}
```

For each test hold the fake capture open, call service.run with promotionWake, admit steer, and assert returned promoted true/reason user-steer, exactly one backend launch, exactly one registered bash ID, zero aborted signals, zero wake listeners. Release the original capture and assert getOutput of that same ID becomes completed with its captured output. Repeat pending-before-run, no time threshold, timer/steer tie, completion/steer tie, rejection, explicit kill, and service.dispose. A complete capture before promotion returns actual ExecResult and registers no job. subscribeJob unknown/foreign IDs throw identically to getOutput; full settlement updates listener, root exit with incomplete cleanup does not become completed.

- [ ] **Step 2: Run focused red tests.** Run `pnpm --filter @i-harness/exec exec vitest run test/exec.test.ts test/capture-lifecycle.test.ts`. Record failure caused by missing promotionWake/subscribe behavior, then implement.

- [ ] **Step 3: Implement one capture arbiter and subscriptions.** Replace the existing timer-only Promise.race with an observer arbiter whose only owned cleanup resources are timer/wake subscription. The capture promise remains owned by exec. Core promotion closure, inside a Promise with local finished and started values:

```ts
const promote = (reason: "deadline" | "user-steer") => {
  if (finished) return
  finished = true
  cleanupObservation()
  resolve({jobId: registerJob(capture), promoted: true,
    ranForegroundMs: Date.now() - started, promotionReason: reason})
}
capture.complete.then(result => {
  if (finished) return
  finished = true; cleanupObservation(); resolve(result)
}, error => {
  if (finished) return
  finished = true; cleanupObservation(); reject(error)
})
```

`cleanupObservation` clears the local timer and stored unsubscribe; late disposer installation checks finished. Attach capture handlers before timer/wake triggers, subscribe then check wake.pending, and prefer already-published capture settlement before promote. Keep `makeCapture(command, streaming, false, threshold !== undefined)` to preserve original launch lifetime. Do not OR in wake presence: the fourth boolean selects retain-tree/host automatic lifetime, while every ordinary capture already supports registerJob. Wake-only runs remain complete-tree; both unsteered completion and completion after steer preserve existing descendant cleanup. Deadline-configured runs retain the existing autoPromotionLifetime path. Reject stream+promotionWake at runtime as with stream+backgroundAfterMs. registerJob publishes coherent copied views after existing mutation sites; subscribe validates access before inserting. Complete cleanup on dispose and failed kill as specified; never drive execution cancellation through wake.

- [ ] **Step 4: Add workflow and shell failures, then wire them.** Workflow isolated-store test creates a job, subscribes, calls update with final stdout/status/exitCode and asserts one coherent final view; kill aborts controller once and emits killed; late runner status cannot overwrite killed. Forward subscribe through the concrete executor, preserving its actual getOutput contract and unknown-ID errors. The workflow store currently has process-wide visibility; assembly passes it directly, so no new exact-session access restriction is introduced. Existing background/task projection filters remain; workflow killJob is also process-shared in the inspected implementation. Exec subscriptions retain their separate canAccessOwner gate. Shell fake-service tests capture the second run argument for bash, pwsh, and selected shell: direct foreground includes source; code consumer excludes it; explicit background still calls runBackground once. Return a fake PromotedRun with user-steer and assert text names new input and same job ID, while deadline retains elapsed text. Use this exact argument construction on foreground branches:

```ts
const promotionWake = userSteerForTool(exec)
const runOptions = {
  ...(backgroundAfterMs === undefined ? {} : {backgroundAfterMs}),
  ...(promotionWake === undefined ? {} : {promotionWake}),
}
```

Here backgroundAfterMs is that branch's existing configured threshold; retain existing command construction/policy and explicit background routing. Do not add wake to model schemas or command.abortSignal. Run `pnpm --filter @i-harness/workflow exec vitest run test/workflow.test.ts` and `pnpm --filter @i-harness/shell exec vitest run test/shell.test.ts test/agent-shell.test.ts test/sandbox-per-call.test.ts`, first red then green.

- [ ] **Step 5: Verify ownership/lifetimes and commit.** Run full test suites for exec, shell, workflow, then typechecks for exec, shell, workflow, subagent, session-executor. Update required subscribeJob methods in typed fake services using inert subscriptions only when tests never model job lifecycle; lifecycle fixtures must emit real transitions. Run enforcement and WSL fixtures proving steer does not expand transport lifetime or sandbox policy and incomplete settlement stays running. Add two explicit absent-backgroundAfterMs tests with a wake source: without steer, foreground completion still joins/cleans descendants and creates no job; with steer, the exact complete-tree capture survives until root completion and then cleans descendants under the same lifetime. Assert host autoPromotionLifetime cannot widen a wake-only run; configured deadline promotion still obeys its host restriction. No unowned descendant may remain after completion or dispose. Commit `feat: promote foreground shell observations on user steer`.

**Review gate:** One capture/launch/job under races; subscription authorization and cleanup; required service facade forwarding; no reverse exec dependency; WSL/host lifetime unchanged; shell presentation truthful; no policy/approval replay.

### Task 3: Interruptible direct observations and outer Code Mode yield

**Files:**
- Modify: `packages/subagent/src/tools.ts` (wait bodies/result types/descriptions); `packages/code-mode/src/types.ts`, `runtime.ts`, `register.ts`.
- Test: `packages/subagent/test/tools.test.ts`, `task-control.test.ts`, `task-notification.test.ts`, `code-mode.test.ts`; `packages/code-mode/test/runtime.test.ts`, `register.test.ts`, `broker.test.ts`, `human-stop.test.ts`, `text-retention.test.ts`.

**Interfaces:**
- Consumes Task 1 helper/registry/table subscriptions and Task 2 ExecService/WorkflowExecutor.subscribeJob.
- Produces direct still-running marker `{yielded:true, yield_reason:"user-steer"}`; wait_agent target identity change uses yield_reason `"target-changed"`. Existing result fields and timeout bounds stay intact.
- Produces CodeModeObserveOptions `{userSteer?: UserSteerSource}`, third optional observation argument to both runtime.exec(input, origin, observation) and runtime.wait(input, signal, observation), and CodeModeObservation optional yielded/yieldReason as design §4. Broker invocation/CodeModeOrigin remain unchanged.

- [ ] **Step 1: Add direct observation failures using each suite's existing tool/deps setup.** Every test creates a real parent Session and passes `{session}` as ToolExec. Hold producer settlement behind a deferred promise; trigger inbox.admit; await the observation before releasing the producer. Table-driven coverage includes wait_agent target/all, spawn foreground, get_task_output multiple IDs, and job_output for subagent/exec/workflow. Assert same IDs/current running state/yield marker, no timed_out on steer, no underlying abort, later actual completion. Unknown last task ID must fail before any subscription or wait. Foreground spawn's task delivery stays tool and notifications stay empty after eventual completion. Followup wait must observe entry lifecycle although original TaskRecord is completed. Target replacement must return target-changed with old identity. Deadline behavior and timeout clamps remain unchanged.

- [ ] **Step 2: Run red tests then implement direct observations.** Run `pnpm --filter @i-harness/subagent exec vitest run test/tools.test.ts test/task-notification.test.ts test/code-mode.test.ts`. Pass exec context into formerly contextless execute callbacks. Validate/read backend before subscribe. Adapt job observation with a terminal latch:

```ts
let terminalSeen = read().status !== "running"
const reason = await waitForObservation({
  ready: () => terminalSeen || read().status !== "running",
  changes: {subscribe: wake => subscribe(view => {
    terminalSeen ||= view.status !== "running"
    wake()
  })},
  timeoutMs, abortSignal: exec.abortSignal, userSteer: userSteerForTool(exec),
})
const latest = read()
const marker = reason === "user-steer" && latest.status === "running"
  ? {yielded: true as const, yield_reason: "user-steer" as const} : {}
```

`read` and `subscribe` are local closures selected from the already validated backend; timeoutMs uses existing default/bounds. Aborted reason follows the tool's existing cancellation error and drain handling, never adds a background success. Check it before constructing marker/output: an aborted owner must not render as an ordinary running or yielded observation. Direct abort tests assert the cancellation error and owned drain, distinct from steer tests asserting no abort. Target wait checks `table.get(path) !== originalEntry` separately from status; all-target subscribes table membership. Multi-task wait builds one combined changes.subscribe that registers all validated IDs and returns one disposer, readiness tests every outcome, and the final map preserves input order. Catch partial subscription failures and remove already-installed listeners before throwing. Spawn creates/claims once before observation. Remove the 10/20 ms loops rather than racing them with steer.

- [ ] **Step 3: Add Code Mode outer/inner failures.** This runtime test uses real worker invocation but a controlled tool result:

```ts
it("yields the outer observer while the one guest invocation remains pending", async () => {
  const session = createSession(), inbox = new Inbox(session)
  let release!: (value: unknown) => void, started!: () => void
  const invoked = new Promise<void>(resolve => { started = resolve })
  const result = new Promise<unknown>(resolve => { release = resolve })
  const invoke = vi.fn(() => { started(); return result })
  const runtime = createCodeModeRuntime({
    tools: () => [{name: "held", description: "fixture", inputSchema: {type: "object"}}], invoke,
  })
  try {
    const first = runtime.exec({code: 'text(await tools.held({}))', yield_time_ms: 60_000}, {},
      {userSteer: userSteerForTool({session})})
    await invoked
    inbox.admit({inputId: "steer-cell", text: "new focus", intent: "user", delivery: "steer"})
    const yielded = await first
    expect(yielded).toMatchObject({status: "running", yielded: true, yieldReason: "user-steer"})
    inbox.claimAtStepBoundary()
    const later = runtime.wait({cell_id: yielded.cellId, yield_time_ms: 60_000})
    release("actual result")
    expect(await later).toMatchObject({cellId: yielded.cellId, status: "completed", text: "actual result"})
    expect(invoke).toHaveBeenCalledTimes(1)
  } finally { await runtime.dispose() }
})
```

Import createSession/Inbox, userSteerForTool, vi, and createCodeModeRuntime in that test file. Repeat for a steer during a subsequent code_wait; pending-before-exec; completed-before-steer; explicit terminate and owner abort; two observers rejected; repeated steer cleanup. Add registration/broker tests for nested foreground spawn/job/shell (resultConsumer code disables their own steer release), and arbitrary held tool. Assert exactly one code/tool-call and code/result and original invocation ID. Extend retention test to steer during observation while spill is held, append later output, complete spill, then ensure both windows are delivered once and store commits remain ordered.

- [ ] **Step 4: Run red Code Mode tests, implement the observer-only argument, then green.** Run `pnpm --filter @i-harness/code-mode exec vitest run test/runtime.test.ts test/register.test.ts test/broker.test.ts test/human-stop.test.ts test/text-retention.test.ts`. In runtime observe, install current observation's steer subscription using the same idempotent cleanup as cell.wake/deadline; pending check happens after installation. A steer marks only this observation, wakes it, and never calls close or changes invocation/owner abort. Preserve retention before output construction and suppress marker if actual completion wins. Registration calls:

```ts
runtime.exec(input, origin, {userSteer: userSteerForTool(exec)})
runtime.wait(input, exec.abortSignal, {userSteer: userSteerForTool(exec)})
```

`input` and `origin` retain current register.ts construction. observationOutput spreads yielded/yield_reason only when runtime marks a steer yield. No broker reinvocation or origin widening.

- [ ] **Step 5: Verify and commit.** Run full subagent and code-mode tests and both typechecks. Inspect source search for residual `setTimeout(..., 10/20)` wait loops in tools/jobs/task-protocol. Any remaining timer must have a separate documented deadline/cleanup purpose. Commit `feat: yield parent observations without interrupting owned work`.

**Review gate:** Every wait backend covered; one overall multi-task deadline; no fake timeout/completion; identity-preserving path replacement; foreground delivery unchanged; guest promises truly await final values; Code Mode output/store/stop/drain behavior preserved.

**Task 3 addition — workflow_run:** Modify `packages/workflow/src/tool.ts` and its existing tool tests. Replace WAIT_POLL_MS with waitForObservation over executor.subscribeJob. Omit timeoutMs to preserve the original guard-owned ceiling; use userSteerForTool(exec). Return existing run_id/job_id/current status/output with the same additive user-steer marker. Preserve existing abort behavior (return current snapshot; do not kill the workflow) and nested code-consumer behavior. First write a held-workflow test admitting user steer before allowing its step to finish: observe running/yielded with the same IDs, no abort, then retrieve completion and assert one step launch. Also test completion, explicit observer abort, absent internal deadline, and zero recurring timers. Run the workflow tool tests red then green and workflow typecheck before Task 3 review.

### Task 4: Child durable push and live history readback

**Files:**
- Create: `packages/session-executor/src/child-observation.ts`, `packages/session-executor/test/child-observation.test.ts`.
- Modify: `packages/session-executor/src/assembly.ts`, `service.ts`; `packages/desktop-gateway/src/session-subagents.ts`, `host.ts`; `packages/desktop/src/main/sdk-runtime.ts`, `packages/desktop/src/shared/bridge.ts`, `packages/desktop/src/renderer/session/SubagentPane.tsx`.
- Test: `packages/desktop-gateway/test/session-subagents.test.ts`, `subagent-host.test.ts`; `packages/desktop/test/sdk-runtime.test.ts`, `subagent-pane.test.tsx`; `packages/session-executor/test/assembly.test.ts`.

**Interfaces:**
- Consumes AgentTable subscribe/update and exact entry/session identity from Task 1.
- Produces SessionAssembly optional liveChildSession(childSessionId): Session|undefined and onSubagentsChanged(listener: (change:{kind:"changed"|"closed"})=>void):()=>void.
- Produces dedicated bridge notification `desktop/session/subagents/changed` params `{sessionId: parentSessionId}`. Existing protocol version remains unchanged; this is an additive Desktop notification.
- Internal factory: `createChildObservation(table: AgentTable): { liveSession(id:string):Session|undefined; subscribe(listener:(change:{kind:"changed"|"closed"})=>void):()=>void; dispose():void }`.

- [ ] **Step 1: Add failing monitor tests.** Construct a real table/Session and this test:

```ts
it("follows Session replacement and stops listening to the old child", () => {
  const table = createAgentTable(), oldSession = createSession(), nextSession = createSession()
  const entry = {path: "root/worker", status: "running" as const, session: oldSession,
    sessionId: "child-1", controller: new AbortController(), mailbox: []}
  table.add(entry.path, entry)
  const monitor = createChildObservation(table), notify = vi.fn()
  monitor.subscribe(notify)
  table.update(entry.path, entry, {session: nextSession})
  notify.mockClear()
  append(oldSession, {type: "user/message", text: "old"})
  expect(notify).not.toHaveBeenCalled()
  append(nextSession, {type: "user/message", text: "new"})
  expect(notify).toHaveBeenCalledOnce()
  expect(monitor.liveSession("child-1")).toBe(nextSession)
  monitor.dispose(); notify.mockClear()
  append(nextSession, {type: "user/message", text: "after close"})
  expect(notify).not.toHaveBeenCalled()
  expect(monitor.liveSession("child-1")).toBeUndefined()
})
```

Add imports from current Session/table modules and the new factory. Additional tests cover add after initial subscribe, remove, same-path different SID replacement, transient assistant/chunk ignored, close emitted once, listener errors isolated, and no timers in monitor itself. Run `pnpm --filter @i-harness/session-executor exec vitest run test/child-observation.test.ts` red.

- [ ] **Step 2: Implement monitor and assembly ownership.** Subscribe table first, then enumerate and reconcile entries. Each observed row holds actual entry, actual Session, and unsubscribe. Session listener checks current table entry/session identity and `event.seq !== undefined` before guarded notify. No async I/O in callbacks. Dispose detaches all row and table subscriptions, empties maps, emits closed once and clears listeners. Wire methods from one monitor per production assembly and invoke dispose during assembly shutdown before child tables are discarded. Do not alter service.liveSession or SDK root-session subscriptions.

- [ ] **Step 3: Add gateway tests for live reads before persistence and coalescing.** Existing fake service exposes an assembly with liveChildSession and change subscription; coordinator.snapshot deliberately returns an older Session. After visibility/lineage validation, child history must include a newly appended live tool/result before flush and before turn/end. An unrelated parent must still fail. Fake timers: emit 100 changes synchronously, advance 49 ms (zero onChanged), advance 1 ms (one parent invalidation), then verify idle creates zero timers. Add new assembly attach, restored stub-to-live replacement, closed assembly cleanup, same root replacement, gateway close with pending timer, and control invalidation coalesced with lifecycle invalidation. Run `pnpm --filter @i-harness/desktop-gateway exec vitest run test/session-subagents.test.ts test/subagent-host.test.ts` red.

- [ ] **Step 4: Wire gateway scope and the full Desktop route.** Add `onAssembly(hook, options?: { includeExisting?: boolean })` with default future-only semantics. Test default no replay, opt-in current/future delivery exactly once, identity checks, initial-error hook removal, and unsubscribe in focused service tests. Gateway attaches with `{ includeExisting: true }`, owns per-root/assembly subscription handles, remove on closed, and use a one-shot 50 ms timer per dirty root. Use `options.onChanged` only through this coalescer. Host maps callback to `makeNotification("desktop/session/subagents/changed", {sessionId})`. Add method to main allowlist and bridge union. Pane permits it after existing workspace/session scope filter and schedules both catalog/history. Gateway history uses:

```ts
const chain = await lineage(parentId, childId)
const owned = authority(parentId, childId, chain)
const liveChild = owned?.assembly.liveChildSession?.(childId)
const session = liveChild ?? await snapshot(childId)
```

Keep parent visibility/open checks and sequence validation for the chosen Session. Catalog rows use their already validated exact runtime accessor before snapshot fallback. Intermediate owner snapshots use lineage-validated ancestor access. Reads never call assemblyFor/createSession/resume. On closed source unsubscribe and invalidate root once unless gateway close is in progress; close removes the onAssembly hook and all timers/listeners, then drains current control writes.

- [ ] **Step 5: Prove renderer routing and lifecycle then commit.** sdk-runtime test sends the new method from fake client and expects one sdk/notification. Pane test emits it for a known parent with a newly discovered child absent from old catalog: catalog refresh adds child; selected history reflects new durable tool/result without parent event. Wrong workspace/root does not refresh; pending responses from previous selection cannot overwrite current history; unmount/disconnect/close cancel queued work or prevent read application. Run full session-executor, desktop-gateway and Desktop test suites and typechecks for these packages. Commit `feat: push live child history updates to Desktop`.

**Review gate:** New child discovery, actual unflushed live history, all root/workspace/lineage checks, table/Session replacement cleanup, assembly/gateway/renderer teardown, bounded notifications, no per-token persistence, and no accidental global child authority.

### Task 5: End-to-end proof, docs and source PR

**Files:**
- Create: `packages/session-executor/test/event-driven-steering.test.ts`.
- Extend: `packages/session-executor/test/shell-promotion.test.ts`, `code-mode-children.test.ts`, `code-mode.test.ts`; `packages/core-agent/test/executor.test.ts`, `execute-tool-calls.test.ts`; `packages/desktop-gateway/test/input.test.ts`.
- Publish/update: `docs/superpowers/specs/2026-10-13-event-driven-steering-design.md`, `docs/superpowers/plans/2026-10-13-event-driven-steering.md`, and existing user-facing tool docs selected by `rg -n 'wait_agent|code_wait|backgroundAfterMs|subagent' docs README.md` (edit only sections describing changed behavior).

**Interfaces:**
- Consumes all four implementation tasks through real assembly/service/tool entry points. No new execution API.
- Produces frozen-head test evidence, complete source documentation, and a source PR on codex/event-driven-steering.

- [ ] **Step 1: Add real assembly controlled-model proof.** Use createSessionAssembly/createSessionExecutor/createMockClient and deferred fake tool/child result fixtures already used in code-mode-children/executor tests. For each supported family, first model response invokes the relevant waiting tool, wait for a deferred “started” hook, executor.submit({tier:"steer",text:"new direction"}), and allow the next model request before releasing child/process/tool. Capture provider requests and verify steer text is present once. Before releasing producer assert one dispatch, one observation result, same durable task/job/cell ID, running/yield marker, and zero cancel calls. Release producer, retrieve final result using the returned ID, and assert no second spawn/launch/invocation or second result for the old call ID. For foreground spawn assert original task delivery remains tool and no synthetic parent-result input was created.

The core synchronization sequence is deliberately ordered; `started` and `release` are deferred controls owned by each fixture:

```ts
executor.submit({tier: "send", text: "start held work"})
await started
executor.submit({tier: "steer", text: "new direction"})
await nextProviderRequest
expect(producerFinished).toBe(false)
expect(invocationCount).toBe(1)
release()
await executor.drain()
```

Define each deferred control when installing the fixture, resolve started at actual tool/child entry, resolve nextProviderRequest in the mock stream's second request, set producerFinished immediately before the controlled real result resolves, and count in that same entry point. Tests must fail if the next request waits for producer completion. Ensure finally releases held fixtures and disposes assembly even on assertion failure.

- [ ] **Step 2: Add exact boundary and stop regressions.** execute-tool-calls test dispatches one eligible wait plus one arbitrary held sibling: steer resolves eligible wait but nextProviderRequest remains pending until sibling release; no generic detach/replay. Code Mode version of arbitrary held nested tool releases outer observer while preserving its invocation. Stop after steer must cancel and join retained owned work; close child while waiting must not wait for deadline; output-retention test must keep already-consumed window. Gateway input test submits steer to one active Session and verifies its observer wakes, another Session does not, and queue/system/canceled admissions do not. The shell-promotion test uses existing heldOpenCommand/release file fixture and high time threshold: observation returns before release file exists, same job completes after creating release file, then no owned process remains on dispose. Cover bash/pwsh as supported by local fixture availability and report platform skips accurately.

- [ ] **Step 3: Run focused integration tests and write behavior docs.** Run `pnpm --filter @i-harness/session-executor exec vitest run test/event-driven-steering.test.ts test/shell-promotion.test.ts test/code-mode-children.test.ts test/code-mode.test.ts`, `pnpm --filter @i-harness/core-agent exec vitest run test/executor.test.ts test/execute-tool-calls.test.ts`, and `pnpm --filter @i-harness/desktop-gateway exec vitest run test/input.test.ts`. Update tool descriptions to say event-based wait, describe yield_reason and later ID retrieval, retain limits, and document outer vs nested Code Mode semantics. State child push covers durable history/status; state arbitrary sibling and required retention I/O limit prompt release. No claim that schedules, clocks, retries or all tooling are now timer-free. Commit `test: verify event-driven steering across owned runtimes`.

- [ ] **Step 4: Complete task and whole-branch reviews.** Task review checks integration evidence and docs against design; then controller packages whole merge-base..HEAD diff for final reviewer. Include task reports, exact verification results, deferred findings/rulings and supported scope. Fix actionable findings through one scoped reviewed fix wave per SDD, rerun covering tests after fixes, and resolve load-bearing defects before source delivery.

- [ ] **Step 5: Run final frozen-head verification.** Record `git rev-parse HEAD`, ensure `git status --short` shows no unexpected changes, then `pnpm verify:all` to a retained log outside tracked source. Check exit code and aggregate per-project/typecheck/E2E/reachability summary; a killed worker or missing suite result is not a pass. Record the same HEAD after completion. If source changed, rerun covering tests and aggregate on the new frozen HEAD. Do not claim green from an earlier commit.

- [ ] **Step 6: Deliver PR and version under the user's standing submit/merge/release instruction.** Before the final review/frozen gate, prepare v0.1.12 in desktop and desktop-gateway manifests, README download links, installer README examples and docs/releases/v0.1.12.md, describing supported paths and limits. Fetch remote and inspect divergence without force push. Push codex/event-driven-steering, create PR targeting main with same-ID/no-replay evidence, child live-history behavior, verification HEAD/results and latency limits. Use a body file, then attach the PR with mcp__codex_app__attach_artifact. Merge only the verified matching HEAD and verify the resulting source tree equals the tested tree. Preserve the user's external-audit branch.

- [ ] **Step 7: Build and validate release artifacts.** Parent verifies owned absolute build outputs before invoking Desktop dist and NSIS installer scripts into a fresh release-0-1-12-github directory. Reuse the previous release's validation approach with version-correct scripts: compare every ZIP file with payload and staged gateway/Desktop output byte-for-byte; run shipped-runtime synthetic usage/retry/wait/affinity and new steering/child-update smoke tests using isolated temporary settings and local fixtures. Never install over the user's running app. Generate SHA256SUMS and release-manifest with fresh verification, source/tree/PR identity and explicit scope limits. Upload installer, ZIP and both metadata assets to a GitHub release draft; verify remote sizes/digests before publishing Latest and verify tag/commit/assets again afterward. No live provider calls or profile changes.

**Review gate:** Model sees steer while original work is still held open; one execution/identity/result pair; later completion observable; stop remains authoritative; Desktop reads live durable child events; no unlicensed scheduler detachment; frozen-head aggregate evidence and precise source PR.

## Plan self-review record

- Design §1–2 maps to Task 1; §3 to Task 2; §4 to Task 3; §5 to Task 4; §6 and batch/result invariants to Task 5.
- No new package or exec-to-core-tools dependency. Subagent, shell, Code Mode already depend on core-tools; assembly already owns subagent table and core Session subscriptions.
- Legacy wait and Code Mode positional signatures remain; additive service subscription interfaces require typed mocks/facades to forward the new methods.
- Shell promotion and Code Mode continuation are distinct owners. Steer sources never enter abort metadata or code guest results.
- Child monitor uses exact Session identity and accessor scope; dedicated Desktop notification travels through host/main/bridge/pane and data reads use live child Session after lineage checks.
- Draft files are ignored and production code remains untouched during planning. The controller publishes tracked spec/plan only after external merge.
