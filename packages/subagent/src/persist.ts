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
}

type SnapshotOf<T> = T extends "jobs" ? Pick<SubagentStateSnapshot, "jobs">
  : T extends "agentTable" ? Pick<SubagentStateSnapshot, "agentTable">
  : T extends "roles" ? Pick<SubagentStateSnapshot, "roles">
  : never

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
  save: (snap: SnapshotOf<"jobs">) => Promise<void>,
): JobRegistry {
  const record = new Map<string, DurableJobRecord>()
  return {
    ...jobs,
    registerJob(owner, kind, label) {
      const result = jobs.registerJob(owner, kind, label)
      record.set(result.id, { id: result.id, owner, kind, label, status: "running", output: "", terminal: false })
      void save({ jobs: [...record.values()] })
      return result
    },
    updateJob(id, patch) {
      jobs.updateJob(id, patch)
      const rec = record.get(id)
      if (rec) {
        if (patch.status !== undefined) { rec.status = patch.status; rec.terminal = rec.status !== "running" }
        if (patch.output !== undefined) rec.output = patch.output
        void save({ jobs: [...record.values()] })
      }
    },
    kill(id) {
      const outcome = jobs.kill(id)
      const rec = record.get(id)
      // Only reflect a real kill: an already-terminal job returns
      // "already-finished" with no state change — mirror stays accurate.
      if (rec && outcome === "cancellation-requested") { rec.status = "killed"; rec.terminal = true; void save({ jobs: [...record.values()] }) }
      return outcome
    },
  }
}

export function persistentAgentTable(
  table: AgentTable,
  save: (snap: SnapshotOf<"agentTable">) => Promise<void>,
): AgentTable {
  return {
    ...table,
    add(path, entry) {
      table.add(path, entry)
      void save({ agentTable: durableEntries(table) })
    },
    remove(path) {
      table.remove(path)
      void save({ agentTable: durableEntries(table) })
    },
  }
}

export function persistentRoleRegistry(
  roles: RoleRegistry,
  save: (snap: SnapshotOf<"roles">) => Promise<void>,
): RoleRegistry {
  return {
    ...roles,
    register(role) {
      roles.register(role)
      void save({ roles: roles.list() })
    },
    remove(name) {
      roles.remove(name)
      void save({ roles: roles.list() })
    },
  }
}

function durableEntries(table: AgentTable): DurableAgentEntry[] {
  return [...table.entries().values()].map((e) => ({
    path: e.path,
    status: e.status,
    ...(e.finalText !== undefined ? { finalText: e.finalText } : {}),
    ...(e.error !== undefined ? { error: e.error } : {}),
    mailbox: e.mailbox,
    ...(e.jobId !== undefined ? { jobId: e.jobId } : {}),
  }))
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
