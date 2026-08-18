import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { JobRegistry, JobStatus } from "./jobs.ts"
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
}

export interface DurableJobRecord {
  id: string
  owner: string
  kind: string
  label: string
  status: JobStatus
  output: string
  terminal: boolean
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
}

export function snapshotState(state: { jobs: JobRegistry; table: AgentTable; roles: RoleRegistry }): SubagentStateSnapshot {
  // The harness registers all subagent jobs under owner "root" (spawnChild uses
  // registerJob("root", "subagent", ...)); list("root") is the enumeration.
  const jobSnaps = state.jobs.list("root")
  const jobsOut: DurableJobRecord[] = jobSnaps.map((j) => ({
    id: j.id, owner: "root", kind: j.kind, label: j.label, status: j.status, output: j.output,
    terminal: j.status !== "running",
  }))

  const agentTable: DurableAgentEntry[] = [...state.table.entries().values()].map((e) => ({
    path: e.path,
    status: e.status,
    ...(e.finalText !== undefined ? { finalText: e.finalText } : {}),
    ...(e.error !== undefined ? { error: e.error } : {}),
    mailbox: e.mailbox,
    ...(e.jobId !== undefined ? { jobId: e.jobId } : {}),
    ...(e.sessionId !== undefined ? { sessionId: e.sessionId } : {}),
  }))

  const roles = state.roles.list()

  return { formatVersion: 1, jobs: jobsOut, agentTable, roles }
}

export function restoreState(
  state: { jobs: JobRegistry; table: AgentTable; roles: RoleRegistry },
  snap: SubagentStateSnapshot,
): void {
  // Restore roles first (register may be used by later spawns).
  for (const role of snap.roles) {
    if (!state.roles.get(role.name)) state.roles.register(role)
  }
  // Agent table: restore entries; running → error (process gone after resume,
  // design spec M6). Such entries carry the explicit "interrupted by resume"
  // marker so callers can distinguish them from genuine runtime errors.
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
    })
  }
  // Jobs: register fresh (ids drift — registerJob assigns new per-kind ids;
  // status/output/kind/label preserved). Running jobs were mid-flight when the
  // harness stopped → restore as error (design spec M6). Agent-table jobId
  // links are advisory.
  for (const rec of snap.jobs) {
    const wasRunning = rec.status === "running"
    const { id } = state.jobs.registerJob(rec.owner, rec.kind, rec.label)
    state.jobs.updateJob(id, {
      status: wasRunning ? "error" : rec.status,
      output: wasRunning ? "interrupted by resume" : rec.output,
    })
  }
}

function createSessionFromEmpty() {
  // Minimal Session shape (formatVersion + events); callers only need a
  // non-null session object on restored entries.
  return { formatVersion: 1, events: [] as unknown[] } as unknown as ReturnType<typeof import("@i-harness/core-session").createSession>
}

export function persistentJobRegistry(
  jobs: JobRegistry,
  save: () => Promise<void>,
): JobRegistry {
  return {
    ...jobs,
    registerJob(owner, kind, label) {
      const result = jobs.registerJob(owner, kind, label)
      void save()
      return result
    },
    updateJob(id, patch) {
      jobs.updateJob(id, patch)
      void save()
    },
    kill(id) {
      const outcome = jobs.kill(id)
      // Only a real kill changes state; a no-op kill ("already-finished")
      // must not trigger a save.
      if (outcome === "cancellation-requested") void save()
      return outcome
    },
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
  // Return wrapped registries (deterministic — no in-place mutation). The
  // caller uses the returned object for the 11 tools and later lookups.
  return {
    jobs: persistentJobRegistry(state.jobs, async () => { await saveAll() }),
    table: persistentAgentTable(state.table, async () => { await saveAll() }),
    roles: persistentRoleRegistry(state.roles, async () => { await saveAll() }),
  }
}
