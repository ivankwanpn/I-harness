import type { SessionCoordinator } from "@i-harness/session-persistence"
import { append, CURRENT_FORMAT_VERSION, createNondurableFactOwner, isNondurableSession, isManagedFactOwner, validRetainedResultRevision, type SessionView, type FactOwner, type SessionEvent } from "@i-harness/core-session"
import { retainedResultWitness, unknownResult, validResultPublication, type ResultPublication, type AuxiliaryResultStatus } from './result-publication.ts'
import { createJobFacts } from './job-facts.ts'
import type { JobRegistry, JobStatus, JobSnapshot } from "./jobs.ts"
import type { AgentTable, ChildStatus } from "./agent-table.ts"
import type { RoleRegistry, SubagentRole } from "./roles.ts"

export interface DurableAgentEntry extends ResultPublication {
  path: string
  status: ChildStatus
  finalText?: string
  result?: import("./task/result.ts").RetainedTaskResult
  taskId?: string
  error?: string
  retention?: "memory" | "pending" | "durable" | "failed"
  retentionError?: string
  mailbox: string[]
  jobId?: string
  sessionId?: string
  // M9: the role name the child was spawned with — needed to rebuild the
  // agent (systemPrompt/tools/model) on cold resume.
  roleName?: string
  // WHY: child.ts:340 records the resolved `provider:model`; persist.ts:136 also
  // restores older entries without it, so absence is not proof of inheritance.
  // Keep this spawn fact rather than re-deriving it from today's settings.
  modelLabel?: string
  // M9: the durable inbox consumption cursor. Persisted so a cold-resumed
  // child does NOT re-process inbox events that were already consumed into
  // followup turns (duplicate-turn bug fixed in Task 5).
  lastInboxSeq?: number
}

export interface DurableJobRecord extends ResultPublication {
  id: string
  owner: string
  kind: string
  label: string
  status: JobStatus
  output: string
  result?: import("./task/result.ts").RetainedTaskResult
  taskId?: string
  terminal: boolean
  agentPath?: string
  sessionId?: string
  // Task 4.4: wall-clock stamps (Date.now() at registry mutation) so the web
  // jobs surface can show elapsed/duration honestly and the route can answer
  // startedAt/endedAt. Additive to the doc — older docs simply lack them.
  startedAt?: number
  endedAt?: number
}

export interface SubagentStateSnapshot {
  formatVersion: 1 | 2
  jobs: DurableJobRecord[]
  agentTable: DurableAgentEntry[]
  roles: SubagentRole[]
}

export interface SubagentPersistence {
  coordinator: SessionCoordinator
  stateId: string
  // M8: the main session id, for child lineage (child-<uuid> header
  // parentSession). The CLI (Task 5) is the only caller and always passes it;
  // without it no childSessions context is passed to the tools and spawns stay
  // anonymous.
  parentSessionId: string
  // Task 4.4 (jobs 状态流): when present, every real job transition appends an
  // additive `job/status` event to this LIVE parent session (the web path
  // passes the live session, so the mux streams + write-behind carry it). A
  // caller that omits it — the CLI headless path — gets zero new events
  // (additive-only, zero behavior change). Deliberately NOT `registerSubagent`
  // defaulted from opts.parentSession (the CLI would suddenly log job events).
  parentSession?: SessionView
  factOwner?: FactOwner
}

export function snapshotState(state: { jobs: JobRegistry; table: AgentTable; roles: RoleRegistry }): SubagentStateSnapshot {
  // The harness registers all subagent jobs under owner "root" (spawnChild uses
  // registerJob("root", "subagent", ...)); list("root") is the enumeration.
  const jobSnaps = state.jobs.list("root")
  const jobsOut: DurableJobRecord[] = jobSnaps.map((j) => ({
    id: j.id, owner: "root", kind: j.kind, label: j.label, status: j.status, output: j.output, ...(j.result ? { result: j.result } : {}),
    terminal: j.status !== "running", ...(j.publication ? { publication: j.publication } : {}), ...(j.savedObservation ? { savedObservation: j.savedObservation } : {}), ...(j.taskId ? { taskId: j.taskId } : {}),
    ...(j.agentPath !== undefined ? { agentPath: j.agentPath } : {}),
    ...(j.sessionId !== undefined ? { sessionId: j.sessionId } : {}),
    // Task 4.4: stamps ride the doc verbatim (restore replays them, they are
    // never re-minted on resume).
    ...(j.startedAt !== undefined ? { startedAt: j.startedAt } : {}),
    ...(j.endedAt !== undefined ? { endedAt: j.endedAt } : {}),
  }))

  const agentTable: DurableAgentEntry[] = [...state.table.entries().values()].map((e) => ({
    path: e.path,
    status: e.status,
    ...(e.finalText !== undefined ? { finalText: e.finalText } : {}),
    ...(e.result ? { result: e.result } : {}),
    ...(e.taskId ? { taskId: e.taskId } : {}),
    ...(e.publication ? { publication: e.publication } : {}), ...(e.savedObservation ? { savedObservation: e.savedObservation } : {}),
    ...(e.error !== undefined ? { error: e.error } : {}),
    ...(e.retention !== undefined ? { retention: e.retention } : {}),
    ...(e.retentionError !== undefined ? { retentionError: e.retentionError } : {}),
    mailbox: e.mailbox,
    ...(e.jobId !== undefined ? { jobId: e.jobId } : {}),
    ...(e.sessionId !== undefined ? { sessionId: e.sessionId } : {}),
    ...(e.roleName !== undefined ? { roleName: e.roleName } : {}),
    ...(e.modelLabel !== undefined ? { modelLabel: e.modelLabel } : {}),
    ...(e.lastInboxSeq !== undefined ? { lastInboxSeq: e.lastInboxSeq } : {}),
  }))

  const roles = state.roles.list().filter((role) => !role.ephemeral)

  return { formatVersion: 2, jobs: jobsOut, agentTable, roles }
}

export function restoreState(
  state: { jobs: JobRegistry; table: AgentTable; roles: RoleRegistry },
  snap: SubagentStateSnapshot,
  // M24a (Ruling M24a-P2): optional; accepted so the caller (index.ts) can
  // hand persistence through, but restoreState stays SYNC. The async G1a
  // hooked-mirror rebuild is deferred to Task 3 (async step after restore in
  // registerSubagent / ensureResidentAgent) — NOT implemented here.
  persistence?: SubagentPersistence,
): void {
  if (snap.formatVersion !== 1 && snap.formatVersion !== 2) throw new Error("Unsupported subagent state version")
  if (snap.formatVersion === 1 && [...snap.agentTable, ...snap.jobs].some(row => row.result !== undefined || row.publication !== undefined || row.savedObservation !== undefined)) throw new Error("Invalid legacy result descriptor")
  for (const row of [...snap.agentTable, ...snap.jobs]) if (row.result !== undefined && !validRetainedResultRevision(row.result)) throw new Error('Invalid retained state result')
  for (const row of [...snap.agentTable, ...snap.jobs]) if (!validResultPublication(row)) throw new Error('Unsupported retained result publication metadata')
  const parent = persistence?.parentSession, owner = persistence?.factOwner
  const qualifiedParent = parent && owner?.view === parent && isManagedFactOwner(parent, owner) ? parent : undefined
  const resultProjection = (row: DurableAgentEntry | DurableJobRecord, identity: { jobId?: string; taskId?: string }, job: boolean) => {
    if (snap.formatVersion !== 2 || !row.result) return undefined
    const observed = row.savedObservation ?? { status: row.status as AuxiliaryResultStatus, ...(row.result.kind === 'retained' ? { execution: { ...row.result.envelope.execution } } : {}) }
    const witness = observed.status === 'running' ? undefined : retainedResultWitness(qualifiedParent, row.result, identity)
    const proof = witness && (!job || witness.status === observed.status) ? witness : undefined
    return { status: proof ? observed.status : 'recovery-required' as const, result: proof?.result ?? unknownResult(row.result), publication: proof ? 'committed' as const : 'unqualified' as const, savedObservation: observed }
  }
  // Restore roles first (register may be used by later spawns).
  for (const role of snap.roles) {
    if (!state.roles.get(role.name)) state.roles.register(role)
  }
  // Agent table: restore entries; running → error (process gone after resume,
  // design spec M6). Such entries carry the explicit "interrupted by resume"
  // marker so callers can distinguish them from genuine runtime errors.
  // M24a (G3) waiting fidelity: "waiting" means the child was mid-conversation
  // with a queued followup, not dead — restore it as waiting so the followup
  // re-drive can resume it. Only "running" is interrupted by resume.
  for (const entry of snap.agentTable) {
    const wasRunning = entry.status === "running"
    const result = resultProjection(entry, { jobId: entry.jobId, taskId: entry.taskId }, false)
    const status: ChildStatus = result?.status ?? (wasRunning ? "error" : entry.status)
    state.table.add(entry.path, {
      path: entry.path,
      status,
      session: createSessionFromEmpty(),
      controller: new AbortController(),
      ...(entry.finalText !== undefined ? { finalText: entry.finalText } : {}),
      ...(result ? { result: result.result, publication: result.publication, savedObservation: result.savedObservation } : entry.result ? { result: entry.result } : {}),
      ...(wasRunning || entry.error !== undefined ? { error: wasRunning ? "interrupted by resume" : entry.error } : {}),
      ...(entry.retention !== undefined ? { retention: entry.retention } : {}),
      ...(entry.retentionError !== undefined ? { retentionError: entry.retentionError } : {}),
      mailbox: [...entry.mailbox],
      ...(entry.jobId !== undefined ? { jobId: entry.jobId } : {}),
      ...(entry.taskId !== undefined ? { taskId: entry.taskId } : {}),
      ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
      ...(entry.roleName !== undefined ? { roleName: entry.roleName } : {}),
      ...(entry.modelLabel !== undefined ? { modelLabel: entry.modelLabel } : {}),
      ...(entry.lastInboxSeq !== undefined ? { lastInboxSeq: entry.lastInboxSeq } : {}),
    })
  }
  // Jobs: M24a (G2) the persisted id is authoritative — registerJob is given
  // `rec.id` so post-resume followups address jobs by their original id (no
  // re-count drift). A duplicate id fails loud. Running jobs were mid-flight
  // when the harness stopped → restore as error (design spec M6). Agent-table
  // jobId links are advisory.
  for (const rec of snap.jobs) {
    const wasRunning = rec.status === "running"
    const result = resultProjection(rec, { jobId: rec.id, taskId: rec.taskId }, true)
    // Older documents carried provenance only on the agent entry. Preserve
    // that exact job-id link before a later close removes the entry; never
    // infer historical ownership from a reusable task name or job label.
    const linked = snap.agentTable.find(entry => entry.jobId === rec.id && (rec.agentPath === undefined || rec.agentPath === entry.path))
    const agentPath = rec.agentPath ?? linked?.path
    const sessionId = rec.sessionId ?? linked?.sessionId
    const { id } = state.jobs.registerJob(rec.owner, rec.kind, rec.label, rec.id, rec.startedAt, undefined,
      agentPath !== undefined ? { agentPath, ...(sessionId !== undefined ? { sessionId } : {}) } : undefined)
    state.jobs.updateJob(id, {
      status: result?.status === 'waiting' ? 'recovery-required' : result?.status ?? (wasRunning ? "error" : rec.status),
      output: wasRunning ? "interrupted by resume" : rec.output,
      ...(result ? { result: result.result, publication: result.publication, savedObservation: result.savedObservation } : rec.result ? { result: rec.result } : {}),
      ...(rec.taskId !== undefined ? { taskId: rec.taskId } : {}),
      // Task 4.4: replay persisted stamps verbatim — a restored job keeps its
      // original startedAt / endedAt instead of re-minting them.
      ...(rec.startedAt !== undefined ? { startedAt: rec.startedAt } : {}),
      ...(rec.endedAt !== undefined ? { endedAt: rec.endedAt } : {}),
    })
  }
}

function createSessionFromEmpty() {
  // Minimal Session shape (formatVersion + events); callers only need a
  // non-null session object on restored entries.
  return { formatVersion: CURRENT_FORMAT_VERSION, events: [] as unknown[] } as unknown as ReturnType<typeof import("@i-harness/core-session").createSession>
}

// Task 4.4: a real transition observer — called with the post-change snapshot
// for every transition that actually mutated state (never for no-op updates).
export type JobTransitionObserver = (job: JobSnapshot) => void

// Task 4.4: the additive `job/status` event (core-session SessionEvent,
// registered in session-persistence's load gate). Whole-job snapshot per
// event so a consumer folds last-wins by jobId (the goal/change pattern).
function jobStatusEvent(job: JobSnapshot): Extract<SessionEvent, { type: 'job/status' }> {
  if (job.status === 'recovery-required') throw new Error('Derived cold publication cannot issue a job status fact')
  return {
    type: "job/status",
    version: 1,
    job: {
      jobId: job.id,
      kind: job.kind,
      label: job.label,
      status: job.status,
      outputAvailable: job.output.length > 0,
      ...(job.result ? { result: job.result } : {}),
      ...(job.startedAt !== undefined ? { startedAt: job.startedAt } : {}),
      ...(job.endedAt !== undefined ? { endedAt: job.endedAt } : {}),
    },
  }
}

export function persistentJobRegistry(
  jobs: JobRegistry,
  save: () => Promise<void>,
  observe?: JobTransitionObserver,
): JobRegistry {
  return {
    ...jobs,
    registerJob(owner, kind, label, id, startedAt, cancel, identity, acquired) {
      const result = jobs.registerJob(owner, kind, label, id, startedAt, cancel, identity, acquired)
      observe?.(jobs.read(result.id))
      void save()
      if(!result.finish)return result
      const finish=result.finish
      return {...result,finish(status,output){
        const previous=jobs.read(result.id),updated=finish(status,output)
        if(updated) {
          const next=jobs.read(result.id)
          if(previous.status!==next.status || previous.output!==next.output){observe?.(next);void save()}
        }
        return updated
      }}
    },
    updateJob(id, patch) {
      // Task 4.4: emit ONLY on an observable change — the wrapper compares the
      // pre/post snapshot (the registry's updateJob returns true for a no-op
      // re-update of a terminal job, which must not fire spurious events).
      let prev: JobSnapshot | undefined
      try {
        prev = jobs.read(id)
      } catch {
        // unknown id — updateJob will report false below
      }
      const updated = jobs.updateJob(id, patch)
      // G2: a failed update (unknown id) changes no state — no spurious save,
      // same rule as the no-op kill above.
      if (updated) {
        const next = jobs.read(id)
        if (prev !== undefined && (prev.status !== next.status || prev.output !== next.output || prev.result !== next.result)) observe?.(next)
        void save()
      }
      return updated
    },
    kill(id) {
      const outcome = jobs.kill(id)
      // Only a real kill changes state; a no-op kill ("already-finished")
      // must not trigger a save.
      if (outcome === "cancellation-requested") {
        observe?.(jobs.read(id))
        void save()
      }
      return outcome
    },
  }
}

// Task 4.4 (fix round 1): emit the terminal `job/status` event for the
// running→"error" restore mapping. restoreState runs PRE-wiring (index.ts
// restores the raw registries first), so the persistence wrapper's observer
// never sees that transition — a resumed session log would replay the
// pre-crash `running` event with nothing after it, and a fold from the log
// would permanently disagree with the durable doc (which says "error"). The
// fix: after wiring, replay the mapped outcome through the event emitter for
// exactly the jobs whose SNAPSHOT status was "running" (the only mapping the
// wrapper could not observe). No-op when the caller did not opt into events
// (no parentSession) — CLI/other embedders unchanged.
export function emitRestoredJobTransitions(
  persist: SubagentPersistence,
  snap: SubagentStateSnapshot,
  jobs: JobRegistry,
  observe?: JobTransitionObserver,
): void {
  if (persist.parentSession === undefined) return
  for (const rec of snap.jobs) {
    if (rec.status !== "running" || snap.formatVersion === 2 && rec.result) continue
    const view = jobs.read(rec.id)
    if (observe) observe(view)
    else {
      if (!isNondurableSession(persist.parentSession)) throw Object.assign(new Error('Restored job facts require the registered source'), { code: 'FACT_OWNER_UNSUPPORTED' })
      append(persist.parentSession, jobStatusEvent(view))
    }
  }
}

export function persistentAgentTable(
  table: AgentTable,
  save: () => Promise<void>,
): AgentTable {
  return {
    ...table,
    update(path, expected, patch) {
      const updated = table.update(path, expected, patch)
      if (updated) void save()
      return updated
    },
    add(path, entry) {
      table.add(path, entry)
      void save()
    },
    remove(path) {
      table.remove(path)
      void save()
    },
  }
}

export function persistentRoleRegistry(
  roles: RoleRegistry,
  save: () => Promise<void>,
): RoleRegistry {
  return {
    ...roles,
    register(role) {
      roles.register(role)
      void save()
    },
    remove(name) {
      roles.remove(name)
      void save()
    },
  }
}

export function wireSubagentPersistence(
  state: { jobs: JobRegistry; table: AgentTable; roles: RoleRegistry },
  persist: SubagentPersistence,
): { jobs: JobRegistry; table: AgentTable; roles: RoleRegistry; observe?: JobTransitionObserver; flushFacts(): Promise<void>; closeFacts(): Promise<void> } {
  const saveAll = async () => {
    await persist.coordinator.putDocument(persist.stateId, snapshotState(state))
  }
  // Task 4.4: the transition observer is wired ONLY when the caller handed the
  // live parent session (web path) — otherwise zero events (additive-only).
  const owner = persist.factOwner ?? (persist.parentSession && isNondurableSession(persist.parentSession) ? createNondurableFactOwner(persist.parentSession) : undefined)
  if (persist.parentSession && (!owner || owner.view !== persist.parentSession)) throw Object.assign(new Error('Job events require matching owned facts'), { code: 'FACT_OWNER_UNSUPPORTED' })
  const facts = persist.parentSession ? createJobFacts(owner!) : undefined
  const observe: JobTransitionObserver | undefined =
    persist.parentSession === undefined
      ? undefined
      : (job) => { if (job.status !== 'recovery-required' && job.publication !== 'unqualified') facts!.record(jobStatusEvent(job)) }
  // Return wrapped registries (deterministic — no in-place mutation). The
  // caller uses the returned object for the 11 tools and later lookups.
  return {
    observe, flushFacts: async () => { await facts?.flush() }, closeFacts: async () => { await facts?.close() },
    jobs: persistentJobRegistry(state.jobs, async () => { await saveAll() }, observe),
    table: persistentAgentTable(state.table, async () => { await saveAll() }),
    roles: persistentRoleRegistry(state.roles, async () => { await saveAll() }),
  }
}
