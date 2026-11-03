import { validGenerationRetry, type GenerationCandidate, type GenerationRetry } from '@i-harness/core-session'
import type { ExecutionConfirmation } from './execution.ts'
import type { PreparedRequestMeasurement } from '@i-harness/token-meter'

declare const generationBrand: unique symbol
export interface GenerationReservation {
  issue(confirmation: GenerationIssue): void
  settle(disposition: 'unsent' | 'unknown' | 'completed' | 'failed'): Promise<void>
}
export type GenerationIssue = ExecutionConfirmation | { version: 1; sendId: string; semanticId: string; payloadId: string; payloadKind: 'audio-json-body' }
export interface LocalGenerationInvocation {
  issue(): void
  settle(disposition: 'unsent' | 'completed' | 'failed'): Promise<void>
}
export interface GenerationControl {
  readonly [generationBrand]: true
  readonly signal: AbortSignal
  reserve(candidate: GenerationCandidate): Promise<GenerationReservation>
  invokeLocal(identity: object): Promise<LocalGenerationInvocation>
}
const controls = new WeakSet<object>(), errors = new WeakSet<object>()
export function generationError(code: 'GENERATION_UNSUPPORTED' | 'GENERATION_EXHAUSTED' | 'GENERATION_EXPIRED' | 'GENERATION_CLOSED' | 'GENERATION_UNCERTAIN' | 'GENERATION_STALE' | 'GENERATION_CLOCK_INVALID' | 'GENERATION_CONFLICT'): Error {
  const error = Object.assign(new Error(code), { code })
  errors.add(error)
  return error
}
export function isGenerationError(error: unknown): error is Error {
  return error instanceof Error && errors.has(error)
}
/** Only composition owners construct this capability; adapters consume it. */
export function createGenerationControl(options: { signal: AbortSignal; reserve(candidate: GenerationCandidate): Promise<GenerationReservation>; invokeLocal?(identity: object): Promise<LocalGenerationInvocation> }): GenerationControl {
  const control = Object.freeze({ signal: options.signal, reserve: options.reserve, invokeLocal: options.invokeLocal ?? (async () => { throw generationError('GENERATION_UNSUPPORTED') }) }) as GenerationControl
  controls.add(control)
  return control
}
export function isGenerationControl(value: unknown): value is GenerationControl {
  return !!value && typeof value === 'object' && controls.has(value)
}
export function generationCandidate(measurement: PreparedRequestMeasurement): GenerationCandidate {
  const semanticId = measurement.input.semanticIdentity?.semanticId, payload = measurement.payloadIdentity
  if (!semanticId || !payload) throw generationError('GENERATION_UNSUPPORTED')
  return Object.freeze({ semanticId, payloadId: payload.id, payloadKind: payload.kind })
}
export const NO_GENERATION_RETRY: GenerationRetry = Object.freeze({ mode: 'off', maxRetries: 0 })
export function freezeGenerationRetry(value: GenerationRetry): GenerationRetry {
  if (!validGenerationRetry(value)) throw generationError('GENERATION_UNSUPPORTED')
  return Object.freeze({ ...value })
}
