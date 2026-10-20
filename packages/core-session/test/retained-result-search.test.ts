import { describe, expect, it } from 'vitest'
import { append, createSession, deriveSearchText, fromJSONL, toJSONL, type ResultEnvelope, type SessionEvent } from '../src/index.ts'

const ref = { version: 1, id: 'ctxv1_' + 'a'.repeat(64), revision: 'b'.repeat(64), codec: 'json-utf8-v1', encodedBytes: 500, contentDigest: 'c'.repeat(64), completeness: 'source-limited' } as const
const media = [{ mediaType: 'image/png', dataBase64: 'aGVsbG8=', name: 'TYPED_MEDIA_SECRET' }] as const
const value = { images: 'ordinary images data', error: 'ordinary error data', ref: 'ordinary ref data', nested: { type: 'image', dataBase64: 'ordinary nested data' } }
const inline: ResultEnvelope = {
  version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media,
  retention: { kind: 'inline', value, encodedBytes: new TextEncoder().encode(JSON.stringify(value)).length },
  dependencies: { kind: 'artifact-set', ref, count: 1 },
}
const artifact: ResultEnvelope = { ...inline, execution: { outcome: 'failed', dispatch: 'dispatched' }, preview: 'RETAINED_VISIBLE_MARKER', retention: { kind: 'artifact', ref } }
const unavailable: ResultEnvelope = { ...inline, preview: 'UNAVAILABLE_VISIBLE_MARKER', retention: { kind: 'unavailable', reason: 'quota', observedEncodedBytes: 1000000 } }

function result(type: 'tool/result' | 'code/result' | 'code/output', envelope: ResultEnvelope): SessionEvent {
  switch (type) {
    case 'tool/result': return { type, callId: 'tool', name: 'read', envelope }
    case 'code/result': return { type, cellId: 'cell', callId: 'code', name: 'read', envelope }
    case 'code/output': return { type, cellId: 'cell', envelope }
  }
}

describe.each(['tool/result', 'code/result', 'code/output'] as const)('retained %s search', type => {
  it.each([
    ['inline', inline, '{"images":"ordinary images data","error":"ordinary error data","ref":"ordinary ref data","nested":{"type":"image","dataBase64":"ordinary nested data"}}'],
    ['artifact', artifact, 'RETAINED_VISIBLE_MARKER'],
    ['unavailable', unavailable, 'UNAVAILABLE_VISIBLE_MARKER'],
  ] as const)('indexes only the %s value or stored preview after cold replay', (_kind, envelope, expected) => {
    const session = createSession()
    append(session, { type: 'tool/call', callId: 'tool', name: 'read', args: {} })
    append(session, { type: 'code/call', cellId: 'cell', callId: 'code', name: 'read', args: {} })
    append(session, result(type, envelope))
    const cold = fromJSONL(toJSONL(session))
    expect(deriveSearchText(cold.events[2]!)).toBe(expected)
  })
})

it.each([['inline', inline], ['artifact', artifact], ['unavailable', unavailable]] as const)('indexes both canonical child fields for %s retention instead of descriptor content', (_kind, envelope) => {
  const session = createSession()
  append(session, { type: 'subagent/end', version: 1, taskId: 'child', outcome: 'completed', resultRevision: 'original', resultText: 'CHILD_RESULT_MARKER', error: 'CHILD_ERROR_MARKER', envelope })
  expect(deriveSearchText(fromJSONL(toJSONL(session)).events[0]!)).toBe('CHILD_RESULT_MARKER\nCHILD_ERROR_MARKER')
})

it.each([
  ['only result', 'CHILD_RESULT_MARKER', undefined, 'CHILD_RESULT_MARKER'],
  ['only error', undefined, 'CHILD_ERROR_MARKER', 'CHILD_ERROR_MARKER'],
  ['neither', undefined, undefined, ''],
  ['empty result', '', 'CHILD_ERROR_MARKER', '\nCHILD_ERROR_MARKER'],
  ['both empty', '', '', '\n'],
] as const)('preserves present/absent child preview fields (%s)', (_case, resultText, error, expected) => {
  const session = createSession()
  append(session, { type: 'subagent/end', version: 1, taskId: 'child', outcome: 'error', resultRevision: 'original', envelope: artifact,
    ...(resultText !== undefined ? { resultText } : {}), ...(error !== undefined ? { error } : {}) })
  expect(deriveSearchText(fromJSONL(toJSONL(session)).events[0]!)).toBe(expected)
})

it('keeps historical raw result filtering and unrelated control event policy', () => {
  const session = createSession()
  append(session, { type: 'tool/result', callId: 'legacy', name: 'read', output: { text: 'legacy text', images: media } })
  append(session, { type: 'code/result', cellId: 'cell', callId: 'legacy', name: 'read', output: { text: 'legacy code', images: media, nested: { type: 'image', data: 'RAW_SECRET' } } })
  append(session, { type: 'code/output', cellId: 'cell', content: { type: 'text', text: 'legacy output' } })
  append(session, { type: 'subagent/end', version: 1, taskId: 'legacy', outcome: 'completed', resultText: 'legacy child', error: 'legacy fallback' })
  append(session, { type: 'job/status', version: 1, job: { jobId: 'j', kind: 'subagent', label: 'job', status: 'completed', outputAvailable: true, result: { version: 1, kind: 'retained', revision: 'original', envelope: artifact } } })
  expect(deriveSearchText(session.events[0]!)).toBe('{"text":"legacy text"}\nimage: TYPED_MEDIA_SECRET ?x? 6B base64:aGVsbG8=')
  expect(deriveSearchText(session.events[1]!)).toBe('{"text":"legacy code"}')
  expect(deriveSearchText(session.events[2]!)).toBe('legacy output')
  expect(deriveSearchText(session.events[3]!)).toBe('legacy child')
  expect(deriveSearchText(session.events[4]!)).toBe('')
})
