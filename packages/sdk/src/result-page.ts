import { parseResultPageQuery, type ResultPageQuery, type ResultPageResult } from '@i-harness/session-executor'
import { INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND, makeFailure, makeSuccess } from './protocol.ts'

export type ResultPageHost = (sessionId: string, query: ResultPageQuery) => Promise<ResultPageResult>

export async function dispatchResultPage(id: string | number, params: unknown, read: ResultPageHost | undefined, supportsResultDependencyMembership = false) {
  if (!read) return makeFailure(id, METHOD_NOT_FOUND, 'session/result/read unavailable')
  if (!params || typeof params !== 'object' || Array.isArray(params)) return makeFailure(id, INVALID_PARAMS, 'Invalid result page query')
  const { sessionId, ...input } = params as Record<string, unknown>
  const query = parseResultPageQuery(input)
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 1024 || sessionId.includes('\0') || !query) return makeFailure(id, INVALID_PARAMS, 'Invalid result page query')
  if (query.viaCatalog && !supportsResultDependencyMembership) return makeFailure(id, INVALID_PARAMS, 'Result dependency pages require version 2')
  try { return makeSuccess(id, await read(sessionId, query)) }
  catch { return makeFailure(id, INTERNAL_ERROR, 'session/result/read unavailable') }
}
