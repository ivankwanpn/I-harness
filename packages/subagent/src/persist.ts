import type { SessionCoordinator } from "@i-harness/session-persistence"
import { append, type Session, type SessionEvent } from "@i-harness/core-session"
import type { JobRegistry, JobStatus, JobSnapshot } from "./jobs.ts"
import type { AgentTable, ChildStatus } from "./agent-table.ts"
import type { RoleRegistry, SubagentRole } from "./roles.ts"

export interface DurableAgentEntry {
  path: string
  status: ChildStatus
  finalText?: string
  error?: string
  mailbox: string[]
  jobId?: string
  sessionId?: string
  // M9: the role name the child was spawned with — needed to rebuild the
  // agent (systemPrompt/tools/model) on cold resume.
  roleName?: string
  // M9: the durable inbox consumption cursor. Persisted so a cold-resumed
  // child does NOT re-process inbox events that were already consumed into
  // followup turns (duplicate-turn bug fixed in Task 5).
  lastInboxSeq?: number
}

export interface DurableJobRecord {
  id: string
  owner: string
  kind: string
  label: string
  status: JobStatus
  output: string
  terminal: boolean
  // Task 4.4: wall-clock stamps (Date.now() at registry mutation) so the web
  // jobs surface can show elapsed/duration honestly and the route can answer
  // startedAt/endedAt. Additive to the doc — older docs simply lack them.
  startedAt?: number
  endedAt?: number
}

export interface SubagentStateSnapshot {
  formatVersion: 1
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
  parentSession?: Session
}

export function snapshotState(state: { jobs: JobRegistry; table: AgentTable; roles: RoleRegistry }): SubagentStateSnapshot {
  // The harness registers all subagent jobs under owner "root" (spawnChild uses
  // registerJob("root", "subagent", ...)); list("root") is the enumeration.
  const jobSnaps = state.jobs.list("root")
  const jobsOut: DurableJobRecord[] = jobSnaps.map((j) => ({
    id: j.id, owner: "root", kind: j.kind, label: j.label, status: j.status, output: j.output,
    terminal: j.status !== "running",
    // Task 4.4: stamps ride the doc verbatim (restore replays them, they are
    // never re-minted on resume).
    ...(j.startedAt !== undefined ? { startedAt: j.startedAt } : {}),
    ...(j.endedAt !== undefined ? { endedAt: j.endedAt } : {}),
  }))

  const agentTable: DurableAgentEntry[] = [...state.table.entries().values()].map((e) => ({
    path: e.path,
    status: e.status,
    ...(e.finalText !== undefined ? { finalText: e.finalText } : {}),
    ...(e.error !== undefined ? { error: e.error } : {}),
    mailbox: e.mailbox,
    ...(e.jobId !== undefined ? { jobId: e.jobId } : {}),
    ...(e.sessionId !== undefined ? { sessionId: e.sessionId } : {}),
    ...(e.roleName !== undefined ? { roleName: e.roleName } : {}),
    ...(e.lastInboxSeq !== undefined ? { lastInboxSeq: e.lastInboxSeq } : {}),
  }))

  const roles = state.roles.list()

  return { formatVersion: 1, jobs: jobsOut, agentTable, roles }
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
  void persistence
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
    const status: ChildStatus = wasRunning ? "error" : entry.status
    state.table.add(entry.path, {
      path: entry.path,
      status,
      session: createSessionFromEmpty(),
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
  // Jobs: M24a (G2) the persisted id is authoritative — registerJob is given
  // `rec.id` so post-resume followups address jobs by their original id (no
  // re-count drift). A duplicate id fails loud. Running jobs were mid-flight
  // when the harness stopped → restore as error (design spec M6). Agent-table
  // jobId links are advisory.
  for (const rec of snap.jobs) {
    const wasRunning = rec.status === "running"
    const { id } = state.jobs.registerJob(rec.owner, rec.kind, rec.label, rec.id, rec.startedAt)
    state.jobs.updateJob(id, {
      status: wasRunning ? "error" : rec.status,
      output: wasRunning ? "interrupted by resume" : rec.output,
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
  return { formatVersion: 1, events: [] as unknown[] } as unknown as ReturnType<typeof import("@i-harness/core-session").createSession>
}

// Task 4.4: a real transition observer — called with the post-change snapshot
// for every transition that actually mutated state (never for no-op updates).
export type JobTransitionObserver = (job: JobSnapshot) => void

// Task 4.4: the additive `job/status` event (core-session SessionEvent,
// registered in session-persistence's load gate). Whole-job snapshot per
// event so a consumer folds last-wins by jobId (the goal/change pattern).
function jobStatusEvent(job: JobSnapshot): SessionEvent {
  return {
    type: "job/status",
    version: 1,
    job: {
      jobId: job.id,
      kind: job.kind,
      label: job.label,
      status: job.status,
      outputAvailable: job.output.length > 0,
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
    registerJob(owner, kind, label, id, startedAt) {
      const result = jobs.registerJob(owner, kind, label, id, startedAt)
      observe?.(jobs.read(result.id))
      void save()
      return result
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
        if (prev !== undefined && (prev.status !== next.status || prev.output !== next.output)) observe?.(next)
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
): void {
  if (persist.parentSession === undefined) return
  for (const rec of snap.jobs) {
    if (rec.status !== "running") continue
    const view = jobs.read(rec.id)
    append(persist.parentSession, jobStatusEvent(view))
  }
}

export function persistentAgentTable(
  table: AgentTable,
  save: () => Promise<void>,
): AgentTable {
  return {
    ...table,
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
): { jobs: JobRegistry; table: AgentTable; roles: RoleRegistry } {
  const saveAll = async () => {
    await persist.coordinator.putDocument(persist.stateId, snapshotState(state))
  }
  // Task 4.4: the transition observer is wired ONLY when the caller handed the
  // live parent session (web path) — otherwise zero events (additive-only).
  const observe: JobTransitionObserver | undefined =
    persist.parentSession === undefined
      ? undefined
      : (job) => { append(persist.parentSession!, jobStatusEvent(job)) }
  // Return wrapped registries (deterministic — no in-place mutation). The
  // caller uses the returned object for the 11 tools and later lookups.
  return {
    jobs: persistentJobRegistry(state.jobs, async () => { await saveAll() }, observe),
    table: persistentAgentTable(state.table, async () => { await saveAll() }),
    roles: persistentRoleRegistry(state.roles, async () => { await saveAll() }),
  }
}
