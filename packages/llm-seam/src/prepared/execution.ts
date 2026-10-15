import { randomUUID } from 'node:crypto'
import type { PreparedRequestMeasurement } from '@i-harness/token-meter'
import type { PreparedStreamControl } from './types.ts'
/** Random process-local continuity labels, never principal or lease evidence. */
export interface LiveExecutionIdentity {
  version: 1; runtimeId: string; bindingLifetimeId: string; authEpoch: string
  scope: 'binding-credential' | 'managed-subscription'; coldCompatible: false
}
export interface ExecutionConfirmation {
  version: 1; sendId: string; semanticId: string; payloadId: string
  payloadKind: 'http-json-body' | 'sdk-command-estimate'; identity?: LiveExecutionIdentity
}
export interface ExecutionReceipt extends ExecutionConfirmation { candidateId: string }
export interface PreparedExecutionContext { confirm(identity?: LiveExecutionIdentity): void }
export function sameExecutionIdentity(a: LiveExecutionIdentity | undefined, b: LiveExecutionIdentity | undefined): boolean {
  return !!a && !!b && a.version === 1 && b.version === 1 && a.runtimeId === b.runtimeId && a.bindingLifetimeId === b.bindingLifetimeId && a.authEpoch === b.authEpoch && a.scope === b.scope && a.coldCompatible === false && b.coldCompatible === false
}
export function validExecutionIdentity(v: unknown): v is LiveExecutionIdentity {
  if (!v || typeof v !== 'object') return false
  const i = v as LiveExecutionIdentity
  return i.version === 1 && i.coldCompatible === false && ['binding-credential', 'managed-subscription'].includes(i.scope) && [i.runtimeId, i.bindingLifetimeId, i.authEpoch].every(s => typeof s === 'string' && s.length > 0 && s.length <= 256)
}
export function preparedExecution(measurement: PreparedRequestMeasurement, control: PreparedStreamControl): PreparedExecutionContext {
  let confirmed = false
  return Object.freeze({ confirm(identity?: LiveExecutionIdentity) {
    if (confirmed) throw new Error('Prepared execution already confirmed')
    confirmed = true
    const semantic = measurement.input.semanticIdentity, payload = measurement.payloadIdentity
    if (semantic && payload) control.confirmExecution?.(Object.freeze({ version: 1, sendId: randomUUID(), semanticId: semantic.semanticId, payloadId: payload.id, payloadKind: payload.kind, ...(validExecutionIdentity(identity) ? { identity: Object.freeze({ ...identity }) } : {}) }))
    control.validateBeforeTransport?.()
  } })
}
