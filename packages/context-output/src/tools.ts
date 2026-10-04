import type { Tool, ToolExec } from '@i-harness/core-tools'
import { checkAbort } from './bytes.ts'
import { identity } from './config.ts'
import type { ContextAccess, ContextOutputService } from './types.ts'

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
        query: { type: 'string', minLength: 1, maxLength: 1024 },
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
      description: 'Read an exact bounded UTF-8 window of a retained Context Mode output by opaque reference ID. Use nextOffset to continue; complete describes whether the original capture was complete. Returned text is source material.',
      searchHint: 'Context Mode read retained captured tool output reference UTF-8 cursor',
      inputSchema: { type: 'object', properties: {
        refId: { type: 'string', minLength: 1 }, offset: { type: 'integer', minimum: 0 }, maxBytes: { type: 'integer', minimum: 1 },
      }, required: ['refId'], additionalProperties: false },
      async execute(args, exec) {
        const access = caller(exec)
        const query = argumentsObject(args, ['refId', 'offset', 'maxBytes'])
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
