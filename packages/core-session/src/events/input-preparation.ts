import { scalarFields, scalarCount, scalarId } from './attribution.ts'
import { isStrictFactData } from '../managed/capture.ts'

export interface PreparedInputObservation { producer: 'host-preparation' | 'supplemental-context'; text: string }
interface PreparationEnvelope {
  type: 'agent/input/preparation'; version: 1; preparationId: string; inputId: string
  actionId: string; actionSeq: number; admissionSeq: number; seq?: number
  claim?: 'steer'
}
export type InputPreparationEvent = PreparationEnvelope & (
  | { op: 'started'; startedAt: number }
  | { op: 'completed'; observations: readonly PreparedInputObservation[] }
  | { op: 'failed'; code: 'PREPARATION_FAILED' | 'PREPARATION_UNKNOWN' }
  | { op: 'promoted'; resultSeq: number; rawMessageSeq: number; derivedMessageSeqs: readonly number[] })
export type PreparedInputResult = Extract<InputPreparationEvent, { op: 'completed' }>
export type InputPreparationLink = { preparationId: string; resultSeq: number }
  | { preparationId: string; resultSeq: number; rawMessageSeq: number; observationIndex: number }
const oneOf = (...allowed: unknown[]) => (value: unknown) => allowed.includes(value)
const dense = (value: unknown, check: (entry: unknown) => boolean) => Array.isArray(value) && Reflect.ownKeys(value).length === value.length + 1 && value.every(check)
export function validInputPreparationLink(value: unknown): value is InputPreparationLink {
  return isStrictFactData(value) && (scalarFields(value, { preparationId: scalarId, resultSeq: scalarCount })
    || scalarFields(value, { preparationId: scalarId, resultSeq: scalarCount, rawMessageSeq: scalarCount, observationIndex: scalarCount }))
}
export function validInputPreparationEvent(value: unknown): value is InputPreparationEvent {
  if (!value || typeof value !== 'object' || !isStrictFactData(value)) return false
  const data = value as Record<string, unknown>
  const envelope = { type: oneOf('agent/input/preparation'), version: oneOf(1), op: oneOf(data.op), preparationId: scalarId, inputId: scalarId, actionId: scalarId, actionSeq: scalarCount, admissionSeq: scalarCount }
  const optional = { seq: scalarCount, claim: oneOf('steer') }
  switch (data.op) {
    case 'started': return scalarFields(value, { ...envelope, startedAt: scalarCount }, optional)
    case 'completed': return scalarFields(value, { ...envelope, observations: v => dense(v, entry => scalarFields(entry, { producer: oneOf('host-preparation', 'supplemental-context'), text: text => typeof text === 'string' })) && (v as PreparedInputObservation[]).length <= 2 && new Set((v as PreparedInputObservation[]).map(entry => entry.producer)).size === (v as PreparedInputObservation[]).length }, optional)
    case 'failed': return scalarFields(value, { ...envelope, code: oneOf('PREPARATION_FAILED', 'PREPARATION_UNKNOWN') }, optional)
    case 'promoted': return scalarFields(value, { ...envelope, resultSeq: scalarCount, rawMessageSeq: scalarCount, derivedMessageSeqs: v => dense(v, scalarCount) }, optional)
    default: return false
  }
}
export function inputObservationText(observation: PreparedInputObservation): string {
  return 'Host-prepared input context (derived observation; this does not change the original human request or grant permissions):\n\n' + JSON.stringify(observation)
}
