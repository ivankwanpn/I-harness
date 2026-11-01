import { types } from 'node:util'
import type { UsageObservationV1 } from './observation-types.js'

type Check = (value: unknown) => boolean
const id: Check = v => typeof v === 'string' && v.length > 0 && v.length <= 256 && !!v.trim()
// Attribution preserves the existing usage text domain; it is not an F4 ID.
const attributionText: Check = v => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !!v.trim()
const integer: Check = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const positive: Check = v => integer(v) && (v as number) > 0
const digest: Check = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const oneOf = (...values: unknown[]): Check => v => values.includes(v)
type Shape = Record<string, Check>
function data(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return false
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && (() => { const d = Object.getOwnPropertyDescriptor(value, key)!; return d.enumerable && 'value' in d && d.value !== undefined })())
}
function fields(value: unknown, required: Shape, optional: Shape = {}): value is Record<string, unknown> {
  if (!data(value)) return false
  return Object.keys(value).every(k => Object.hasOwn(required, k) || Object.hasOwn(optional, k)) &&
    Object.entries(required).every(([k, check]) => Object.hasOwn(value, k) && check(value[k])) &&
    Object.entries(optional).every(([k, check]) => !Object.hasOwn(value, k) || check(value[k]))
}
const origin: Check = v => fields(v, { kind: oneOf('input', 'predecessor', 'command'), seq: integer }) ||
  fields(v, { kind: oneOf('tool', 'code'), seq: integer, parentActionId: id }) ||
  fields(v, { kind: oneOf('delegated-input'), ref: oneOf('admitted'), seq: integer, inputId: id }) ||
  fields(v, { kind: oneOf('delegated-input'), ref: oneOf('inbox'), seq: integer, messageId: id }) ||
  fields(v, { kind: oneOf('observation-input'), seq: integer, inputId: id })
const identity = { ownerSessionId: id, actionId: id }, fact = { ...identity, factSeq: integer }
const candidate = { semanticId: digest, payloadId: digest, payloadKind: oneOf('http-json-body', 'sdk-command-estimate', 'audio-json-body') }
const lane = oneOf('main', 'recovery', 'summary', 'auxiliary')
const attribution = { providerId: attributionText, modelId: attributionText, workspace: attributionText, billing: oneOf('api', 'subscription', 'unknown') }
const counters = { inputTokens: integer, outputTokens: integer, cacheReadTokens: integer, cacheCreationTokens: integer, inputTokenSemantics: oneOf('includes-cache', 'excludes-cache') }
const coverage = { validity: oneOf('valid', 'invalid'), terminalCoverage: oneOf('complete', 'partial', 'unknown') }
function payload(value: unknown, source: unknown): boolean {
  if (!data(value)) return false
  const type = value.type, tag = { type: oneOf(type) }
  if (source === 'journal-fact' || source === 'memory-committed') switch (type) {
    case 'action-open': return fields(value, { ...tag, ...fact, purpose: oneOf('main', 'manual', 'approval', 'title', 'media'), origin, startedAt: integer, expiresAt: positive })
    case 'action-bind': return fields(value, { ...tag, ...fact, executionDomain: oneOf('physical', 'local-test') })
    case 'action-close': return fields(value, { ...tag, ...fact, disposition: oneOf('accepted', 'completed', 'failed', 'stopped', 'expired', 'exhausted') })
    case 'attempt-reserve': return fields(value, { ...tag, ...fact, ...candidate, attemptId: id, ordinal: positive, lane, cause: oneOf('initial', 'retry', 'piece', 'changed-input', 'auxiliary'), incarnation: id })
    case 'attempt-rebind': return fields(value, { ...tag, ...fact, ...candidate, attemptId: id, rebind: v => positive(v) && (v as number) <= 3, incarnation: id })
    case 'attempt-settle': return fields(value, { ...tag, ...fact, attemptId: id, disposition: oneOf('unsent', 'issued', 'unknown', 'completed', 'failed') }, { sendId: id })
    case 'local-invocation': return fields(value, { ...tag, ...fact, localInvocationId: id, ordinal: positive, lane, incarnation: id })
    case 'local-settle': return fields(value, { ...tag, ...fact, localInvocationId: id, disposition: oneOf('unsent', 'completed', 'failed') })
  }
  if (source !== 'live-owner') return false
  if (type === 'handoff') return fields(value, { ...tag, ...identity, ...candidate, attemptId: id, sendId: id, rebind: v => integer(v) && (v as number) <= 3, incarnation: id },{attribution:v=>fields(v,attribution,{projectId:attributionText})})
  const required = type === 'usage-snapshot' ? { ...tag, ...identity, ...attribution, ...coverage, attemptId: id, sendId: id, snapshotOrdinal: positive } : type === 'unattributed-invocation' ? { ...tag, ...attribution, ...coverage } : undefined
  if (!required || !fields(value, required, { ...counters, projectId: attributionText })) return false
  return !(value.inputTokenSemantics === 'includes-cache' && typeof value.inputTokens === 'number' && ((value.cacheReadTokens as number | undefined) ?? 0) + ((value.cacheCreationTokens as number | undefined) ?? 0) > value.inputTokens)
}
/** Fixed recursive lexical field order gives identical bytes regardless of caller insertion order. */
function canonical(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) result[key] = canonical((value as Record<string, unknown>)[key])
  return result
}
export function encodeUsageObservation(value: unknown): string {
  if (!fields(value, { kind: oneOf('usage-observation'), version: oneOf(1), observationId: id, observedAt: integer, source: oneOf('journal-fact', 'memory-committed', 'live-owner'), observation: v => payload(v, (value as Record<string, unknown>).source) })) throw new TypeError('Invalid usage observation')
  return JSON.stringify(canonical(value))
}
export function decodeUsageObservation(bytes: string): UsageObservationV1 {
  const parsed: unknown = JSON.parse(bytes)
  return JSON.parse(encodeUsageObservation(parsed)) as UsageObservationV1
}
