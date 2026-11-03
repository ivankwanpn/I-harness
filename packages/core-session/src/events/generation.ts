import { isStrictFactData } from '../managed/capture.ts'

/** Durable scalar accounting. These records contain no prompt or credential data. */
export type GenerationPurpose = 'main' | 'manual' | 'approval' | 'title' | 'media'
export type GenerationLane = 'main' | 'recovery' | 'summary' | 'auxiliary'
export type GenerationOrigin = { kind: 'input' | 'predecessor' | 'command'; seq: number }
  | { kind: 'tool' | 'code'; seq: number; parentActionId: string }
  | { kind: 'delegated-input'; ref: 'admitted'; seq: number; inputId: string }
  | { kind: 'delegated-input'; ref: 'inbox'; seq: number; messageId: string }
  | { kind: 'observation-input'; seq: number; inputId: string }
export interface GenerationRetry { mode: 'off' | 'normal' | 'always'; maxRetries: number }
export interface GenerationLimits { total: number; main: number; recovery: number; summary: number }
interface Envelope { version: 1; ownerSessionId: string; actionId: string; trustedAt: number; seq?: number }
export type GenerationActionEvent = Envelope & { type: 'context/action' } & (
  | { op: 'open'; purpose: GenerationPurpose; origin: GenerationOrigin; startedAt: number; expiresAt: number }
  | { op: 'bind'; executionDomain: 'physical' | 'local-test'; retry: GenerationRetry; limits: GenerationLimits }
  | { op: 'constrain'; expiresAt: number; limits?: GenerationLimits }
  | { op: 'phase'; recoverySeq: number }
  | { op: 'close'; disposition: 'accepted' | 'completed' | 'failed' | 'stopped' | 'expired' | 'exhausted' }
  | { op: 'accepted'; executionDomain: 'physical'; attemptId: string; acceptedSeq: number; sendId: string }
  | { op: 'accepted'; executionDomain: 'local-test'; localInvocationId: string; acceptedSeq: number }
  | { op: 'local-invocation'; localInvocationId: string; ordinal: number; lane: GenerationLane; incarnation: string }
  | { op: 'local-settle'; localInvocationId: string; disposition: 'unsent' | 'completed' | 'failed' })
export interface GenerationCandidate { semanticId: string; payloadId: string; payloadKind: 'http-json-body' | 'sdk-command-estimate' | 'audio-json-body' }
export type GenerationAttemptEvent = Envelope & { type: 'context/attempt'; attemptId: string } & (
  | GenerationCandidate & { op: 'reserve'; ordinal: number; lane: GenerationLane; cause: 'initial' | 'retry' | 'piece' | 'changed-input' | 'auxiliary'; incarnation: string }
  | GenerationCandidate & { op: 'rebind'; rebind: number; incarnation: string }
  | { op: 'settle'; disposition: 'unsent' | 'issued' | 'unknown' | 'completed' | 'failed'; sendId?: string })
export type GenerationEvent = GenerationActionEvent | GenerationAttemptEvent

const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const positive = (value: unknown): value is number => integer(value) && value > 0
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const one = (value: unknown) => value === 1
const limits = (value: unknown) => fields(value, { total: positive, main: integer, recovery: integer, summary: integer })
const oneOf = (...allowed: unknown[]) => (value: unknown) => allowed.includes(value)
type Check = (value: unknown) => boolean
function fields(value: unknown, required: Record<string, Check>, optional: Record<string, Check> = {}): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !isStrictFactData(value)) return false
  const data = value as Record<string, unknown>
  return Object.keys(data).every(key => Object.hasOwn(required, key) || Object.hasOwn(optional, key))
    && Object.entries(required).every(([key, check]) => Object.hasOwn(data, key) && check(data[key]))
    && Object.entries(optional).every(([key, check]) => !Object.hasOwn(data, key) || check(data[key]))
}
export function validGenerationRetry(value: unknown): value is GenerationRetry {
  return fields(value, { mode: oneOf('off', 'normal', 'always'), maxRetries: integer })
    && ((value as GenerationRetry).mode !== 'off' || (value as GenerationRetry).maxRetries === 0)
    && Number.isSafeInteger(2 * ((value as GenerationRetry).maxRetries + 1) + 8)
}
export function generationLimits(purpose: GenerationPurpose, retry: GenerationRetry, cap?: number): GenerationLimits {
  if (!validGenerationRetry(retry) || cap !== undefined && !positive(cap)) throw new TypeError('Invalid generation policy')
  const main = purpose === 'main' ? retry.maxRetries + 1 : 0, summary = purpose === 'main' || purpose === 'manual' ? 8 : 0
  const total = purpose === 'main' ? 2 * main + 8 : purpose === 'manual' ? 8 : purpose === 'media' ? 1 : retry.maxRetries + 1
  return Object.freeze({ total: cap === undefined ? total : Math.min(cap, total), main, recovery: main, summary })
}
function origin(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const kind = Object.getOwnPropertyDescriptor(value, 'kind')?.value
  return fields(value, { kind: oneOf('input', 'predecessor', 'command'), seq: integer })
    || (kind === 'tool' || kind === 'code') && fields(value, { kind: oneOf('tool', 'code'), seq: integer, parentActionId: id })
    || kind === 'delegated-input' && (fields(value, { kind: oneOf('delegated-input'), ref: oneOf('admitted'), seq: integer, inputId: id })
      || fields(value, { kind: oneOf('delegated-input'), ref: oneOf('inbox'), seq: integer, messageId: id }))
    || kind === 'observation-input' && fields(value, { kind: oneOf('observation-input'), seq: integer, inputId: id })
}
export function isGenerationEventType(type: unknown): boolean { return type === 'context/action' || type === 'context/attempt' }
export function validGenerationEvent(value: unknown): value is GenerationEvent {
  if (!value || typeof value !== 'object' || !isStrictFactData(value)) return false
  const data = value as Record<string, unknown>
  const envelope = { type: oneOf(data.type), version: one, op: oneOf(data.op), ownerSessionId: id, actionId: id, trustedAt: integer }
  const optional = { seq: integer }, attempt = { ...envelope, attemptId: id }
  const candidate = { semanticId: digest, payloadId: digest, payloadKind: oneOf('http-json-body', 'sdk-command-estimate', 'audio-json-body') }
  if (data.type === 'context/action') switch (data.op) {
    case 'open': return fields(data, { ...envelope, purpose: oneOf('main', 'manual', 'approval', 'title', 'media'), origin, startedAt: integer, expiresAt: positive }, optional)
    case 'bind': return fields(data, { ...envelope, executionDomain: oneOf('physical', 'local-test'), retry: validGenerationRetry, limits }, optional)
    case 'constrain': return fields(data, { ...envelope, expiresAt: positive }, { ...optional, limits })
    case 'phase': return fields(data, { ...envelope, recoverySeq: integer }, optional)
    case 'close': return fields(data, { ...envelope, disposition: oneOf('accepted', 'completed', 'failed', 'stopped', 'expired', 'exhausted') }, optional)
    case 'accepted': return data.executionDomain === 'physical' ? fields(data, { ...envelope, executionDomain: oneOf('physical'), attemptId: id, acceptedSeq: integer, sendId: id }, optional)
      : fields(data, { ...envelope, executionDomain: oneOf('local-test'), localInvocationId: id, acceptedSeq: integer }, optional)
    case 'local-invocation': return fields(data, { ...envelope, localInvocationId: id, ordinal: positive, lane: oneOf('main', 'recovery', 'summary', 'auxiliary'), incarnation: id }, optional)
    case 'local-settle': return fields(data, { ...envelope, localInvocationId: id, disposition: oneOf('unsent', 'completed', 'failed') }, optional)
  }
  if (data.type === 'context/attempt') switch (data.op) {
    case 'reserve': return fields(data, { ...attempt, ...candidate, ordinal: positive, lane: oneOf('main', 'recovery', 'summary', 'auxiliary'), cause: oneOf('initial', 'retry', 'piece', 'changed-input', 'auxiliary'), incarnation: id }, optional)
    case 'rebind': return fields(data, { ...attempt, ...candidate, rebind: v => positive(v) && v <= 3, incarnation: id }, optional)
    case 'settle': return fields(data, { ...attempt, disposition: oneOf('unsent', 'issued', 'unknown', 'completed', 'failed') }, { ...optional, sendId: id })
  }
  return false
}
