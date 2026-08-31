export { createJobRegistry } from "./jobs.ts"
export type { JobRegistry, JobSnapshot, JobStatus } from "./jobs.ts"
export { createRoleRegistry, builtinRoles } from "./roles.ts"
export type { SubagentRole, RoleRegistry } from "./roles.ts"
export { createAgentTable } from "./agent-table.ts"
export type { ChildStatus, ChildAgentEntry, AgentTable } from "./agent-table.ts"
export { forkTurns } from "./fork.ts"
export { spawnChild } from "./child.ts"
export type { SpawnOptions } from "./child.ts"
export { createSubagentTools } from "./tools.ts"
export { driveFollowups, ensureResidentAgent, sweepPendingInbox, type FollowupDeps } from "./tools.ts"
export type { SubagentToolDeps } from "./tools.ts"
export { restoreState, wireSubagentPersistence } from "./persist.ts"
export type { SubagentPersistence, SubagentStateSnapshot } from "./persist.ts"
export { createTaskRegistry, taskDocKey, notificationMessageId, classifyRestoredTasks, isSessionCancelledChain, TaskIdentityConflictError, TaskConcurrencyLimitError } from "./task-protocol.ts"
export type { TaskRegistry, TaskRecord, TaskStatus, TaskOutcome, TaskDelivery, TaskIdentity, TaskNotificationRecord, TaskProtocolDocument, OutboxStatus, RecoveryReason } from "./task-protocol.ts"
export { createNotificationDrain } from "./task-notification.ts"
export type { ParentInputAdmission, NotificationDrainOptions } from "./task-notification.ts"

import type { PluginContext } from "@i-harness/core-plugin"
import type { ToolRegistry } from "@i-harness/core-tools"
import { createSession } from "@i-harness/core-session"
import type { ModelClient } from "@i-harness/llm-seam"
import type { ProviderRegistry } from "@i-harness/provider"
import type { ExecService } from "@i-harness/exec"
// M24b (spec §3.3): optional workflow executor threaded into SubagentToolDeps
// (type-only here — the runtime object flows from the host).
import type { WorkflowExecutor } from "@i-harness/workflow"
import { createJobRegistry, type JobRegistry } from "./jobs.ts"
import { createRoleRegistry, builtinRoles, type RoleRegistry } from "./roles.ts"
import { createAgentTable, type AgentTable, type ChildAgentEntry } from "./agent-table.ts"
import { createSubagentTools, ensureResidentAgent, sweepPendingInbox } from "./tools.ts"
import type { SubagentToolDeps } from "./tools.ts"
import { createAgentRegistry, type AgentRegistry } from "@i-harness/core-agent"
import { emitRestoredJobTransitions, restoreState, wireSubagentPersistence } from "./persist.ts"
import type { SubagentPersistence, SubagentStateSnapshot } from "./persist.ts"
import { classifyRestoredTasks, createTaskRegistry, isSessionCancelledChain, taskDocKey, type TaskProtocolDocument, type TaskRegistry } from "./task-protocol.ts"
import { createNotificationDrain, type ParentInputAdmission } from "./task-notification.ts"

export interface RegisterSubagentOptions {
  providers: ProviderRegistry
  exec: ExecService
  parentModel: ModelClient
  parentSession: ReturnType<typeof createSession>
  // M6 state persistence: when set, every registry mutation persists the full
  // snapshot through the coordinator document API.
  persist?: SubagentPersistence
  // M6 resume: snapshot whose roles/jobs/agent-table are authoritative. When
  // present the builtin seeding below is SKIPPED — the snapshot's roles list
  // already contains the builtins (possibly user-edited) plus any custom roles,
  // and RoleRegistry.register throws on duplicates.
  restoredState?: SubagentStateSnapshot
  // M24b (spec §3.3): the workflow executor (run-level singleton, ruling
  // M24b-P3) whose job store backs the job_* third layer — `workflow-`
  // prefixed ids route to it. Optional: absent = current behavior (the chain
  // stays subagent → exec).
  workflow?: WorkflowExecutor
  // M26-D3 (R-D1-T3): subagent 並行配額——非終態（accepted+running）任務數 >=
  // maxConcurrency 時 submit 以 TaskConcurrencyLimitError 失敗閉合（fail-closed）。
  // 缺省 Infinity（host 開啟才生效——零行為變更）。R-D1 的 depth 配額由既存
  // maxDepth（M24a B2）擔當，本欄位是 concurrency 軸。
  maxConcurrency?: number
  // M26-D2: R-A1 (A-plan) 輸入接納 — 由 host（run.ts）注入。缺省 = durable-only
  // 交付（通知留在 outbox pending，冷啟後由 ready 鏈再試）。
  parentNotify?: ParentInputAdmission
}

export interface RegisterSubagentResult {
  roles: RoleRegistry
  jobs: JobRegistry
  table: AgentTable
  // M19 (Ruling 17): the live Agent instances registry — the team scheduler
  // (agent-team) uses it to wake spawned child agents (followup re-drives).
  // Additive: existing consumers destructure { roles, jobs, table } and are
  // unaffected.
  agents: AgentRegistry
  // M23 (Minor 4): lazy resident rebuild closure over this mount's REAL
  // SubagentToolDeps. registerSubagent encapsulates the deps object, so hosts
  // (run.ts → mountAgentTeams) wire this into the agent-team deliver gate to
  // fix the post-resume wakeup no-op without duplicating the deps shape.
  ensureResident: (entry: ChildAgentEntry) => Promise<boolean>
  // M24a (G1a/G4): resolves when the post-restore async steps complete — the
  // G1a hooked-mirror rebuild (each restored child's durable log loaded into
  // a live mirror session) followed by the G4 pending-inbox sweep. Hosts MUST
  // await this BEFORE mounting agent teams (mountAgentTeams' recoverRoot
  // delivers queued team messages to entry.session, which must be a live
  // mirror by then) and before the main agent can touch the tools. Resolves
  // immediately (no-op) when there is no restored state.
  ready: Promise<void>
  // M26-D1: the durable task protocol registry (records + notification
  // outbox) behind this mount. With persistence the ready chain already
  // restored + classified the records from `task:<stateId>`.
  tasks: TaskRegistry
}

// Mount entry point (spec §1.1.6 / §2.3): seeds the role registry with the
// four built-in roles, creates the job registry + agent table, builds the 11
// subagent/job tools, and registers them on the parent registry.
export function registerSubagent(ctx: PluginContext, parentRegistry: ToolRegistry, opts: RegisterSubagentOptions): RegisterSubagentResult {
  // M24a (G1a/G4): resolved to the real post-restore step below when BOTH a
  // restored state and persistence are present; otherwise a no-op.
  let ready: Promise<void> = Promise.resolve()
  let roles: RoleRegistry = createRoleRegistry()
  let jobs: JobRegistry = createJobRegistry()
  let table: AgentTable = createAgentTable()
  if (!opts.restoredState) {
    // Snapshot roles are authoritative (builtins + custom/edited); seeding
    // builtins now would throw on duplicates and shadow edited builtins.
    for (const r of builtinRoles()) roles.register(r)
  }
  if (opts.restoredState) {
    // Restore BEFORE wrapping so the first save persists the restored state.
    // M24a (Ruling M24a-P2): restoreState stays SYNC — it rebuilds the
    // registries with empty stub sessions; the async G1a mirror rebuild and
    // the G4 sweep run afterwards behind `ready` (below).
    restoreState({ jobs, table, roles }, opts.restoredState, opts.persist)
  }
  if (opts.persist) {
    const wired = wireSubagentPersistence({ jobs, table, roles }, opts.persist)
    jobs = wired.jobs
    table = wired.table
    roles = wired.roles
  }
  const agents = createAgentRegistry()
  // M26-D1/D2: task protocol registry — durable task records + outbox behind
  // the existing persistence seam (doc key `task:<stateId>`). onTerminalized
  // is a deferred hook (assigned once the notification drain exists below) so
  // every terminalize (spawn settle / cancelTree / recovery classification)
  // triggers an immediate delivery attempt.
  let notifDrainHook: (() => void) | undefined
  const tasks = createTaskRegistry({
    ...(opts.persist ? { coordinator: opts.persist.coordinator, stateId: opts.persist.stateId } : {}),
    maxConcurrency: opts.maxConcurrency,
    onTerminalized: () => { notifDrainHook?.() },
  })
  // M23 (Minor 4): the deps object is kept in a named variable so the
  // ensureResident closure below closes over the SAME (persist-wrapped)
  // registries the tools use.
  const subagentDeps: SubagentToolDeps = {
    table, jobs, roles, parentRegistry, parentSession: opts.parentSession, parentCtx: ctx,
    parentModel: opts.parentModel, providers: opts.providers, exec: opts.exec,
    agents,
    tasks,
    // M24b (spec §3.3): thread the optional workflow executor through so the
    // job_* tools see the third layer. Omitted when the host didn't pass one —
    // additive, zero behavior change.
    ...(opts.workflow ? { workflow: opts.workflow } : {}),
    // M8: when persistence has a known main-session id, spawns get durable
    // child-<uuid> sessions with the lineage header.
    ...(opts.persist
      ? { childSessions: { coordinator: opts.persist.coordinator, parentSessionId: opts.persist.parentSessionId } }
      : {}),
  }
  const tools = createSubagentTools(subagentDeps)
  // ToolRegistry.register throws on duplicate names, so skip tools the parent
  // already has — makes registerSubagent idempotent for repeat mounts.
  for (const tool of tools) {
    if (!parentRegistry.get(tool.name)) parentRegistry.register(tool)
  }
  // M26-D2: the notification drain. admit = the host-injected A-plan admission
  // (ParentInputAdmission — run.ts backs it with the real SessionExecutor's
  // inject tier); isSessionCancelled suppresses delivery when the parent chain
  // was cancelled (R-D3 opencode rule). One drain instance per mount; it is
  // also awaited at the cold-restore chain tail (below).
  const notifDrain = createNotificationDrain({
    tasks,
    admit: opts.parentNotify,
    isSessionCancelled: (sessionId) => isSessionCancelledChain(tasks, sessionId),
  })
  notifDrainHook = () => { void notifDrain.drain().catch(() => {}) }
  if (opts.restoredState && opts.persist) {
    // Task 4.4 (fix round 1): restoreState mapped each mid-flight job
    // running→"error" PRE-wiring, so the observer-wrapped registry never saw
    // that transition and no terminal `job/status` event would land in the
    // evented parent session — the resumed log (pre-crash `running` event,
    // nothing after) would fold to forever-"running" while the doc says
    // "error". Replay the mapped outcome through the event emitter now, so
    // the log stays rebuildable (no-op without a parentSession).
    emitRestoredJobTransitions(opts.persist, opts.restoredState, jobs)
  }
  if (opts.persist) {
    // M26-D1/D2: the unified post-restore chain — task doc restore +
    // recovery classification (M26) + drain (M26-D2) THEN the M24a G1a mirror
    // rebuild + G4 pending-inbox sweep. `ready` gates hosts until it completes.
    ready = restoreTasksAndSweep(subagentDeps, table, opts.persist, tasks, notifDrain)
  }
  return { roles, jobs, table, agents, ensureResident: (entry: ChildAgentEntry) => ensureResidentAgent(subagentDeps, entry), ready, tasks }
}

// M26-D1/D2: post-restore task protocol chain — (1) load the durable task doc
// (records + outbox rows), (2) classify ambiguous accepted/running attempts from
// the durable child log (completed | recovery-required — never re-dispatch),
// (3) G1a mirrors + G4 sweep (existing M24a steps). Notifications drain (D2-T1)
// runs here too once wired.
async function restoreTasksAndSweep(
  deps: SubagentToolDeps,
  table: AgentTable,
  persist: SubagentPersistence,
  tasks: TaskRegistry,
  notifDrain: { drain: () => Promise<number> },
): Promise<void> {
  // ADAPTATION (M26-D1, plan T5 Step 3 vs M24a G1a test): the plan's naive
  // order (task doc restore FIRST) suspends on the first await and defers the
  // mirror rebuild past a microtask — the existing G1a test asserts load() is
  // called SYNCHRONOUSLY at mount. Mirrors first restores that contract; the
  // task-doc restore + classification only read durable state (no mirror
  // dependency), and `ready` still gates the whole chain for hosts.
  await restoreMirrorsAndSweep(deps, table)
  if (deps.childSessions) {
    try {
      const doc = await deps.childSessions.coordinator.getDocument(taskDocKey(persist.stateId))
      if (doc !== undefined) tasks.restore(doc as TaskProtocolDocument)
    } catch {
      // task doc missing/corrupt → empty registry（既有 subagent-state 同姿態）
    }
    await classifyRestoredTasks(tasks, deps.childSessions.coordinator)
    // M26-D2: 冷啟先交付（前次 run 的完成通知 = 本次啟動時父 session 的收件箱輸入）。
    await notifDrain.drain()
  }
}

// M24a (G1a): rebuild each restored child's hooked mirror session from its
// durable log — the async complement to the sync restoreState (Ruling
// M24a-P2). The mirror is the SAME shape the CLI's former host-side loop
// built (run.ts, now deleted): a fresh createSession with an enqueue+flush
// write-behind hook so subsequent appends (send_message / followup_task /
// child turns) keep persisting through the coordinator. A child whose durable
// log is missing/corrupt fails VISIBLE (the pre-M24a host loop silently kept
// the empty stub): the entry is marked error with an explanatory message so
// wait_agent / list_agents can surface why the child is unusable. Afterwards
// the G4 sweep drives waiting entries with unconsumed inbox events.
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
      // G1a fail-visible: no silent empty-stub downgrade.
      entry.status = "error"
      entry.error = "child log unavailable after resume"
    }
  }
  await sweepPendingInbox(deps, table)
}
