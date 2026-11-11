import type { RetainedResultRevision as RetainedTaskResult } from '@i-harness/core-session'
import type { ChildBootstrapCaptureRequest } from '../coordinator/child-bootstrap-intent.ts'

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
export type TaskChildBirthBinding = Readonly<{ version: 1; kind: 'task-child-birth'; request: ChildBootstrapCaptureRequest }>
export interface TaskProtocolDocument { formatVersion: 1 | 2 | 3; tasks: TaskRecord[]; notifications: TaskNotificationRecord[] }
