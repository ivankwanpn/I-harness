import { conversationId, conversationSeq } from './conversation.ts'
import { isStrictFactData } from '../managed/capture.ts'
import { validManagedArtifactRef } from '../results/validate.ts'
import type { ManagedArtifactRef, ResultOutcome, ResultRetention } from '../results/types.ts'

export interface WorkflowDeliverySourceEvent {
  type: 'agent/delivery-source'; version: 1; kind: 'workflow'; sourceNamespace: 'workflow'
  recipientSessionId: string; generationId: string; sourceId: string; callSeq: number; delivery: 'tool' | 'parent'; seq?: number
}
export interface WorkflowDeliveryHandoffEvent { type: 'agent/delivery-handoff'; version: 1; kind: 'workflow'; sourceSeq: number; seq?: number }
export interface WorkflowDeliveryKey { kind: 'workflow'; sourceNamespace: 'workflow'; recipientSessionId: string; sourceId: string; resultRevision: string }
type End = { type: 'workflow/end'; version: 1; sourceSeq: number; invocationId: string; seq?: number }
export type WorkflowTerminalEvent = End & ({ execution: { dispatch: 'dispatched'; outcome: ResultOutcome }; result: Extract<ResultRetention, { kind: 'artifact' | 'unavailable' }> }
  | { execution: { dispatch: 'not-dispatched'; outcome: 'unknown' }; reason: 'launch-refused' }
  | { execution: { dispatch: 'unknown'; outcome: 'unknown' }; reason: 'launch-unknown' })
export type WorkflowDeliveryEvent = WorkflowDeliverySourceEvent | WorkflowDeliveryHandoffEvent | WorkflowTerminalEvent
export interface WorkflowRunResult {
  version: 1; kind: 'workflow-run-result'; invocationId: string
  steps: { step: number; attempt: number; outcome: ResultOutcome; exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }[]
  stdout: string; stderr: string
}
const closed = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key) && Object.getOwnPropertyDescriptor(value, key)?.enumerable && Object.getOwnPropertyDescriptor(value, key)?.value !== undefined)
export function validWorkflowDeliveryEvent(value: unknown): value is WorkflowDeliveryEvent {
  if (!isStrictFactData(value) || !value || typeof value !== 'object') return false
  const e = value as WorkflowDeliveryEvent
  if (e.version !== 1 || e.seq !== undefined && !conversationSeq(e.seq)) return false
  if (e.type === 'agent/delivery-source') return closed(e, ['type','version','kind','sourceNamespace','recipientSessionId','generationId','sourceId','callSeq','delivery','seq'])
    && e.kind === 'workflow' && e.sourceNamespace === 'workflow' && [e.recipientSessionId,e.generationId,e.sourceId].every(conversationId) && conversationSeq(e.callSeq) && ['tool','parent'].includes(e.delivery)
  if (e.type === 'agent/delivery-handoff') return closed(e, ['type','version','kind','sourceSeq','seq']) && e.kind === 'workflow' && conversationSeq(e.sourceSeq)
  if (e.type !== 'workflow/end' || !conversationSeq(e.sourceSeq) || !conversationId(e.invocationId) || !closed(e.execution, ['dispatch','outcome'])) return false
  if (e.execution.dispatch !== 'dispatched') return closed(e, ['type','version','sourceSeq','invocationId','execution','reason','seq'])
    && e.execution.outcome === 'unknown' && 'reason' in e && (e.execution.dispatch === 'not-dispatched' && e.reason === 'launch-refused' || e.execution.dispatch === 'unknown' && e.reason === 'launch-unknown')
  if (!closed(e, ['type','version','sourceSeq','invocationId','execution','result','seq']) || !['succeeded','failed','canceled','unknown'].includes(e.execution.outcome) || !('result' in e)) return false
  const result = e.result
  if (result?.kind === 'artifact') return closed(result, ['kind','ref']) && validManagedArtifactRef(result.ref) && result.ref.codec === 'json-utf8-v1'
  return result?.kind === 'unavailable' && closed(result, ['kind','reason','observedEncodedBytes']) && ['quota','encoding','storage-refused','unsupported-owner','capture-canceled'].includes(result.reason)
    && (result.observedEncodedBytes === undefined || conversationSeq(result.observedEncodedBytes))
}
export function eligibleWorkflowTerminal(event: WorkflowTerminalEvent): boolean {
  return validWorkflowDeliveryEvent(event) && event.execution.dispatch === 'dispatched' && ['succeeded','failed'].includes(event.execution.outcome)
    && 'result' in event && event.result.kind === 'artifact' && ['complete','source-limited'].includes(event.result.ref.completeness)
}
export function workflowTerminalRef(event: WorkflowTerminalEvent): ManagedArtifactRef | undefined { return 'result' in event && event.result.kind === 'artifact' ? event.result.ref : undefined }
export function validWorkflowRunResult(value: unknown): value is WorkflowRunResult {
  if (!isStrictFactData(value) || !closed(value, ['version','kind','invocationId','steps','stdout','stderr']) || value.version !== 1 || value.kind !== 'workflow-run-result'
    || !conversationId(value.invocationId) || typeof value.stdout !== 'string' || typeof value.stderr !== 'string' || !Array.isArray(value.steps)
    || Reflect.ownKeys(value.steps).length !== value.steps.length + 1 || Object.keys(value.steps).length !== value.steps.length) return false
  let step = -1, attempt = 0
  for (const item of value.steps) {
    if (!closed(item, ['step','attempt','outcome','exitCode','timedOut','stdout','stderr']) || !conversationSeq(item.step) || !Number.isSafeInteger(item.attempt) || (item.attempt as number) < 1
      || !['succeeded','failed','canceled','unknown'].includes(item.outcome as string) || item.exitCode !== null && !Number.isSafeInteger(item.exitCode)
      || typeof item.timedOut !== 'boolean' || typeof item.stdout !== 'string' || typeof item.stderr !== 'string') return false
    if ((item.step as number) < step || item.step === step && (item.attempt as number) <= attempt) return false
    attempt = item.attempt as number; step = item.step as number
  }
  return true
}
