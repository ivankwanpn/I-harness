import type { TaskOutcome, TaskDelivery, RecoveryReason, TaskIdentity, TaskRecord, TaskNotificationRecord, TaskProtocolDocument } from '@i-harness/session-persistence/internal/task-state'
export type { TaskStatus, TaskOutcome, TaskDelivery, RecoveryReason, OutboxStatus, TaskIdentity, TaskSavedObservation, TaskRecord, TaskNotificationRecord, TaskChildBirthBinding, TaskProtocolDocument } from '@i-harness/session-persistence/internal/task-state'
import type { TaskResultStore, TaskResultPageArgs, TaskResultPage } from "./result.ts"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { ReportPolicy } from "../report-policy.ts"
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
