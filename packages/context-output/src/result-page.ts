import { validManagedArtifactRef, type ExecFrameCursor, type ManagedArtifactRef } from '@i-harness/core-session'
import type { ContextAccess, ContextOutputService } from './types.ts'
import type { ManagedArtifactPage } from './artifact/types.ts'
import type { ExecFramePage } from './artifact/exec-reader.ts'

export type ResultPageQuery =
  | { ref: ManagedArtifactRef; offset?: number; maxBytes?: number; cursor?: never; textView?: never }
  | { ref: ManagedArtifactRef; cursor?: ExecFrameCursor; maxBytes?: number; textView?: boolean; offset?: never }
export type ResultPageResult = ManagedArtifactPage | ExecFramePage | {
  kind: 'unavailable'; reason: 'not-found' | 'stale' | 'unauthorized' | 'corrupt' | 'range' | 'budget' | 'unavailable'
}

const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
/** Closed transport boundary; it never selects a caller or touches storage. */
export function parseResultPageQuery(input: unknown): ResultPageQuery | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return
  const value = input as Record<string, unknown>
  if (Object.keys(value).some(key => !['ref', 'offset', 'cursor', 'maxBytes', 'textView'].includes(key)) || !validManagedArtifactRef(value.ref)) return
  if (value.maxBytes !== undefined && (!nonnegative(value.maxBytes) || value.maxBytes < 1 || value.maxBytes > 32768)) return
  if (value.ref.codec === 'exec-frames-v1') {
    if ('offset' in value || value.textView !== undefined && typeof value.textView !== 'boolean') return
    if (value.cursor !== undefined) {
      if (!value.cursor || typeof value.cursor !== 'object' || Array.isArray(value.cursor)) return
      const cursor = value.cursor as Record<string, unknown>
      if (Object.keys(cursor).length !== 2 || !Object.keys(cursor).every(key => ['recordOffset', 'sliceOffset'].includes(key)) || !nonnegative(cursor.recordOffset) || !nonnegative(cursor.sliceOffset)) return
    }
  } else if ('cursor' in value || 'textView' in value || value.offset !== undefined && !nonnegative(value.offset)) return
  // Snapshot caller-owned data before an authorization or I/O await.
  return structuredClone(value) as ResultPageQuery
}

export function resultPageFailure(cause: unknown): Extract<ResultPageResult, { kind: 'unavailable' }> {
  const message = cause instanceof Error ? cause.message : ''
  const reason = /unauthorized/.test(message) ? 'unauthorized' : /stale/.test(message) ? 'stale' : /corrupt|short read/.test(message) ? 'corrupt'
    : /budget/.test(message) ? 'budget' : /range|boundary|overflow/.test(message) ? 'range' : (cause as { code?: string } | undefined)?.code === 'ENOENT' ? 'not-found' : 'unavailable'
  return { kind: 'unavailable', reason }
}

export async function readManagedResultPage(service: Pick<ContextOutputService, 'readResult' | 'readExecResult'>, access: ContextAccess, input: ResultPageQuery): Promise<ResultPageResult> {
  const query = parseResultPageQuery(input)
  if (!query) return { kind: 'unavailable', reason: 'range' }
  try { return query.ref.codec === 'exec-frames-v1' ? await service.readExecResult(access, query) : await service.readResult(access, query) }
  catch (cause) { return resultPageFailure(cause) }
}
