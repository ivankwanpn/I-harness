import { randomUUID } from 'node:crypto'
import type { PreparedRequestMeasurement } from '@i-harness/token-meter'
import type { PreparedStreamControl } from './types.ts'
import { assertPreparedValidation } from './rejection.ts'
import type { PreparedValidation } from './validation.ts'
import { generationCandidate, generationError, type GenerationReservation } from './generation.ts'
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
const controlFailures = new WeakSet<object>()
export function isExecutionControlError(error: unknown): boolean { return !!error && typeof error === 'object' && controlFailures.has(error) }
export interface PreparedExecutionContext {
  confirm(identity?: LiveExecutionIdentity): void
  reserve(): Promise<(identity?: LiveExecutionIdentity) => void>
  settle(disposition: 'unknown' | 'completed' | 'failed'): Promise<void>
}
export function sameExecutionIdentity(a: LiveExecutionIdentity | undefined, b: LiveExecutionIdentity | undefined): boolean {
  return !!a && !!b && a.version === 1 && b.version === 1 && a.runtimeId === b.runtimeId && a.bindingLifetimeId === b.bindingLifetimeId && a.authEpoch === b.authEpoch && a.scope === b.scope && a.coldCompatible === false && b.coldCompatible === false
}
export function validExecutionIdentity(v: unknown): v is LiveExecutionIdentity {
  if (!v || typeof v !== 'object') return false
  const i = v as LiveExecutionIdentity
  return i.version === 1 && i.coldCompatible === false && ['binding-credential', 'managed-subscription'].includes(i.scope) && [i.runtimeId, i.bindingLifetimeId, i.authEpoch].every(s => typeof s === 'string' && s.length > 0 && s.length <= 256)
}
export function preparedExecution(measurement: PreparedRequestMeasurement, control: PreparedStreamControl, validation?: PreparedValidation): PreparedExecutionContext {
  let confirmed = false
  let reservation: GenerationReservation | undefined, reserved = false, issued = false, settled = false
  const confirm = (identity?: LiveExecutionIdentity) => {
    try {
    if (confirmed) throw new Error('Prepared execution already confirmed')
    if (control.generation && !reservation) throw generationError('GENERATION_UNSUPPORTED')
    control.signal?.throwIfAborted()
    assertPreparedValidation({ measurement, validation })
    const semantic = measurement.input.semanticIdentity, payload = measurement.payloadIdentity
    const confirmation = semantic && payload ? Object.freeze({ version: 1 as const, sendId: randomUUID(), semanticId: semantic.semanticId, payloadId: payload.id, payloadKind: payload.kind, ...(validExecutionIdentity(identity) ? { identity: Object.freeze({ ...identity }) } : {}) }) : undefined
    if (confirmation) control.confirmExecution?.(confirmation)
    control.validateBeforeTransport?.()
    control.signal?.throwIfAborted()
    if (reservation && confirmation) reservation.issue(confirmation)
    confirmed = true; issued = true
    try { control.onTransportIssue?.() } catch { /* Liveness observers do not change handoff. */ }
    } catch (error) {
      if (error && typeof error === 'object') controlFailures.add(error)
      throw error
    }
  }
  return Object.freeze({ confirm,
    async reserve() {
      if (reserved) throw generationError('GENERATION_STALE')
      reserved = true
      if (control.generation) reservation = await control.generation.reserve(generationCandidate(measurement))
      return confirm
    },
    async settle(disposition: 'unknown' | 'completed' | 'failed') {
      if (!reservation || settled) return
      settled = true
      await reservation.settle(issued ? disposition : 'unsent')
    },
  })
}
