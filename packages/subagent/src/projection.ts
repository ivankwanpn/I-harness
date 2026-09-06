// packages/subagent/src/projection.ts — M49 Task 12 (spec §8.2): the READ-ONLY
// task projection at the subagent domain boundary.
//
// The mutable registries NEVER leave this module: the projection only READS
// the public registry surfaces and returns plain serializable AgentTaskView
// objects (stable ids = real agent paths / job ids / task ids — never an
// array position). `canCancel` follows the CURRENT registry state at call
// time, not a UI guess.
//
// Groups: "subagent" (live agent-table entries + durable task records fused
// by agent path; a record without a live entry surfaces alone — recovered/
// recovery-required truth never disappears), "job" (the jobs registry) and
// "workflow" (projectWorkflowRows over the assembly's real workflow executor
// rows — the executor object itself is never passed here, only its row
// snapshots). The "schedule" group is part of the summary union for hosts
// that mount a schedule source; no source exists in this repo's assemblies
// today, so the projection emits no schedule rows (honestly).
import type { AgentTable, ChildStatus } from "./agent-table.ts"
import type { ChildAgentEntry } from "./agent-table.ts"
import type { JobRegistry, JobStatus } from "./jobs.ts"
import type { RoleRegistry } from "./roles.ts"
import type { TaskRecord, TaskRegistry, TaskStatus } from "./task-protocol.ts"

/** Summary status union — settled and recovered states map truthfully
 * (error → failed, killed → cancelled). */
export type AgentTaskStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled"

/** Every task-source status (agent table / jobs registry / durable task
 * registry) — the projectStatus input union. */
export type TaskSourceStatus = ChildStatus | JobStatus | TaskStatus

export type AgentTaskGroup = "subagent" | "job" | "workflow" | "schedule"

/** One row of the task projection (the list/summary shape — compact). The
 * full detail (role/model/parent prompt/result/error/transcript) lives in the
 * server-side projectAgentTaskDetail payload. */
export interface AgentTaskView {
  id: string
  parentId?: string
  group: AgentTaskGroup
  label: string
  status: AgentTaskStatus
  summary?: string
  startedAt?: number
  updatedAt?: number
  canCancel: boolean
}

/** The read-only domain slice the projection consumes. */
export interface SubagentTaskSource {
  table: AgentTable
  jobs: JobRegistry
  roles: RoleRegistry
  tasks: TaskRegistry
}

/** The server-side detail payload (never serialized onto the task list —
 * keep the list compact; the payload stays domain-side for hosts that can
 * reach it). */
export interface AgentTaskDetail {
  id: string
  group: AgentTaskGroup
  /** The role the subagent was spawned with (subagent rows only). */
  role?: string
  /** The role's CONFIGURED model (undefined = inherited from the parent —
 * the role carries no model). */
  model?: string
  /** The parent's spawn prompt (durable task record). */
  parentPrompt?: string
  result?: string
  error?: string
  /** Honest transcript availability statement. */
  transcriptAvailability: string
}

/** Map every task-source status onto the summary union. */
export function projectStatus(input: { status: TaskSourceStatus }): AgentTaskStatus {
  switch (input.status) {
    case "running": return "running"
    case "waiting": return "waiting"
    case "completed": return "completed"
    case "error":
    case "recovery-required": return "failed"
    case "killed":
    case "cancelled": return "cancelled"
    case "accepted": return "queued"
  }
}

/** Project the assembly's real task rows (subagent + job). */
export function projectAgentTasks(state: SubagentTaskSource): AgentTaskView[] {
  const rows: AgentTaskView[] = []

  // The agent-table's jobId backlink maps a job row to the agent that owns it
  // (real spawns; persist keeps the link through the durable doc).
  const jobIdToPath = new Map<string, string>()
  for (const [path, entry] of state.table.entries()) {
    if (entry.jobId !== undefined) jobIdToPath.set(entry.jobId, path)
  }

  // Fuse durable task records onto their live entries by agent path; records
  // without a live entry surface alone (recovered truth is never dropped).
  const recordByPath = new Map<string, TaskRecord>()
  const recordOnly: TaskRecord[] = []
  for (const record of state.tasks.list()) {
    if (state.table.get(record.agentPath) !== undefined) recordByPath.set(record.agentPath, record)
    else recordOnly.push(record)
  }

  for (const [path, entry] of state.table.entries()) {
    rows.push({
      id: path,
      ...(parentPathOf(path) !== undefined ? { parentId: parentPathOf(path) } : {}),
      group: "subagent",
      label: entry.roleName ?? lastSegmentOf(path) ?? path,
      status: fusedStatus(entry.status, recordByPath.get(path)),
      ...(summaryOf(entry, recordByPath.get(path)) !== undefined ? { summary: summaryOf(entry, recordByPath.get(path)) } : {}),
      canCancel: entry.status === "running",
    })
  }
  for (const record of recordOnly) {
    rows.push({
      id: record.id,
      group: "subagent",
      label: record.agentPath,
      status: record.outcome !== undefined ? projectStatus({ status: record.outcome }) : projectStatus({ status: record.status }),
      ...(errorOrOutcomeOf(record) !== undefined ? { summary: errorOrOutcomeOf(record) } : {}),
      canCancel: false,
    })
  }

  for (const job of state.jobs.listAll()) {
    rows.push({
      id: job.id,
      ...(jobParentOf(state, jobIdToPath, job.id, job.owner) !== undefined ? { parentId: jobParentOf(state, jobIdToPath, job.id, job.owner) } : {}),
      group: "job",
      label: job.label,
      status: projectStatus({ status: job.status }),
      ...(job.startedAt !== undefined ? { startedAt: job.startedAt } : {}),
      ...(job.endedAt !== undefined ? { updatedAt: job.endedAt } : {}),
      canCancel: job.status === "running",
    })
  }

  return rows
}

/** The server-side detail payload for one projected row (subagent rows carry
 * role/model/parent prompt/result/error/transcript; job rows carry the
 * captured output). */
export function projectAgentTaskDetail(state: SubagentTaskSource, row: AgentTaskView): AgentTaskDetail | undefined {
  switch (row.group) {
    case "subagent": {
      const entry = state.table.get(row.id)
      const record = state.tasks.list().find((r) => r.agentPath === row.id)
      const pool = record ?? state.tasks.get(row.id)
      const roleName = entry?.roleName ?? record?.agent
      const role = roleName !== undefined ? state.roles.get(roleName) : undefined
      const detail: AgentTaskDetail = {
        id: row.id,
        group: row.group,
        ...(roleName !== undefined ? { role: roleName } : {}),
        ...(role?.model !== undefined ? { model: `${role.model.provider}:${role.model.model}` } : {}),
        ...(pool?.prompt !== undefined ? { parentPrompt: pool.prompt } : {}),
        ...(pool?.resultText ?? entry?.finalText !== undefined ? { result: pool?.resultText ?? entry?.finalText } : {}),
        ...(pool?.error ?? entry?.error !== undefined ? { error: pool?.error ?? entry?.error } : {}),
        transcriptAvailability:
          entry !== undefined
            ? entry.sessionId !== undefined
              ? `durable child session (${entry.sessionId})`
              : "in-memory child session only"
            : "no live entry — durable task record only",
      }
      return detail
    }
    case "job": {
      const job = state.jobs.listAll().find((j) => j.id === row.id)
      if (job === undefined) return undefined
      return {
        id: row.id,
        group: row.group,
        ...(job.output !== "" ? { result: job.output } : {}),
        transcriptAvailability: "job output captured by the registry",
      }
    }
    default:
      return {
        id: row.id,
        group: row.group,
        transcriptAvailability: "background owner surface",
      }
  }
}

/** Workflow rows: the assembly hands the RAW row snapshots of its real
 * workflow executor (id/status/stdout/stderr) — never the executor. Rows
 * appear ONLY when the executor's store owns them. */
export interface WorkflowTaskRow {
  id: string
  status: JobStatus
  stdout: string
  stderr: string
  exitCode?: number
}

export function projectWorkflowRows(rows: ReadonlyArray<WorkflowTaskRow>): AgentTaskView[] {
  return rows.map((job) => ({
    id: job.id,
    group: "workflow",
    label: job.id,
    status: projectStatus({ status: job.status }),
    ...(oneLineOf(job.stderr !== "" ? job.stderr : job.stdout) !== undefined ? { summary: oneLineOf(job.stderr !== "" ? job.stderr : job.stdout) } : {}),
    canCancel: job.status === "running",
  }))
}

// ------------------------------------------------------------------ helpers

/** Durable terminal outcome wins over the live entry's transient state; a
 * record with no outcome keeps the live status (running/waiting/…). */
function fusedStatus(entryStatus: ChildStatus, record: TaskRecord | undefined): AgentTaskStatus {
  if (record?.outcome !== undefined) return projectStatus({ status: record.outcome })
  return projectStatus({ status: entryStatus })
}

function summaryOf(entry: ChildAgentEntry, record: TaskRecord | undefined): string | undefined {
  const out = errorOrOutcomeOf(record)
  if (out !== undefined) return out
  return entry.error
}

function errorOrOutcomeOf(record: TaskRecord | undefined): string | undefined {
  if (record === undefined) return undefined
  if (record.error !== undefined) return record.error
  if (record.outcome === "recovery-required") {
    return record.recoveryReason !== undefined
      ? `recovery required (${record.recoveryReason})`
      : "recovery required"
  }
  if (record.outcome === "completed" && record.resultText !== undefined) return oneLineOf(record.resultText)
  return undefined
}

function oneLineOf(text: string | undefined): string | undefined {
  if (text === undefined || text === "") return undefined
  const first = text.split("\n")[0]!.trim()
  if (first === "") return undefined
  return first.length > 120 ? `${first.slice(0, 119)}…` : first
}

function parentPathOf(path: string): string | undefined {
  const i = path.lastIndexOf("/")
  return i === -1 ? undefined : path.slice(0, i)
}

function lastSegmentOf(path: string): string | undefined {
  const i = path.lastIndexOf("/")
  return i === -1 ? path : path.slice(i + 1)
}

function jobParentOf(
  state: SubagentTaskSource,
  jobIdToPath: Map<string, string>,
  jobId: string,
  owner: string,
): string | undefined {
  const viaBacklink = jobIdToPath.get(jobId)
  if (viaBacklink !== undefined) return viaBacklink
  return owner !== "root" && state.table.get(owner) !== undefined ? owner : undefined
}
