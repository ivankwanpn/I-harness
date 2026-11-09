import type { TaskResultStore, RetainedTaskResult, TaskResultPageArgs, TaskResultPage } from "./result.ts"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { ReportPolicy } from "../report-policy.ts"
export type TaskStatus = "accepted" | "running" | "completed" | "error" | "cancelled" | "recovery-required"
export type TaskOutcome = "completed" | "error" | "cancelled" | "recovery-required"
export type TaskDelivery = "tool" | "parent"
export type RecoveryReason = "dispatch-unknown" | "response-interrupted"
export type OutboxStatus = "pending" | "delivered" | "woken" | "error" | "suppressed"

export interface TaskIdentity { parentSessionId: string; callEventSeq?: number; toolCallId?: string }
export type TaskSavedObservation = { status: 'accepted' | 'running'; outcome?: never; execution?: import('@i-harness/core-session').ResultExecution }
  | { status: TaskStatus; outcome: TaskOutcome; execution?: import('@i-harness/core-session').ResultExecution }
export interface TaskRecord {
  id: string
  parentSessionId: string
  childBirth?: TaskChildBirthBinding
  toolCallId?: string
  callEventSeq?: number
  childSessionId?: string
  jobId?: string
  agentPath: string
  description: string
  prompt: string
  agent: string
  /** WHY: child.ts:340 records the resolved spawn model; closed children lose their live entry. */
  modelLabel?: string
  delivery: TaskDelivery
  status: TaskStatus
  outcome?: TaskOutcome
  resultText?: string
  error?: string
  bodyKind?: "legacy-text"
  /** Stamped only when restoring a literal v1 row; survives a v2 migration save. */
  legacyFormatVersion?: 1
  result?: RetainedTaskResult
  publication?: 'unqualified' | 'committed'
  savedObservation?: TaskSavedObservation
  retention?: "memory" | "pending" | "durable" | "failed"
  retentionError?: string
  recoveryReason?: RecoveryReason
  /** D-01: the projection disagreed with the durable child session at the last
   * explicit reconcile. Status and result stay untouched; this is a warning
   * marker for diagnostics/UI, cleared when the evidence agrees again. */
  projectionWarning?: "terminal-without-turn-end" | "missing-child-session"
  timeCreated: number
  timeStarted?: number
  timeCompleted?: number
}
export interface TaskNotificationRecord {
  id: string
  submissionId: string
  parentSessionId: string
  messageId: string
  state: TaskOutcome
  description: string
  text: string
  status: OutboxStatus
  attempts: number
  timeCreated: number
  timeDelivered?: number
  timeWoken?: number
  error?: string
}
export type TaskChildBirthBinding = Readonly<{ version: 1; kind: 'task-child-birth'; request: import('@i-harness/session-persistence').ChildBootstrapCaptureRequest }>
export interface TaskProtocolDocument { formatVersion: 1 | 2 | 3; tasks: TaskRecord[]; notifications: TaskNotificationRecord[] }

export class TaskIdentityConflictError extends Error {
  constructor(readonly identity: TaskIdentity) {
    super(`task identity conflict: ${identity.parentSessionId}:${identity.callEventSeq ?? identity.toolCallId ?? "anon"}`)
    this.name = "TaskIdentityConflictError"
  }
}
export class TaskConcurrencyLimitError extends Error {
  constructor(readonly limit: number) {
    super(`subagent concurrency limit reached (max ${limit})`)
    this.name = "TaskConcurrencyLimitError"
  }
}

export interface TaskSubmissionInput {
  identity: TaskIdentity
  childSessionId?: string
  agentPath: string
  description: string
  prompt: string
  agent: string
  delivery: TaskDelivery
}
export interface TaskTerminalizeInput {
  taskId: string
  outcome: TaskOutcome
  resultText?: string
  error?: string
  recoveryReason?: RecoveryReason
}
export interface TaskRegistryOptions {
  launchContext?: Parameters<typeof import('./launch-slots.ts').createTaskLaunchPort>[1]
  /** Internal original-parent save capability; never supplied by a tool. */
  ownedTask?: import('./persistence.ts').OwnedTaskContext
  results?: TaskResultStore
  reportPolicy?: ReportPolicy
  coordinator?: SessionCoordinator
  stateId?: string
  maxConcurrency?: number
  onTerminalized?: (task: TaskRecord) => void
}
export interface TaskRegistry {
  /** Original owned document load; legacy manual registries are immediately ready. */
  readonly ready: Promise<void>
  assertReady(): void
  /** Synchronously revoke installation/new work before disposal joins cleanup. */
  retireOwnedLoad(): void
  /** Cleanup only: original read debt, held consumers, then writer flush. */
  closeOwnedLoad(): Promise<void>
  bindForegroundHandoff(taskId: string): () => { kind: 'manual' } | { kind: 'ready' } | { kind: 'parent'; save: import('./persistence.ts').OwnedTaskSave }
  prepareResult(taskId: string, context?: import('@i-harness/core-tools').ToolExec, current?: () => boolean): Promise<TaskResultStore | undefined>
  /** Qualify restored current rows from the original parent's committed F1 facts. */
  qualifyRestoredResults(): Promise<void>
  readResult(taskId: string, args: TaskResultPageArgs): Promise<TaskResultPage>
  submit(input: TaskSubmissionInput): TaskRecord
  get(taskId: string): TaskRecord | undefined
  getByIdentity(identity: TaskIdentity): TaskRecord | undefined
  getByChildSession(childSessionId: string): TaskRecord | undefined
  list(): TaskRecord[]
  notifications(): TaskNotificationRecord[]
  updateNotification(id: string, patch: Partial<Omit<TaskNotificationRecord, "id" | "submissionId">>): boolean
  claim(taskId: string, childSessionId?: string, modelLabel?: string, jobId?: string): boolean
  terminalize(input: TaskTerminalizeInput): boolean
  /** D-01: record or clear a projection-integrity warning without changing the
   * task's status, outcome or result. Returns whether the record changed. */
  annotateProjection(taskId: string, warning: TaskRecord["projectionWarning"] | undefined): boolean
  cancelTree(taskId: string, error?: string): { taskIds: string[]; cancelled: number }
  runningCount(): number
  wait(taskId: string, timeoutMs: number): Promise<TaskRecord | undefined>
  subscribe(taskId: string, listener: (record: Readonly<TaskRecord>) => void): () => void
  restore(doc: TaskProtocolDocument): void
  save(): Promise<void>
  /** Drain already-scheduled saves without creating another document write. */
  flushPersistence(): Promise<void>
  /** Retire failed task-save consumers and flush the original writer so a
   * later spawn is not blocked by durable task debt. */
  recoverPersistence(): Promise<void>
  /** D-08: admission-time drain that reports a document failure instead of
   * failing the caller; job records remain the durable fallback. */
  flushPersistenceBestEffort(): Promise<{ ok: boolean; error?: unknown }>
  /** Retain the existing complete task result before advertising durable retrieval. */
  retainResult(taskId: string): Promise<void>
}
