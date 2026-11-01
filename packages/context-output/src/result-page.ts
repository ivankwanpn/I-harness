import { validManagedArtifactRef, type ExecFrameCursor, type CodeOutputCursor, type ManagedArtifactRef } from '@i-harness/core-session'
import type { ContextAccess, ContextOutputService } from './types.ts'
import type { ManagedArtifactPage } from './artifact/types.ts'
import type { ExecFramePage } from './artifact/exec-reader.ts'

export type ResultPageQuery =
  | { ref: ManagedArtifactRef; offset?: number; maxBytes?: number; cursor?: never; textView?: never; viaCatalog?: never }
  | { ref: ManagedArtifactRef; cursor?: ExecFrameCursor; maxBytes?: number; textView?: boolean; offset?: never; viaCatalog?: ManagedArtifactRef }
  | { ref:ManagedArtifactRef;cursor?:CodeOutputCursor;maxBytes?:number;offset?:never;textView?:never;viaCatalog?:never }
export type ResultPageResult = ManagedArtifactPage | ExecFramePage | import('./artifact/code-output-reader.ts').CodeOutputPage | {
  kind: 'unavailable'; reason: 'not-found' | 'stale' | 'unauthorized' | 'corrupt' | 'range' | 'budget' | 'unavailable'
}

const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
/** Closed transport boundary; it never selects a caller or touches storage. */
export function parseResultPageQuery(input: unknown): ResultPageQuery | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return
  const value = input as Record<string, unknown>
  if (Object.keys(value).some(key => !['ref', 'offset', 'cursor', 'maxBytes', 'textView', 'viaCatalog'].includes(key)) || !validManagedArtifactRef(value.ref)) return
  if ('viaCatalog' in value && (!validManagedArtifactRef(value.viaCatalog) || value.viaCatalog.codec !== 'json-utf8-v1' || value.ref.codec !== 'exec-frames-v1' || value.viaCatalog.id === value.ref.id)) return
  if (value.maxBytes !== undefined && (!nonnegative(value.maxBytes) || value.maxBytes < 1 || value.maxBytes > 32768)) return
  if(value.ref.codec==='code-output-manifest-v1') {
    if('offset' in value||'textView' in value||'viaCatalog' in value)return
    if(value.cursor!==undefined) {
      if(!value.cursor||typeof value.cursor!=='object'||Array.isArray(value.cursor))return
      const c=value.cursor as Record<string,unknown>
      if(Object.keys(c).sort().join(',')!=='artifactId,cellId,offset,revision,sourceId'||!nonnegative(c.offset)||!['artifactId','cellId','sourceId','revision'].every(key=>typeof c[key]==='string'&&c[key].length>0&&c[key].length<=1024))return
    }
  } else if (value.ref.codec === 'exec-frames-v1') {
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

export async function readManagedResultPage(service: Pick<ContextOutputService, 'readResult' | 'readExecResult' | 'readCodeOutputResult'>, access: ContextAccess, input: ResultPageQuery): Promise<ResultPageResult> {
  const query = parseResultPageQuery(input)
  if (!query) return { kind: 'unavailable', reason: 'range' }
  try {
    const cursor=query.cursor
    if(query.ref.codec==='code-output-manifest-v1') {
      if(cursor!==undefined&&!('artifactId' in cursor))return {kind:'unavailable',reason:'range'}
      return service.readCodeOutputResult ? await service.readCodeOutputResult(access,{ref:query.ref,cursor,maxBytes:query.maxBytes}) : {kind:'unavailable',reason:'unavailable'}
    }
    if(query.ref.codec==='exec-frames-v1') {
      if(cursor!==undefined&&!('recordOffset' in cursor))return {kind:'unavailable',reason:'range'}
      return await service.readExecResult(access,{ref:query.ref,cursor,maxBytes:query.maxBytes,textView:query.textView,viaCatalog:query.viaCatalog})
    }
    return await service.readResult(access,{ref:query.ref,offset:query.offset,maxBytes:query.maxBytes})
  }
  catch (cause) { return resultPageFailure(cause) }
}
