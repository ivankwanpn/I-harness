import { bindPreparedTaskLaunchLeaf, type OriginalTaskCaller } from '@i-harness/core-tools/internal/task-caller'
import { taskLaunchPortFor } from './task/launch-slots.ts'
export { taskBodyPreview as childResultPreview, readTaskResultPage } from "./task/result.ts"
export type { TaskResultStore, RetainedTaskResult, TaskResultBody, TaskResultPage, TaskResultPageArgs } from "./task/result.ts"
export { createJobRegistry } from "./jobs.ts"
export type { JobRegistry, JobSnapshot, JobStatus } from "./jobs.ts"
export { projectAgentTasks, projectAgentTaskDetail, projectStatus, projectWorkflowRows } from "./projection.ts"
export type { AgentTaskDetail, AgentTaskGroup, AgentTaskStatus, AgentTaskView, SubagentTaskSource, TaskSourceStatus, WorkflowTaskRow } from "./projection.ts"
export { createRoleRegistry, builtinRoles } from "./roles.ts"
export type { PrepareTaskChild, TaskChildHostInput, TaskChildHostPreparation } from './child/task-host.ts'
export {inspectTaskChildHistory} from './child/task-history.ts'
export type { SubagentRole, RoleRegistry, RoleCleanup } from "./roles.ts"
export { createAgentTable } from "./agent-table.ts"
export type { ChildStatus, ChildAgentEntry, AgentTable } from "./agent-table.ts"
export { hasCommittedInitialInput } from './child/initial-input.ts'
// W11: the runtime-context section naming sub-agents past the staleness
// threshold. Its consumer is the assembly (`createSessionAssembly`), which
// registers it under the "subagents" section name. The section's options type
// is deliberately NOT re-exported: no consumer names it, so a barrel export
// would be a declared name with no reader (the reachability gate reports it as
// a new row, and the assembly passes an object literal).
export { createStaleSubagentsSection } from "./section.ts"
export { forkTurns } from "./fork.ts"
export { spawnChild } from "./child.ts"
export type { SpawnOptions } from "./child.ts"
export type { ChildInstructionContextInput, ChildInstructionContext, ChildInstructionContextFactory } from './child/instruction-context.ts'
export { createSubagentTools } from "./tools.ts"
export { driveFollowups, ensureResidentAgent, sweepPendingInbox, type FollowupDeps } from "./tools.ts"
export type { SubagentToolDeps } from "./tools.ts"
export type { ResidentInboxActivation } from './followup/activation.ts'
export { restoreState, wireSubagentPersistence, snapshotState } from "./persist.ts"
export { retainedResultWitness } from './result-publication.ts'
export type { SubagentPersistence, SubagentStateSnapshot } from "./persist.ts"
export { createTaskRegistry, taskDocKey, notificationMessageId, classifyRestoredTasks, isSessionCancelledChain, TaskIdentityConflictError, TaskConcurrencyLimitError } from "./task-protocol.ts"
export type { TaskRegistry, TaskRecord, TaskStatus, TaskOutcome, TaskDelivery, TaskIdentity, TaskNotificationRecord, TaskProtocolDocument, OutboxStatus, RecoveryReason } from "./task-protocol.ts"
export { createNotificationDrain, ParentNotificationStoppedError, DeliverySuppressedError, isParentNotificationStopped } from "./task-notification.ts"
export { SHIPPING_REPORT_POLICY } from "./report-policy.ts"
export type { ReportPolicy } from "./report-policy.ts"
export type { ParentInputAdmission, NotificationDrainOptions } from "./task-notification.ts"

import type { PluginContext } from "@i-harness/core-plugin"
import type { ToolRegistry } from "@i-harness/core-tools"
import { deliveryInputId, readDeliveries, type SessionView, type FactOwner } from "@i-harness/core-session"
import { readOwnedDeliveryState } from '../../core-session/src/managed/view.ts'
import { DeliverySourcesError } from './task-notification.ts'
import type { ModelClient } from "@i-harness/llm-seam"
import type { ExecService } from "@i-harness/exec"
// M24b (spec §3.3): optional workflow executor threaded into SubagentToolDeps
// (type-only here — the runtime object flows from the host).
import type { WorkflowExecutor } from "@i-harness/workflow"
import { createJobRegistry, type JobRegistry } from "./jobs.ts"
import { createRoleRegistry, builtinRoles, type RoleRegistry } from "./roles.ts"
import { createAgentTable, type AgentTable, type ChildAgentEntry } from "./agent-table.ts"
import { projectAgentTasks, type AgentTaskView } from "./projection.ts"
import { createSubagentTools, ensureResidentAgent, sweepPendingInbox } from "./tools.ts"
import { followupDepsWithRebuild } from './followup/resident.ts'
import type { SubagentToolDeps } from "./tools.ts"
import type { RoleModelHost, RoleModelSelection, RoleModelState } from "./child.ts"
import { createAgentRegistry, type AgentRegistry } from "@i-harness/core-agent"
import { emitRestoredJobTransitions, restoreState, snapshotState, wireSubagentPersistence } from "./persist.ts"
import type { SubagentPersistence, SubagentStateSnapshot } from "./persist.ts"
import { classifyRestoredTasks, createTaskRegistry, isSessionCancelledChain, taskDocKey, type TaskProtocolDocument, type TaskRegistry } from "./task-protocol.ts"
import { createNotificationDrain, type ParentInputAdmission } from "./task-notification.ts"
import type { ReportPolicy } from "./report-policy.ts"
import { subagentFactOwner } from './facts.ts'
import { residentOwnerFor, refusedReentry } from './followup/resident-lifetime.ts'
import type { ManagedDocument } from '@i-harness/session-persistence'
import { captureOwnedTaskContext } from './task/owned-context.ts'
import { isColdBoundChild } from './task/cold-bindings.ts'
import { createTaskStartupFacade } from './task/startup-facade.ts'

export interface RegisterSubagentOptions extends RoleModelHost {
  prepareTaskChild?: import('./child/task-host.ts').PrepareTaskChild
  residentActivation?: import('./followup/activation.ts').ResidentInboxActivation
  results?: import("./task/result.ts").TaskResultStore
  reportPolicy?: ReportPolicy
  /** The host mounted the generic shell tool; expose it to built-in workers. */
  includeAgentShell?: boolean
  includeNativeContext?: boolean
  /** Resolve a selection to a live client through the HOST's provider plane —
   * the same one the session's own model went through, so a role gets the same
   * credentials, the same card table and the same protocol chain.
   *
   * It replaced a `ProviderRegistry` that `assembly.ts` built empty and nothing
   * ever registered into, which made `role.model` throw `references unknown
   * provider` for every value it could ever hold. */
  resolveModel(selection: RoleModelSelection): Promise<RoleModelState>
  exec: ExecService
  parentModel: ModelClient
  parentSession: SessionView
  factOwner?: FactOwner
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
  retainInitialSetup(setup: import('./child/instruction-context.ts').InitialChildSetup): () => void
  /** Strict barrier over the existing complete job/table state document. */
  retainResults(): Promise<"durable" | "memory">
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
  ensureResident: (entry: ChildAgentEntry, controller?: AbortController, executionCurrent?: () => boolean) => Promise<boolean>
  followupActivation?: import('./followup/drive.ts').FollowupDeps['activation']
  captureFollowupGeneration?: import('./followup/drive.ts').FollowupDeps['captureGeneration']
  followupGeneration: import('./followup/drive.ts').FollowupDeps['openGeneration']
  // M24a (G1a/G4): resolves when the post-restore async steps complete — the
  // G1a hooked-mirror rebuild (each restored child's durable log loaded into
  // a live mirror session) followed by the G4 pending-inbox sweep. Hosts MUST
  // await this BEFORE mounting agent teams (mountAgentTeams' recoverRoot
  // delivers queued team messages to entry.session, which must be a live
  // mirror by then) and before the main agent can touch the tools. Resolves
  // immediately (no-op) when there is no restored state.
  ready: Promise<void>
  /** Wait for notification admissions and their queued task-document saves. */
  flushPersistence(): Promise<void>
  drainParentNotifications(): Promise<void>
  settleParentDeliverySources(): Promise<void>
  dispose(): Promise<void>
  // M26-D1: the durable task protocol registry (records + notification
  // outbox) behind this mount. With persistence the ready chain already
  // restored + classified the records from `task:<stateId>`.
  tasks: TaskRegistry
  // M49 Task 12 (spec §8.2): the read-only task projection over THIS mount's
  // registries — summary rows only; no registry object ever escapes (the UI
  // builds its rows through this seam, not by casts).
  projectTasks(): AgentTaskView[]
}

// Mount entry point (spec §1.1.6 / §2.3): seeds the role registry with the
// four built-in roles, creates the job registry + agent table, builds the 11
// subagent/job tools, and registers them on the parent registry.
export function registerSubagent(ctx: PluginContext, parentRegistry: ToolRegistry, opts: RegisterSubagentOptions): RegisterSubagentResult {
  const factOwner = subagentFactOwner(opts.parentSession, opts.factOwner)
  let ownedTask: import('./task/persistence.ts').OwnedTaskContext | undefined
  if (opts.factOwner && opts.persist) ownedTask = captureOwnedTaskContext(opts.persist.coordinator, opts.factOwner as ManagedDocument, opts.parentSession, opts.persist.stateId)

  // M24a (G1a/G4): resolved to the real post-restore step below when BOTH a
  // restored state and persistence are present; otherwise a no-op.
  let ready: Promise<void> = Promise.resolve()
  let roles: RoleRegistry = createRoleRegistry()
  let jobs: JobRegistry = createJobRegistry()
  let table: AgentTable = createAgentTable()
  let factPersistence: ReturnType<typeof wireSubagentPersistence> | undefined
  if (!opts.restoredState) {
    // Snapshot roles are authoritative (builtins + custom/edited); seeding
    // builtins now would throw on duplicates and shadow edited builtins.
    for (const r of builtinRoles({ agentShell: opts.includeAgentShell, nativeContext: opts.includeNativeContext })) roles.register(r)
  }
  if (opts.restoredState) {
    // Restore BEFORE wrapping so the first save persists the restored state.
    // M24a (Ruling M24a-P2): restoreState stays SYNC — it rebuilds the
    // registries with empty stub sessions; the async G1a mirror rebuild and
    // the G4 sweep run afterwards behind `ready` (below).
    restoreState({ jobs, table, roles }, opts.restoredState, opts.persist ? { ...opts.persist, parentSession: opts.parentSession, factOwner } : undefined)
  }
  if (opts.persist && !ownedTask) {
    const wired = wireSubagentPersistence({ jobs, table, roles }, { ...opts.persist, factOwner: opts.persist.factOwner ?? opts.factOwner })
    factPersistence = wired
    jobs = wired.jobs
    table = wired.table
    roles = wired.roles
  }
  const agents = createAgentRegistry()
  // M26-D1/D2: task protocol registry — durable task records + outbox behind
  // the existing persistence seam (doc key `task:<stateId>`). onTerminalized
  // is a deferred hook (assigned once the notification drain exists below) so
  // every terminalize (spawn settle / cancelTree / recovery classification)
  // dirties the existing drain after host activation. Original terminal/task
  // commitment still supplies the decisive handoff signal.
  let notifDrainHook: (() => void) | undefined
  const deliverySources = new Map<string, { reconcileTerminal(): Promise<void> }>()
  let settlingDeliverySources: Promise<void> | undefined
  function settleParentDeliverySources(): Promise<void> {
    if (settlingDeliverySources) return settlingDeliverySources
    const pending = (async () => {
      const results = await Promise.allSettled([...deliverySources].map(async ([id, source]) => {
        if (deliverySources.get(id) === source) await source.reconcileTerminal()
      }))
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length) throw new DeliverySourcesError(failures)
    })()
    settlingDeliverySources = pending
    void pending.then(() => { settlingDeliverySources = undefined }, () => { settlingDeliverySources = undefined })
    return pending
  }
  let launchEntry: ReturnType<typeof bindPreparedTaskLaunchLeaf> | undefined
  let launchTool: import('@i-harness/core-tools').Tool | undefined
  const taskOwner = createTaskRegistry({
    ...(ownedTask ? { launchContext: { view: opts.parentSession, factOwner, context: ctx, sessionId: ownedTask.stateId } } : {}),
    results: opts.results,
    reportPolicy: opts.reportPolicy,
    ...(opts.persist ? { coordinator: opts.persist.coordinator, stateId: opts.persist.stateId } : {}),
    ...(ownedTask ? { ownedTask } : {}),
    maxConcurrency: opts.maxConcurrency,
    onTerminalized: () => { notifDrainHook?.() },
  })
  // The original runtime containers are staged without observers. The public
  // facades route mutations through the task owner before reaching a producer.
  const stagedRuntime = { jobs, table, roles }
  let mountedRuntime = stagedRuntime
  let runtimeWorkReady = !ownedTask
  let runtimeRetiring = false
  let startupFailure: { cause: unknown } | undefined
  function assertRuntimeWork(): void {
    taskOwner.assertReady()
    if (startupFailure) throw new Error('Owned runtime restoration failed', { cause: startupFailure.cause })
    if (!runtimeWorkReady || runtimeRetiring) throw new Error('Owned runtime restoration pending or retired')
  }
  const tasks = ownedTask ? createTaskStartupFacade(taskOwner, assertRuntimeWork) : taskOwner
  if (ownedTask) {
    function guarded<T extends object>(kind: 'jobs' | 'table' | 'roles', original: T, names: readonly (keyof T)[]): T {
      const facade = { ...original }
      for (const name of names) {
        const method = (...args: unknown[]) => {
          // Original resident retirement must retain its closing event after
          // new work is fenced, without scheduling another persistence save.
          const patch = args[2] as Partial<ChildAgentEntry> | undefined
          if (runtimeRetiring && kind === 'table' && name === 'update' && patch?.closing === true && Reflect.ownKeys(patch).length === 1) {
            return stagedRuntime.table.update(args[0] as string, args[1] as ChildAgentEntry, { closing: true })
          }
          assertRuntimeWork()
          const target = mountedRuntime[kind] as T
          if (kind === 'roles' && name === 'register' && typeof args[1] === 'function') {
            const retain = args[1] as (cleanup: import('./roles.ts').RoleCleanup) => void
            args[1] = (cleanup: import('./roles.ts').RoleCleanup) => { retain(cleanup); assertRuntimeWork() }
          }
          return Reflect.apply(target[name] as (...args: unknown[]) => unknown, target, args)
        }
        Object.defineProperty(facade, name, { value: method, enumerable: true })
      }
      return facade
    }
    jobs = guarded('jobs', jobs, ['registerJob', 'updateJob', 'kill'])
    table = guarded('table', table, ['add', 'update', 'remove'])
    roles = guarded('roles', roles, ['register', 'remove'])
  }
  // M23 (Minor 4): the deps object is kept in a named variable so the
  // ensureResident closure below closes over the SAME (persist-wrapped)
  // registries the tools use.
  const subagentDeps: SubagentToolDeps = {
    ...(ownedTask ? { taskLaunchCallerFor(exec: import('@i-harness/core-tools').ToolExec) {
      assertRuntimeWork()
      if(opts.persist?.parentSessionId!==ownedTask.stateId)throw Error('Original task lineage parent mismatch')
      if(!launchEntry||parentRegistry.get('spawn_agent')!==launchTool)throw Error('Original mounted task leaf unavailable')
      const caller:OriginalTaskCaller|undefined=launchEntry.enter(exec)
      if(!caller)throw Error('Original prepared task caller unavailable')
      const args=caller.call.args as {fork_turns?:unknown;agent_type?:string}
      if(args.fork_turns!==undefined&&args.fork_turns!=='none'&&args.fork_turns!=='all'||args.agent_type==='reviewer'||caller.identity.callEventSeq===undefined&&!caller.identity.toolCallId)return
      if(!opts.prepareTaskChild||!opts.persist?.coordinator.bootstrapChildTargetWithCapture||!opts.persist.coordinator.resumeChildTarget)throw Error('Original task child host unavailable')
      if(caller.context.view!==opts.parentSession||caller.context.factOwner!==factOwner||caller.context.context!==ctx||caller.identity.parentSessionId!==ownedTask.stateId)throw Error('Foreign original task caller')
      ownedTask.operations.assertTaskV3Parent(ownedTask.parent,ownedTask.stateId)
      const role=roles.get(args.agent_type??'general');if(!role)throw Error('Original role unavailable')
      return taskLaunchPortFor(taskOwner).admit(caller,role)
    }} : {}),
    residentActivation: opts.residentActivation,
    prepareTaskChild: opts.prepareTaskChild,
    createInstructionContext: opts.createInstructionContext,
    generationFactoryFor: opts.generationFactoryFor, modelActionTimeoutMs: opts.modelActionTimeoutMs, modelActionMaxAttempts: opts.modelActionMaxAttempts,
    summaryFactory: opts.summaryFactory,
    results: opts.results,
    reportPolicy: opts.reportPolicy,
    table, jobs, roles, factOwner, parentRegistry, parentSession: opts.parentSession, parentCtx: ctx,
    parentModel: opts.parentModel, resolveModel: opts.resolveModel, exec: opts.exec,
    agents,
    codeMode: opts.codeMode, codeModeFactory: opts.codeModeFactory,
    // The role-model gate travels with the resolver it gates: both ride
    // RegisterSubagentOptions → SubagentToolDeps → spawnChild's opts.
    // Omitted when the host passed none — an unset switch is OFF, and the
    // subagent package must not read one into existence.
    ...(opts.roleSelectionFor !== undefined ? { roleSelectionFor: opts.roleSelectionFor } : {}),
    ...(opts.allowSubagentModelSelection !== undefined ? { allowSubagentModelSelection: opts.allowSubagentModelSelection } : {}),
    ...(opts.autoCompactionEnabled ? { autoCompactionEnabled: opts.autoCompactionEnabled } : {}),
    ...(opts.inheritedSystemContext ? { inheritedSystemContext: opts.inheritedSystemContext } : {}),
    // M73: the session's numbers ride the SAME chain one hop further. The host
    // shape (RoleModelHost) reaches registerSubagent with them, and stopping
    // here would leave the tool arm — the main spawn path — empty-handed: the
    // deps object is what createSubagentTools reads, so a value not copied
    // onto it does not exist for the tool. Absent stays absent.
    get contextWindow() { return opts.contextWindow },
    inheritedBindingForStep: opts.inheritedBindingForStep,
    get budgetBinding() { return opts.budgetBinding },
    get contextMetadata() { return opts.contextMetadata },
    get reasoningEffort() { return opts.reasoningEffort },
    get maxOutputTokens() { return opts.maxOutputTokens },
    tasks,
    parentNotify: opts.parentNotify,
    notificationNamespace: opts.persist?.stateId ?? `mount-${crypto.randomUUID()}`,
    onTaskTerminalCommitted: () => { notifDrainHook?.() },
    onTaskTerminalRecovery: () => { opts.parentNotify?.wake(opts.persist?.parentSessionId ?? '') },
    registerDeliverySource(taskId, source) {
      const original = deliverySources.get(taskId)
      if (original && original !== source) throw new Error('Original delivery source cannot be replaced')
      deliverySources.set(taskId, source)
      return () => { if (deliverySources.get(taskId) === source) deliverySources.delete(taskId) }
    },
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
  for (const originalTool of tools) {
    const tool = ownedTask ? { ...originalTool, async execute(...args: Parameters<typeof originalTool.execute>) { await ready; tasks.assertReady(); return originalTool.execute(...args) } } : originalTool
    if (!parentRegistry.get(tool.name)) {
      if(ownedTask&&tool.name==='spawn_agent'){launchTool=tool;launchEntry=bindPreparedTaskLaunchLeaf(tool,tool.execute)}
      parentRegistry.register(tool)
    }
  }
  // M26-D2: the notification drain. admit = the host-injected A-plan admission
  // (ParentInputAdmission — run.ts backs it with the real SessionExecutor's
  // inject tier); isSessionCancelled suppresses delivery when the parent chain
  // was cancelled (R-D3 opencode rule). One drain instance per mount; it is
  // activated only after the host publishes its actual receiver lane.
  const notifDrain = createNotificationDrain({
    reconcileSources: settleParentDeliverySources,
    reportPolicy: opts.reportPolicy,
    tasks,
    admit: opts.parentNotify,
    evidence(taskId) {
      // A live source stays registered until its own terminal AND task-save
      // barriers succeed. The notifier cannot retry a failed task save or
      // treat committed terminal bytes alone as completed handoff ownership.
      if (deliverySources.has(taskId)) return
      const source = (readOwnedDeliveryState(opts.parentSession) ?? readDeliveries(opts.parentSession)).source(subagentDeps.notificationNamespace!, taskId)
      if (source?.type !== 'agent/delivery-source') return
      const terminal = opts.parentSession.events.findLast(e => e.type === 'subagent/end' && e.taskId === taskId && !!e.resultRevision && !!e.envelope && e.envelope.retention.kind !== 'unavailable' && (e.outcome === 'completed' || e.outcome === 'error'))
      if (terminal?.type !== 'subagent/end') return
      return { evidence: { sourceSeq: source.seq!, terminalSeq: terminal.seq! }, expectedInputId: deliveryInputId({
        recipientSessionId: source.recipientSessionId, sourceNamespace: source.sourceNamespace, sourceId: source.sourceId,
        resultRevision: terminal.resultRevision!, kind: 'subagent',
      }) }
    },
    isSessionCancelled: (sessionId) => isSessionCancelledChain(tasks, sessionId),
  })
  const notificationDrains = new Set<Promise<number>>()
  let notificationsActive = false, notificationsRetired = false
  notifDrainHook = () => {
    if (!notificationsActive || notificationsRetired) return
    const job = notifDrain.drain()
    notificationDrains.add(job)
    // Forward failure as a dirty hint to the already published host drain.
    // Only that owner classifies the original error and arms its retry.
    void job.catch(() => {
      try { opts.parentNotify?.wake(opts.persist?.parentSessionId ?? '') } catch { /* A host hint cannot replace the retained drain failure. */ }
    }).finally(() => { notificationDrains.delete(job) })
  }
  if (ownedTask) {
    ready = (async () => {
      await taskOwner.ready
      taskOwner.assertReady()
      const wired = wireSubagentPersistence(stagedRuntime, { ...opts.persist!, factOwner: opts.persist!.factOwner ?? opts.factOwner })
      factPersistence = wired
      mountedRuntime = wired
      if (opts.restoredState) emitRestoredJobTransitions(opts.persist!, opts.restoredState, jobs, wired.observe)
      await taskOwner.qualifyRestoredResults()
      await classifyRestoredTasks(taskOwner, opts.persist!.coordinator)
      await restoreMirrorsAndSweep(subagentDeps, wired.table, () => { runtimeWorkReady = true })
    })().catch(cause => {
      runtimeWorkReady = false
      startupFailure = { cause }
      throw cause
    })
  } else {
    if (opts.restoredState && opts.persist) emitRestoredJobTransitions(opts.persist, opts.restoredState, jobs, factPersistence?.observe)
    if (opts.persist) ready = restoreTasksAndSweep(subagentDeps, table, opts.persist, tasks)
  }
  void ready.catch(() => {})
  let disposeFlight: Promise<void> | undefined
  const entryPhases = new Map<ChildAgentEntry, { settled: boolean; disposed: boolean; dispose?: () => Promise<void>; unmount?: () => void; chain?: Promise<void>; sessionId?: string; agent?: ReturnType<AgentRegistry['get']> }>()
  let factsFlushed = false, tasksFlushed = false, factsClosed = false, readyFailureReported = false
  function dispose(): Promise<void> {
    notificationsRetired = true
    runtimeRetiring = true
    taskOwner.retireOwnedLoad()
    const owner = residentOwnerFor(subagentDeps)
    if (owner.inInvocation()) { owner.retire(); return refusedReentry() }
    if (disposeFlight) return disposeFlight
    const attempt = Promise.withResolvers<void>()
    disposeFlight = attempt.promise
    const finishCleanup = owner.beginCleanupAttempt()
    void attempt.promise.then(() => { disposeFlight = undefined; finishCleanup() }, () => { disposeFlight = undefined; finishCleanup() })
    owner.retire()
    // Release original consumer fences before any source/entry join can flush
    // a queued save behind them. The same flight retains read cleanup debt.
    const taskClosing = taskOwner.closeOwnedLoad()
    void taskClosing.catch(() => {})
    const fenceEntries = () => { for (const entry of table.entries().values()) {
      if (!entryPhases.has(entry)) entryPhases.set(entry, { settled: false, disposed: false,
        dispose: entry.dispose?.bind(entry), unmount: entry.unmount?.bind(entry), chain: entry.followupChain,
        sessionId: entry.sessionId, agent: entry.sessionId ? agents.get(entry.sessionId) : undefined })
      if (!entry.closing) { if (ownedTask) entry.closing = true; else table.update(entry.path, entry, { closing: true }) }
      entry.controller.abort()
      if (entry.sessionId) opts.persist?.coordinator.revokeManagedDocumentNewWork(entry.sessionId)
    } }
    fenceEntries()
    void (async () => {
      const errors: unknown[] = []
      try { await ready } catch (error) { if (!readyFailureReported) { errors.push(error); readyFailureReported = true } }
      fenceEntries()
      // Begin the private owner's attempt before entry aliases can join it;
      // a failed phase is attempted once by this external close, not twice.
      const ownedClosing = owner.close()
      void ownedClosing.catch(() => {})
      const results = await Promise.allSettled([...entryPhases].map(async ([entry, phases]) => {
        const failures: unknown[] = []
        if (!phases.settled) try { await owner.settleEntryResult(entry); phases.settled = true } catch (error) { failures.push(error) }
        if (!phases.disposed) try {
          if (phases.dispose) await phases.dispose()
          else { await phases.chain; await phases.unmount?.() }
          phases.disposed = true
        } catch (error) { failures.push(error) }
        if (!failures.length && phases.sessionId && agents.get(phases.sessionId) === phases.agent) agents.remove(phases.sessionId)
        if (failures.length) throw new AggregateError(failures, 'Original entry cleanup incomplete')
      }))
      errors.push(...results.flatMap(result => result.status === 'rejected' ? [result.reason] : []))
      try { await ownedClosing } catch (error) { errors.push(error) }
      if (!factsFlushed) try { await factPersistence?.flushFacts(); factsFlushed = true } catch (error) { errors.push(error) }
      try { await taskClosing } catch (error) { errors.push(error) }
      if (!tasksFlushed) try { if (!ownedTask) await tasks.flushPersistence(); tasksFlushed = true } catch (error) { errors.push(error) }
      if (!errors.length && !factsClosed) try { await factPersistence?.closeFacts(); factsClosed = true } catch (error) { errors.push(error) }
      if (errors.length) throw Object.assign(new AggregateError(errors, 'Subagent settlement requires recovery'), { code: 'FACT_RECOVERY_REQUIRED' })
    })().then(attempt.resolve, attempt.reject)
    return attempt.promise
  }
  return {
    async retainResults() {
      await ready
      tasks.assertReady()
      if (!opts.persist) return "memory"
      if (!opts.persist.coordinator.putDocumentStrict) throw new Error("Strict result retention is unavailable")
      await opts.persist.coordinator.putDocumentStrict(opts.persist.stateId, snapshotState({ jobs, table, roles }))
      return "durable"
    },
    roles, jobs, table, agents,
    retainInitialSetup: (setup: import('./child/instruction-context.ts').InitialChildSetup) => residentOwnerFor(subagentDeps).retainInitial(setup),
    ensureResident: (entry: ChildAgentEntry, controller?: AbortController, executionCurrent?: () => boolean) => ownedTask ? ready.then(() => { tasks.assertReady(); return ensureResidentAgent(subagentDeps, entry, controller, executionCurrent) }) : ensureResidentAgent(subagentDeps, entry, controller, executionCurrent),
    followupActivation: subagentDeps.residentActivation,
    captureFollowupGeneration: followupDepsWithRebuild(subagentDeps).captureGeneration,
    followupGeneration: followupDepsWithRebuild(subagentDeps).openGeneration,
    ready, tasks,
    settleParentDeliverySources,
    async drainParentNotifications() {
      if (notificationsRetired) return
      await ready
      if (notificationsRetired) return
      notificationsActive = true
      const job = notifDrain.drain()
      notificationDrains.add(job)
      try { await job } finally { notificationDrains.delete(job) }
    },
    dispose,
    async flushPersistence() {
      await ready
      for (;;) {
        await Promise.allSettled([...notificationDrains])
        await factPersistence?.flushFacts()
        await tasks.flushPersistence()
        if (notificationDrains.size === 0) return
      }
    },
    projectTasks: () => projectAgentTasks({ table, jobs, roles, tasks }),
  }
}

// M26-D1/D2: post-restore task protocol chain — (1) load the durable task doc
// (records + outbox rows), (2) classify ambiguous accepted/running attempts from
// the durable child log (completed | recovery-required — never re-dispatch),
// (3) G1a mirrors + G4 sweep (existing M24a steps). Notifications drain (D2-T1)
// activates separately after the host publishes its lane.
async function restoreTasksAndSweep(
  deps: SubagentToolDeps,
  table: AgentTable,
  persist: SubagentPersistence,
  tasks: TaskRegistry,
): Promise<void> {
  // ADAPTATION (M26-D1, plan T5 Step 3 vs M24a G1a test): the plan's naive
  // order (task doc restore FIRST) suspends on the first await and defers the
  // mirror rebuild past a microtask — the existing G1a test asserts load() is
  // called SYNCHRONOUSLY at mount. Mirrors first restores that contract; the
  // task-doc restore + classification only read durable state (no mirror
  // dependency), and `ready` still gates the whole chain for hosts.
  await restoreMirrorsAndSweep(deps, table)
  if (deps.childSessions) {
    let doc: unknown
    try { doc = await deps.childSessions.coordinator.getDocument(taskDocKey(persist.stateId)) } catch { /* Missing/corrupt legacy document stays unavailable. */ }
    if (doc !== undefined) tasks.restore(doc as TaskProtocolDocument)
    await tasks.qualifyRestoredResults()
    await classifyRestoredTasks(tasks, deps.childSessions.coordinator)
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
async function restoreMirrorsAndSweep(deps: SubagentToolDeps, table: AgentTable, beforeSweep?: () => void): Promise<void> {
  for (const entry of table.entries().values()) {
    if (!entry.sessionId || !deps.childSessions) continue
    if (isColdBoundChild(deps.tasks, entry.sessionId, entry.taskId)) continue
    try {
      const document = await deps.childSessions.coordinator.openManagedDocument(entry.sessionId)
      table.update(entry.path, entry, { session: document.view, factOwner: document })
    } catch {
      // G1a fail-visible: no silent empty-stub downgrade.
      table.update(entry.path, entry, { status: "error", error: "child log unavailable after resume" })
    }
  }
  beforeSweep?.()
  await sweepPendingInbox(deps, table)
}
