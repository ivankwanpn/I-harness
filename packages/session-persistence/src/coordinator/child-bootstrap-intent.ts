import { types } from 'node:util'
import { canonicalJsonData, freezeJsonData, isStrictFactData, type SeedSourceLabel } from '@i-harness/core-session'
import { bootstrapInitialInputDigest } from '@i-harness/core-session/internal/bootstrap'
import { bootstrapHash } from '../semantic-seed.ts'
import { bootstrapFields, captureBootstrapInvocation, captureBootstrapRequest, initialAdmission, sameBootstrapData, validateCreation } from './bootstrap-header.ts'
import { captureBootstrapProjectIntent } from './bootstrap-intent.ts'
import type { BootstrapCallerMetadata, BootstrapCaptureInspection, BootstrapCaptureReservation, BootstrapInvocation, BootstrapRequest } from './bootstrap-types.ts'
import type { BootstrapProjectIntent } from './bootstrap-intent.ts'
import type { SessionModelSelection } from './types.ts'

export type ChildCaller =
  | { kind: 'task'; taskId: string; parentSessionId: string; callEventSeq?: number; toolCallId?: string }
  | { kind: 'team'; teamId: string; memberId: string }
  | { kind: 'approval-review'; reviewId: string }
export type ChildHistory = { selection: { kind: 'none' } }
  | { selection: { kind: 'all' } | { kind: 'last-turns'; count: number }; source: SeedSourceLabel }
export interface ChildInitialCommitment { inputId: string; digest: string; startedAt: number; expiresAt: number; parentSessionId?: string }
export interface ChildExecutionIntent {
  roleName: string; roleDigest: string; toolNames: readonly string[];
  model: { kind: 'inherit-parent' } | { kind: 'declared'; selection: SessionModelSelection };
  approval: 'ordinary' | 'parent-review'; timeoutMs?: number; maxAttempts?: number;
}
export type ChildLineage =
  | { origin: 'subagent'; subagentProtocolVersion: 1; parentSession?: string; delegationDepth?: number; subagentTaskId?: string; subagentAgentPath?: string }
  | { origin: 'team' | 'approval-review'; parentSession?: string; delegationDepth?: number; subagentTaskId?: string; subagentAgentPath?: string }
export interface ChildBootstrapCore {
  version: 1; kind: 'child-bootstrap-core'; caller: ChildCaller; history: ChildHistory;
  metadata: BootstrapCallerMetadata; lineage: ChildLineage; initial: ChildInitialCommitment; execution: ChildExecutionIntent;
}
export interface ChildBootstrapRequestIntent { version: 1; kind: 'child-bootstrap-intent'; requestCoreDigest: string; project: BootstrapProjectIntent }
export interface ChildBootstrapCaptureRequest {
  version: 1; kind: 'child-bootstrap-capture-request'; invocation: BootstrapInvocation;
  core: ChildBootstrapCore; requestIntent: ChildBootstrapRequestIntent;
}
export interface ChildBootstrapReservation { version: 1; kind: 'semantic-bootstrap-child-capture'; request: ChildBootstrapCaptureRequest }
export type ChildBootstrapCaptureInspection = { kind: 'absent' } | { kind: 'reserved'; reservation: ChildBootstrapReservation }
  | { kind: 'materialized' } | { kind: 'conflict' | 'unavailable' }
// Future internal owners can use these aliases without widening any shipping public reader.
export type OwnedCaptureReservation = BootstrapCaptureReservation | ChildBootstrapReservation
export type OwnedCaptureInspection = BootstrapCaptureInspection | ChildBootstrapCaptureInspection

export const CHILD_BOOTSTRAP_DOMAINS = Object.freeze({
  core: 'ih.bootstrap.child.core.v1', request: 'ih.bootstrap.child.request.v1',
  role: 'ih.bootstrap.child.role.v1', path: 'ih.bootstrap.child.path.v1',
})
export function childRoleDigest(role: unknown): string { return bootstrapHash(CHILD_BOOTSTRAP_DOMAINS.role, captureData(role)) }
const invalid = (): never => { throw new TypeError('Invalid child bootstrap data') }
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const id = (value: unknown): value is string => nonempty(value) && value.length <= 256
const safeId = (value: unknown): value is string => id(value) && !/[\\/\u0000-\u001f\u007f]/.test(value) && !value.includes('..')
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const positive = (value: unknown): value is number => count(value) && value > 0

/** Reject JSON-dropping descriptors throughout the graph before observing any value.
 * isStrictFactData rejects proxies and accessors without executing their traps. */
function captureData(input: unknown): unknown {
  if (!isStrictFactData(input)) invalid()
  const pending = [input]
  while (pending.length) {
    const value = pending.pop()
    if (value === undefined) invalid()
    if (value === null || typeof value !== 'object') continue
    const descriptors = Object.getOwnPropertyDescriptors(value), array = Array.isArray(value)
    if (array && Object.keys(descriptors).length !== value.length + 1) invalid()
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === 'length') continue
      if (!descriptor.enumerable || array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) invalid()
      pending.push(descriptor.value)
    }
  }
  return JSON.parse(canonicalJsonData(input))
}

export function captureChildBootstrapCore(input: unknown): ChildBootstrapCore {
  const c = captureData(input)
  bootstrapFields(c, ['version', 'kind', 'caller', 'history', 'metadata', 'lineage', 'initial', 'execution'])
  if (c.version !== 1 || c.kind !== 'child-bootstrap-core') invalid()
  const { caller, history, lineage, initial, execution } = c
  validateCreation(c.metadata, lineage)
  bootstrapFields(lineage, ['origin'], ['parentSession', 'delegationDepth', 'subagentProtocolVersion', 'subagentTaskId', 'subagentAgentPath'])
  if (!['subagent', 'team', 'approval-review'].includes(lineage.origin)
    || lineage.parentSession !== undefined && !safeId(lineage.parentSession)) invalid()
  if (lineage.origin === 'subagent') bootstrapFields(lineage, ['origin', 'subagentProtocolVersion'], ['parentSession', 'delegationDepth', 'subagentTaskId', 'subagentAgentPath'])
  else bootstrapFields(lineage, ['origin'], ['parentSession', 'delegationDepth'])

  bootstrapFields(caller, ['kind'], ['taskId', 'parentSessionId', 'callEventSeq', 'toolCallId', 'teamId', 'memberId', 'reviewId'])
  if (caller.kind === 'task') {
    bootstrapFields(caller, ['kind', 'taskId', 'parentSessionId'], ['callEventSeq', 'toolCallId'])
    if (!nonempty(caller.taskId) || typeof caller.parentSessionId !== 'string'
      || (caller.parentSessionId === '' ? lineage.parentSession !== undefined : caller.parentSessionId !== lineage.parentSession)
      || caller.callEventSeq !== undefined && !count(caller.callEventSeq)
      || caller.toolCallId !== undefined && typeof caller.toolCallId !== 'string'
      || lineage.origin !== 'subagent') invalid()
  } else if (caller.kind === 'team') {
    bootstrapFields(caller, ['kind', 'teamId', 'memberId'])
    if (!nonempty(caller.teamId) || !nonempty(caller.memberId) || lineage.origin !== 'team') invalid()
  } else if (caller.kind === 'approval-review') {
    bootstrapFields(caller, ['kind', 'reviewId'])
    if (!nonempty(caller.reviewId) || lineage.origin !== 'approval-review') invalid()
  } else invalid()

  bootstrapFields(initial, ['inputId', 'digest', 'startedAt', 'expiresAt'], ['parentSessionId'])
  if (!id(initial.inputId) || !digest(initial.digest) || !count(initial.startedAt) || !count(initial.expiresAt)
    || initial.expiresAt <= initial.startedAt || initial.parentSessionId !== lineage.parentSession) invalid()

  bootstrapFields(history, ['selection'], ['source'])
  bootstrapFields(history.selection, ['kind'], ['count'])
  if (history.selection.kind === 'none') {
    bootstrapFields(history, ['selection']); bootstrapFields(history.selection, ['kind'])
  } else {
    bootstrapFields(history, ['selection', 'source'])
    if (history.selection.kind === 'all') bootstrapFields(history.selection, ['kind'])
    else if (history.selection.kind === 'last-turns') {
      bootstrapFields(history.selection, ['kind', 'count'])
      if (!positive(history.selection.count)) invalid()
    } else invalid()
    bootstrapFields(history.source, ['kind'], ['sessionId'])
    if (history.source.kind === 'session') {
      bootstrapFields(history.source, ['kind', 'sessionId'])
      if (!safeId(history.source.sessionId)) invalid()
    } else if (history.source.kind === 'anonymous') bootstrapFields(history.source, ['kind'])
    else invalid()
    if (lineage.parentSession !== undefined && (history.source.kind !== 'session' || history.source.sessionId !== lineage.parentSession)) invalid()
  }

  bootstrapFields(execution, ['roleName', 'roleDigest', 'toolNames', 'model', 'approval'], ['timeoutMs', 'maxAttempts'])
  if (!nonempty(execution.roleName) || !digest(execution.roleDigest) || !Array.isArray(execution.toolNames) || !execution.toolNames.every(nonempty)
    || execution.approval !== (caller.kind === 'approval-review' ? 'parent-review' : 'ordinary')
    || caller.kind === 'approval-review' && execution.toolNames.length !== 0
    || execution.maxAttempts !== undefined && !positive(execution.maxAttempts)) invalid()
  if (execution.timeoutMs !== undefined && (!positive(execution.timeoutMs) || !Number.isSafeInteger(initial.startedAt + execution.timeoutMs)
    || initial.expiresAt > initial.startedAt + execution.timeoutMs)) invalid()
  bootstrapFields(execution.model, ['kind'], ['selection'])
  if (execution.model.kind === 'inherit-parent') bootstrapFields(execution.model, ['kind'])
  else if (execution.model.kind === 'declared') {
    bootstrapFields(execution.model, ['kind', 'selection'])
    validateCreation({ modelSelection: execution.model.selection }, { origin: 'team' })
    if (c.metadata.modelSelection !== undefined && !sameBootstrapData(c.metadata.modelSelection, execution.model.selection)) invalid()
  } else invalid()
  return freezeJsonData(c) as ChildBootstrapCore
}

export function createChildBootstrapRequestIntent(core: unknown, project: BootstrapProjectIntent): { intent: ChildBootstrapRequestIntent; requestDigest: string } {
  const captured = captureChildBootstrapCore(core), p = captureData(project)
  bootstrapFields(p, ['kind'], ['projectId'])
  const intent: ChildBootstrapRequestIntent = Object.freeze({ version: 1, kind: 'child-bootstrap-intent',
    requestCoreDigest: bootstrapHash(CHILD_BOOTSTRAP_DOMAINS.core, captured), project: captureBootstrapProjectIntent(p as BootstrapProjectIntent) })
  return Object.freeze({ intent, requestDigest: bootstrapHash(CHILD_BOOTSTRAP_DOMAINS.request, intent) })
}

export function captureChildBootstrapCaptureRequest(input: unknown): ChildBootstrapCaptureRequest {
  const r = captureData(input)
  bootstrapFields(r, ['version', 'kind', 'invocation', 'core', 'requestIntent'])
  if (r.version !== 1 || r.kind !== 'child-bootstrap-capture-request') invalid()
  const invocation = captureBootstrapInvocation(r.invocation), core = captureChildBootstrapCore(r.core)
  bootstrapFields(r.requestIntent, ['version', 'kind', 'requestCoreDigest', 'project'])
  const expected = createChildBootstrapRequestIntent(core, r.requestIntent.project)
  if (!sameBootstrapData(r.requestIntent, expected.intent) || invocation.requestDigest !== expected.requestDigest
    || !safeId(invocation.targetSessionId) || invocation.targetSessionId === core.lineage.parentSession
    || 'source' in core.history && core.history.source.kind === 'session' && invocation.targetSessionId === core.history.source.sessionId) invalid()
  return Object.freeze({ version: 1, kind: 'child-bootstrap-capture-request', invocation, core, requestIntent: expected.intent })
}

export function encodeChildBootstrapReservation(value: ChildBootstrapReservation): Uint8Array {
  const r = captureData(value)
  bootstrapFields(r, ['version', 'kind', 'request'])
  if (r.version !== 1 || r.kind !== 'semantic-bootstrap-child-capture') invalid()
  const request = captureChildBootstrapCaptureRequest(r.request)
  const bytes = Buffer.from(canonicalJsonData({ version: 1, kind: 'semantic-bootstrap-child-capture', request }) + '\n')
  if (bytes.length > 262144) invalid()
  return bytes
}

export function parseChildBootstrapReservation(bytes: Uint8Array): ChildBootstrapReservation {
  if (types.isProxy(bytes) || !(bytes instanceof Uint8Array) || bytes.length > 262144) invalid()
  const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as ChildBootstrapReservation
  if (!Buffer.from(encodeChildBootstrapReservation(value)).equals(Buffer.from(bytes))) invalid()
  return freezeJsonData(value) as ChildBootstrapReservation
}

export function childInitialCommitment(request: BootstrapRequest): ChildInitialCommitment {
  const input = captureData(request)
  bootstrapFields(input, ['invocation', 'target', 'metadata', 'lineage', 'seed', 'initial'])
  const captured = captureBootstrapRequest(input as BootstrapRequest), initial = captured.initial!
  const event = initialAdmission(captured)!
  return Object.freeze({ inputId: initial.inputId, digest: bootstrapInitialInputDigest(event, initial.startedAt, initial.expiresAt),
    startedAt: initial.startedAt, expiresAt: initial.expiresAt, ...(initial.parentSessionId === undefined ? {} : { parentSessionId: initial.parentSessionId }) })
}
