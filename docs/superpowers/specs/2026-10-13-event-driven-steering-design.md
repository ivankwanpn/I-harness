# Event-driven observation and child updates

Date: 2026-10-13. Source inspected initially at `fix/external-audit-remediation` / `d41ab6f4`; parent subsequently merged PR 15 at `19d42e91` and created `codex/event-driven-steering`. This file records design, not completed implementation or verification.

## Goal and accepted behavior

When a pending user steer arrives during an eligible observation, return the parent's observation promptly with the existing job, task, or cell identity. Already started work continues under its original owner and runs exactly once. The next existing provider boundary consumes the durable input. Desktop child status and durable history update from child activity even when the parent writes no new events.

Eligible observations are direct `wait_agent`, foreground `spawn_agent` settlement, `get_task_output(wait:true)`, all three `job_output(wait:true)` backends, direct foreground `bash`/`pwsh`/selected `shell`, and outer `code_exec`/`code_wait`. Child admission, policy approval, model resolution, persistence required to publish an honest output window, and arbitrary direct tool bodies are not detachable observations.

`workflow_run(wait:true)` is also an eligible observation of its existing owned job, retaining its existing guard-owned ceiling and abort-snapshot contract. Direct shell output keeps the existing promoted shape (`job_id`, `promoted`, `ran_foreground_ms`, explanatory stdout); `PromotedRun.promotionReason` is the service field, rather than a new model-facing `yielded` field. See [the current behavior contract](../../concurrency-and-wake.md) for concrete tool shapes and source integration commands.

The scheduler still drains its dispatched batch. An arbitrary already-dispatched sibling can delay the next provider step after an eligible wait has yielded. This phase does not change scheduler dispatch policy, invent a continuation for arbitrary direct tools, or race/detach the whole tool batch.

## Binding constraints

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

## 1. Observation API and races

Add `packages/core-tools/src/observation.ts`, exported from the existing package entry point:

```ts
export interface ObservationChanges {
  subscribe(listener: () => void): () => void
}
export interface UserSteerSource extends ObservationChanges {
  pending(): boolean
}
export type ObservationReason = "ready" | "deadline" | "user-steer" | "aborted"
export interface ObservationOptions {
  ready(): boolean
  changes: ObservationChanges
  timeoutMs?: number
  abortSignal?: AbortSignal
  userSteer?: UserSteerSource
}
export function waitForObservation(options: ObservationOptions): Promise<ObservationReason>
export function userSteerForTool(exec: ToolExec): UserSteerSource | undefined
```

When present, `timeoutMs` is a finite nonnegative duration; absent means no observer deadline and no timer. Tool callers preserve current defaults/clamps; legacy registry wrappers preserve their existing missing-ID and timeout result contracts. The helper uses at most one deadline timer, no interval, and no repeated sleep. Subscribe first, then inspect current predicates to close setup races. A synchronous subscription callback must also be safe: cleanup registered after settlement is immediately disposed. Callback exceptions are caught and reject the helper after cleanup; they never throw into a Session append or registry mutation.

Every check orders explicit abort, current readiness, pending steer, and expired deadline. Actual result rendering re-reads owner state: a completion that became visible before rendering is reported truthfully as completion, not running/yielded. Settlement is idempotent. Every return and throw removes all subscriptions, abort listeners, and timers. Observer cleanup only removes observer resources. `aborted` is an internal decision, never a normal yielded/running result: callers retain their existing cancellation error and owner drain path. No observation success may mask an aborted owner.

`userSteerForTool` returns undefined without a session or for code consumers. Otherwise it builds a lazy source over that exact Session. `pending()` uses `new Inbox(session).pending().some(...)`; subscription filters `agent/input/admitted`, `agent/input/promoted`, and `agent/input/cancelled` before waking. It does not allocate a permanent listener. The helper rechecks pending on each wake; a canceled-before-observation admission cannot release a new observation. An admission already observed during an active wait may have released it before a later cancellation, which is truthful. One pending steer broadcasts to all active eligible observations.

Registry subscription callbacks run synchronously after coherent mutations. Individual listener failures must not interrupt producers or other listeners. Subscriptions are process-local and absent from persisted snapshots.

## 2. Registry lifecycle seams

Add these signatures to existing interfaces:

```ts
// JobRegistry
subscribe(id: string, listener: (snapshot: JobSnapshot) => void): () => void
// TaskRegistry
subscribe(taskId: string, listener: (record: Readonly<TaskRecord>) => void): () => void
// AgentTable
update(path: string, expected: ChildAgentEntry,
  patch: Partial<Omit<ChildAgentEntry, "path">>): boolean
subscribe(listener: (change: AgentTableChange) => void): () => void
export interface AgentTableChange {
  kind: "add" | "update" | "remove"
  path: string
  entry: ChildAgentEntry
}
```

Job/task subscribe validates the ID before registration and does not replay. Consumers subscribe then inspect. Job callbacks receive a copied snapshot; task callbacks receive a shallow copy so later producer changes do not mutate delivered facts. `JobRegistry.wait(id, timeoutMs): Promise<void>` and `TaskRegistry.wait(id, timeoutMs): Promise<TaskRecord | undefined>` remain callable as before, now using event observation. Unknown IDs in these legacy waits still resolve immediately. Public subscribe throws the existing `unknown job/task` error for unknown IDs.

A job observation latches a terminal transition synchronously inside its change callback before waking the helper. A terminal-to-running reopen in the same stack must not strand an observation of the old run. Its eventual tool payload still reads current state, which may now be running. The legacy wait returns void as before. A newly started wait after reopen observes the new run. Task outcomes remain one-shot CAS.

Emit for job registration/change/producer finish/kill and task submission/claim/terminalization/restore/cancelTree where applicable to a registered ID. `cancelTree` updates the whole tree first and then notifies every affected ID, preserving coherent tree state and the existing outbox/save behavior. Do not invoke `onTerminalized` a second time or change its historical cancelTree contract.

`AgentTable.update` only mutates when `get(path) === expected`; otherwise it returns false. It applies the whole patch before emitting once. This prevents late completion from a closed/replaced child from altering the new child occupying its path. Preserve mutable Map and entry types for source compatibility; internal lifecycle producers must use update, add, or remove. External direct mutation remains unobservable and is documented as unsupported for lifecycle notifications. Do not emit/persist on each mailbox push, token, or internal promise assignment.

Migrate initial settlement and shutdown in `child.ts`, close/rebuild/followup in `tools.ts`, restore-session replacement and disposal in `index.ts`, and any real lifecycle writes in `agent-team/src/scheduler.ts`. Followups publish status, startedAt, error, finalText, controller/session changes coherently; clear prior-run finalText when starting the new run. `persistentAgentTable` forwards subscribe and wraps update with one save only on success. Restore replacing a stub Session must emit an update so child listeners rebind.

## 3. Exec and workflow ownership

Exec stays independent of core-tools/core-session. Add structural interfaces to `packages/exec/src/index.ts`:

```ts
export interface ExecPromotionWake {
  pending(): boolean
  subscribe(listener: () => void): () => void
}
export interface ExecRunOptions {
  backgroundAfterMs?: number
  promotionWake?: ExecPromotionWake
}
export interface PromotedRun {
  jobId: string
  promoted: true
  ranForegroundMs: number
  promotionReason?: "deadline" | "user-steer"
}
// ExecService; also WorkflowExecutor
subscribeJob(jobId: string, listener: (view: BackgroundJobView) => void): () => void
```

Keep `promotionReason` optional in the public type for existing embedders/mocks; the concrete service always includes it for new promotions. Streaming remains nonpromotable (`promotionWake?: never` in ExecStreamRunOptions and runtime validation rejects mixed options). `subscribeJob` is required on concrete service interfaces; update all typed fake implementations rather than introducing polling fallback.

`run` launches exactly one `makeCapture`. A timer or user-steer source can invoke the same idempotent promotion function, which calls `registerJob(capture)` once. Completion and rejection also settle the observation and remove the timer/wake listener. Track capture completion in the local arbiter before scheduling a promotion; if capture is already settled, return its actual result/error. Recheck pending after subscription. A running result may race imminent completion, but the registered job receives the actual eventual outcome.

Preserve launch lifetime independently of observation promotion eligibility. The existing fourth `makeCapture` boolean selects retain-tree/automatic lifetime; it is not required to register a capture as a job. Keep that argument based on the configured deadline threshold alone, even when a wake source exists: a wake-only foreground capture uses its original complete-tree lifetime and can still be registered as a running job on steer. Deadline-configured runs retain existing `autoPromotionLifetime` restrictions; unsupported retain-tree authority must not be widened. An unsteered wake-capable foreground run must clean descendants exactly as before this feature, and a wake-only promoted job still performs complete-tree cleanup when its root exits. WSL remains complete-tree. Pass steer through `ExecRunOptions.promotionWake`, never `ExecCommand.abortSignal`. Normal tool return clears the guard timeout; explicit owner cleanup still cancels/joins the registered capture.

Ruling: preserve threshold-only lifetime selection instead of the preliminary audit's suggestion to mark every wake-capable capture promotable — source inspection shows the boolean controls lifetime, while every capture already supports registration — the cost if wrong is either changed descendant cleanup or an unsupported backend promotion, both covered by explicit wake-only lifecycle tests.

Exec subscriptions apply exactly the same `canAccess(job.owner)` admission gate as getOutput/killJob. They emit after full view updates for capture completion/rejection, root/settlement diagnostics, and kill outcome; `rootExited` alone does not terminalize incomplete cleanup. Dispose notifies any last owner state through normal transitions, then clears listeners. Invalid/foreign IDs install no listener.

Workflow adds `subscribeJob` to store and facade plus `update(jobId, patch: Partial<Pick<WorkflowJobEntry,"status"|"stdout"|"stderr"|"exitCode">>): void`. Move terminal status/exit mutation through update; publish after kill has set status. Emit progress/output changes at existing whole step boundaries, never per byte. Source inspection confirms the workflow store is process-shared and assembly currently passes its concrete executor directly. Preserve that existing getOutput visibility, unknown workflow-prefix routing, and existing background/task projection filters; subscribeJob must not expose anything beyond that read contract. Do not invent a new exact-session facade in this change. Any actual scoped facade found elsewhere must forward subscriptions through its existing read gate.

Shell registration passes `userSteerForTool(exec)` only for direct foreground calls on bash, pwsh, and selected Agent Shell. Explicit background remains immediate. Code-consumer shell calls keep their existing time/background choices; user steer releases only their outer cell observation. Promotion text says “Yielded to new user input; command continues as job …” for steer and retains elapsed-threshold wording for deadline.

## 4. Tool response contracts and Code Mode

Use the same additive marker for still-running steer observations:

```ts
{ yielded: true, yield_reason: "user-steer" }
```

Existing output fields remain present. `wait_agent` has `timed_out: false` on steer and a message explicitly saying the wait yielded and work continues. Deadline alone sets its timed_out flag. Target removal/replacement yields the old identity honestly with `yielded:true, yield_reason:"target-changed"`, `timed_out:false`; never label path reuse as completion of the observed child. Include original child session/job IDs if available. All-agent wait observes the live table membership until none is running, rather than freezing an initial list.

Foreground spawn waits only after successful one-time child creation/task claim; steer returns the original `agent_path`, `job_id`, `task_id`, current status, and marker. `get_task_output` validates all 1..20 IDs before subscribing, maintains input order, uses one overall deadline, and returns all current snapshots on steer. A multi-ID observation tracks per-ID completion, unsubscribes all sources together, and never continues another blocking per-ID loop after steer. `job_output` resolves its backend first, validates it, observes its changes, and always ends text with the actual `[status: ...]` marker.

Add an observation argument without changing existing positional parameters:

```ts
export interface CodeModeObserveOptions { userSteer?: UserSteerSource }
// CodeModeRuntime
exec(input: CodeModeExecInput, origin?: CodeModeOrigin,
  observation?: CodeModeObserveOptions): Promise<CodeModeObservation>
wait(input: CodeModeWaitInput, signal?: AbortSignal,
  observation?: CodeModeObserveOptions): Promise<CodeModeObservation>
// CodeModeObservation additive fields:
yielded?: true
yieldReason?: "user-steer"
```

`register.ts` builds this source from the current outer ToolExec and maps yieldReason to public yield_reason. Do not add the wake source to frozen CodeModeOrigin or broker invocation signal. Within observe, add a steer subscription beside existing cell wake/deadline/abort handling; use the same cleanup path to release `cell.observer` and keep `cell.wake` ownership correct. Pending steer is checked after subscribing. Terminate/observer abort still close and drain; steer only ends observation. Completion wins if cell is terminal by result construction. Retention of an already detached output window must finish; later output remains queued for the next wait. Preserve active-observer exclusion, policy refusal, output limits, spill references, store commit order, and owner cancellation.

The broker is not replayed or modified to fabricate a result. A guest awaiting child, job, shell, or arbitrary MCP work remains awaiting the original invocation. Only real eventual settlement appends its `code/result`. Returning an outer running snapshot gives the scheduler one ordinary tool result paired to its existing dispatch.

## 5. Live child history and Desktop push

The first phase also includes direct `workflow_run(wait:true)`: it has an existing owned workflow job and a 20 ms polling loop in `packages/workflow/src/tool.ts`. Replace that loop with the same observation helper and `WorkflowExecutor.subscribeJob`, returning the same run/job IDs and a user-steer marker while work continues. Its current wait has no internal deadline (the tool guard owns its ceiling), so omit timeoutMs rather than invent a new limit. Preserve its existing abort contract: abort ends observation with the actual running snapshot and does not kill the workflow. Nested Code Mode calls still rely on the outer observer for user steering.

Add an assembly-local monitor in `packages/session-executor/src/child-observation.ts`. It owns subscriptions to AgentTable and current child Sessions, indexed by actual entry and Session object identity. Subscribe to table before initial enumeration. Reconcile add/remove/update, removing stale Session listeners before attaching replacements. Only durable Session events (`event.seq !== undefined`) invalidate; transient token/model activity chunks do not. Listener bodies perform no I/O, persistence flush, or provider request.

Expose additive optional methods on SessionAssembly (production assemblies implement them; older test hosts can omit):

```ts
liveChildSession?(childSessionId: string): Session | undefined
onSubagentsChanged?(listener: (change: {
  kind: "changed" | "closed"
}) => void): () => void
```

Read only the owning assembly's live table; no child assembly is constructed, no stored child is restored. A matching current sessionId and entry is required; never resolve by path alone. Dispose emits `closed` once, detaches table and child listeners, clears maps, and prevents later notifications. The accessor returns undefined after dispose. Assembly shutdown invokes this before discarding child/session resources.

Gateway `createDesktopSubagents` opts into an additive `service.onAssembly(hook, { includeExisting: true })`. The existing default remains future-only. The opt-in registers the hook before synchronously enumerating an identity-checked snapshot of live assemblies; it does not replay session events, and a failed initial hook removes its registration before throwing. Gateway setup failure cleans any listeners already attached. It holds a disposer per actual assembly/root session, removes it on `closed`, and replaces old bindings safely. Coalesce changed callbacks in one 50 ms one-shot timer per parent; while a timer exists further events only mark dirty. On timer fire emit one `onChanged(parentSessionId)` and clear the timer; idle parents have no timer. Close cancels timers, removes all subscriptions and the onAssembly hook, then drains existing control writes. Existing control invalidation joins the same coalescer.

Use dedicated notification `desktop/session/subagents/changed` with `{ sessionId: parentSessionId }`, passed through gateway host, Desktop main allowlist, shared bridge union, and SubagentPane subscription. Root scope covers new children not yet present in the renderer catalog. Existing pane refresh scheduling and epoch/ticket guards remain, and the new method triggers both catalog and selected-history reads. Workspace and parent isolation still gate refresh. An assembly closing invalidates its root once unless gateway itself is closing. Gateway disconnect/unmount stops refresh; reconnect/reselection loads a fresh catalog/history.

For actual data, retain `SessionService.liveSession` root-only semantics. After existing durable visibility and lineage validation, gateway history obtains `authority(parentId, childId, chain)?.assembly.liveChildSession?.(childId)` before cold snapshot fallback. Catalog rows use the already selected exact live runtime's accessor. Intermediate owner snapshots use an accessor only from a lineage-validated ancestor assembly. Validate sequence invariants on both live and persisted Sessions. This prevents a push from immediately reading stale write-behind data and avoids broadening SDK root-session authority through a global child lookup.

The initial delivery is durable tool/status/history visibility, not a claim of full transient text streaming. No per-token filesystem work or recurring UI polling is added.

## 6. Acceptance and review boundaries

Implement sequentially: (1) observation helper and registry lifecycle seams, (2) exec/workflow subscriptions and direct shell promotion, (3) tool observations and outer Code Mode yielding, (4) live child history/push, (5) whole-stack integration/docs/source PR. Each implementation task has a fresh review gate for both spec compliance and quality. No next task while load-bearing findings remain unresolved.

Controlled tests prove release before work is permitted to finish, same IDs and one launch/invocation, no abort on steer, exactly one dispatch/result, one step-boundary input promotion, later completion retrieval, and stop/close/dispose drain. Race tests cover preexisting steer, registration-time completion, synchronous terminal/reopen, completion/steer/deadline, invalid IDs, followups, cancelTree, restoration Session replacement, multiple observers, listeners/timers cleanup, and pending output retention. Desktop tests prove child durable output appears before flush and with no parent events, root/workspace isolation, new child discovery, restore/close/disconnect cleanup, and bounded coalescing.

Focused test suites and typechecks run per task. Whole-branch review, then a single frozen-head `pnpm verify:all`, provide integration evidence. Fixes require the covering checks again and fresh aggregate evidence if source changed. Source PR describes actual supported paths and the arbitrary sibling/retention latency boundary; it does not promise universal interruption.

Final delivery follows the user's standing instruction in this conversation to submit, merge and release completed IH work. Parent owns v0.1.12 versioning after implementation, matching-head merge, verified Windows artifacts, isolated shipped-runtime smoke tests and GitHub draft/published asset checks. This extends the initial source-only planning assumption; it does not permit live profile mutation or replacing the running installed app. Preserve the user's external remediation branch.
