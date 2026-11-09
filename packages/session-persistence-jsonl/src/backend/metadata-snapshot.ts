import { canonicalJsonData, isStrictFactData, validateSubagentHeader } from '@i-harness/core-session'
import type { SessionMeta } from '@i-harness/session-persistence'

export const selectedImmutableHeaderKeys = ['formatVersion','journal','semanticSeed','seedLength','parentSession','origin','delegationDepth','subagentProtocolVersion','subagentTaskId','subagentAgentPath','sessionId','createdAt'] as const

/** Public metadata edits cannot mint or change a semantic birth reservation.
 * Inspect protected descriptors before the later merge/serializer can read them;
 * the preserved body (including a torn tail) is deliberately not parsed here. */
export function protectedMetadataKeys(previous: SessionMeta): string[] {
  return previous.semanticSeed === undefined ? ['formatVersion','journal','semanticSeed'] : [...selectedImmutableHeaderKeys]
}
function protectedMetadataError(key: string): Error {
  return new Error(key === 'formatVersion' ? 'format changes require durable upgrade; downgrade refused'
    : key === 'journal' ? 'Journal metadata changes require fenced recovery' : 'Protected session metadata changes require a qualified owner')
}
function assertMetadataUpdate(previous: SessionMeta, patch: Partial<SessionMeta>, protectedKeys: readonly string[]): void {
  for (const key of protectedKeys) {
    const field = Object.getOwnPropertyDescriptor(patch, key)
    if (!field) continue
    if (!field.enumerable || !('value' in field) || !isStrictFactData(field.value)) throw new TypeError('Invalid protected session metadata')
    const old = (previous as unknown as Record<string, unknown>)[key], next = field.value
    const equal = Object.is(old, next) || old !== undefined && next !== undefined && canonicalJsonData(old) === canonicalJsonData(next)
    if (!equal) throw protectedMetadataError(key)
  }
}

/** Bind the exact final serialized header to expectations captured before any
 * ordinary getter/toJSON callback. No caller-owned aliases or callbacks remain
 * after the final comparison; the writer uses this line and detached data. */
export function captureMetadataUpdate(previous: SessionMeta, patch: Partial<SessionMeta>, serializeCaptured: (meta: SessionMeta) => string): { line: string; meta: SessionMeta } {
  const keys = protectedMetadataKeys(previous), old = previous as unknown as Record<string, unknown>
  const expected = keys.map(key => ({ key, present: Object.hasOwn(previous, key), encoded: canonicalJsonData(old[key]) }))
  assertMetadataUpdate(previous, patch, keys)
  const line = serializeCaptured({ ...previous, ...patch })
  if (typeof line !== 'string') throw new TypeError('Invalid session metadata snapshot')
  const meta = JSON.parse(line) as SessionMeta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new TypeError('Invalid session metadata snapshot')
  const actual = meta as unknown as Record<string, unknown>
  for (const field of expected) if (Object.hasOwn(meta, field.key) !== field.present || canonicalJsonData(actual[field.key]) !== field.encoded) throw protectedMetadataError(field.key)
  validateSubagentHeader(meta)
  return { line, meta }
}
