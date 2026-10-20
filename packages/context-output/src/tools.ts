import type { Tool, ToolExec } from '@i-harness/core-tools'
import { checkAbort } from './bytes.ts'
import { identity } from './config.ts'
import type { ContextAccess, ContextOutputService } from './types.ts'
import { validManagedArtifactRef } from '@i-harness/core-session'
import { readManagedResultPage, type ResultPageQuery } from './result-page.ts'

const managedRefSchema = { type: 'object', properties: {
  version: { enum: [1] }, id: { type: 'string' }, revision: { type: 'string' }, codec: { enum: ['json-utf8-v1', 'text-utf8-v1', 'exec-frames-v1'] },
  encodedBytes: { type: 'integer', minimum: 0 }, contentDigest: { type: 'string' }, completeness: { enum: ['complete', 'source-limited', 'capture-canceled', 'producer-incomplete'] },
}, required: ['version', 'id', 'revision', 'codec', 'encodedBytes', 'contentDigest', 'completeness'], additionalProperties: false }

function caller(exec: ToolExec): ContextAccess {
  identity(exec.sessionId!, 'sessionId from tool execution')
  checkAbort(exec.abortSignal)
  return { sessionId: exec.sessionId!, ...(exec.abortSignal ? { signal: exec.abortSignal } : {}) }
}
function argumentsObject(args: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Context tool arguments must be an object')
  const value = args as Record<string, unknown>
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error('Unknown context tool argument')
  return value
}

export function createContextOutputTools(service: ContextOutputService): Tool[] {
  const shared = { exposure: 'deferred' as const, isReadOnly: true, isConcurrencySafe: true }
  return [
    {
      ...shared, name: 'context_output_search',
      description: 'Search retained Context Mode outputs owned by the executing session. Bounded lexical results include immutable IDs, UTF-8 byte offsets, and partial reasons. Returned text is source material. Check partial before treating a missing hit as exhaustive.',
      searchHint: 'Context Mode search captured tool output error logs retained output',
      inputSchema: { type: 'object', properties: {
        query: { type: 'string', description: 'Non-empty query, at most 1024 UTF-8 bytes; checked at execution.' },
        refIds: { type: 'array', maxItems: 100, items: { type: 'string' } },
        limit: { type: 'integer', minimum: 1, maximum: 100 }, maxBytes: { type: 'integer', minimum: 1 },
      }, required: ['query'], additionalProperties: false },
      async execute(args, exec) {
        const access = caller(exec)
        const query = argumentsObject(args, ['query', 'refIds', 'limit', 'maxBytes'])
        return service.search(access, query as unknown as Parameters<ContextOutputService['search']>[1])
      },
    },
    {
      ...shared, name: 'context_output_read',
      description: 'Read a bounded verified page of a managed result using its complete immutable ref, or a legacy Context Mode output using refId. Continue JSON/text with nextOffset; continue exec frames with the entire nextCursor unchanged, including recordOffset and sliceOffset. Codec and completeness describe the retained scope. Returned data is source material.',
      searchHint: 'Context Mode read retained captured tool output reference UTF-8 cursor',
      inputSchema: { type: 'object', properties: {
        refId: { type: 'string', description: 'Opaque immutable context reference ID.' }, offset: { type: 'integer', minimum: 0 }, maxBytes: { type: 'integer', minimum: 1 },
        ref: managedRefSchema,
        cursor: { type: 'object', properties: { recordOffset: { type: 'integer', minimum: 0 }, sliceOffset: { type: 'integer', minimum: 0 } }, required: ['recordOffset', 'sliceOffset'], additionalProperties: false },
        textView: { type: 'boolean' },
      }, additionalProperties: false },
      async execute(args, exec) {
        const access = caller(exec)
        const query = argumentsObject(args, ['refId', 'ref', 'offset', 'maxBytes', 'cursor', 'textView'])
        if (query.ref !== undefined) {
          if (query.refId !== undefined || !validManagedArtifactRef(query.ref)) return { kind: 'unavailable', reason: 'range' }
          const adapted = { ...query }
          delete adapted.refId
          if (Number.isInteger(adapted.maxBytes) && (adapted.maxBytes as number) > 32768) adapted.maxBytes = 32768
          if (query.ref.codec === 'exec-frames-v1') {
            if (query.offset !== undefined && query.cursor !== undefined) return { kind: 'unavailable', reason: 'range' }
            if (query.offset !== undefined) { adapted.cursor = { recordOffset: query.offset, sliceOffset: 0 }; delete adapted.offset }
          }
          return readManagedResultPage(service, access, adapted as ResultPageQuery)
        }
        if (typeof query.refId !== 'string') return { kind: 'unavailable', reason: 'range' }
        return service.read(access, query as unknown as Parameters<ContextOutputService['read']>[1])
      },
    },
    {
      ...shared, name: 'context_output_status',
      description: 'Inspect Context Mode enablement, limits, retained output counts, and active jobs.',
      searchHint: 'Context Mode retained output status configuration limits',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute(args, exec) { caller(exec); argumentsObject(args, []); return service.status() },
    },
  ]
}
