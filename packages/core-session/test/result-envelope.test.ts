import { CURRENT_FORMAT_VERSION } from '../src/index.ts'
import { describe, expect, it } from 'vitest'
import { append, createSession, deriveMessages, fromJSONL, stringifyJsonData, toJSONL, type SessionEvent } from '../src/index.ts'

const ready = () => ({ version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media: [], retention: { kind: 'inline', value: { error: 'payload data', code: 'payload data', answer: 42 }, encodedBytes: 58 } })
const event = (envelope: unknown): SessionEvent => ({ type: 'tool/result', callId: 'c', name: 'read', envelope } as unknown as SessionEvent)

describe('closed retained result facts', () => {
  it('projects an envelope inline value and preserves the new fact on cold replay', () => {
    const session = createSession()
    append(session, { type: 'user/message', text: 'read' })
    append(session, { type: 'tool/call', callId: 'c', name: 'read', args: {} })
    append(session, event(ready()))
    const cold = fromJSONL(toJSONL(session))
    expect(deriveMessages(cold).find(message => message.role === 'tool')).toMatchObject({ content: '{"error":"payload data","code":"payload data","answer":42}' })
  })
  it('rejects conflicting raw and envelope alternatives without executing an accessor', () => {
    const session = createSession()
    expect(() => append(session, { ...event(ready()), output: 'raw' } as SessionEvent)).toThrow()
    let reads = 0
    const value = ready()
    Object.defineProperty(value, 'preview', { enumerable: true, get() { reads++; return 'secret' } })
    expect(() => append(session, event(value))).toThrow()
    expect(reads).toBe(0)
  })
  it('validates code output alternatives on actual intake and cold decoding while keeping legacy content', () => {
    const output = { type: 'code/output', cellId: 'original', envelope: ready() } as unknown as SessionEvent
    const session = createSession()
    append(session, output)
    append(session, { type: 'code/output', cellId: 'legacy', content: { type: 'text', text: 'old output' } })
    const raw = toJSONL(session)
    expect(fromJSONL(raw).events).toHaveLength(2)
    expect(() => append(createSession(), { ...output, content: 'duplicate raw' } as SessionEvent)).toThrow()
    expect(() => fromJSONL(raw.replace('"envelope":', '"content":"duplicate raw","envelope":'))).toThrow()
    expect(() => fromJSONL(raw.replace(`"formatVersion":${CURRENT_FORMAT_VERSION}`, '"formatVersion":9'))).toThrow()
    expect(() => fromJSONL(raw.replace(`"formatVersion":${CURRENT_FORMAT_VERSION}`, `"formatVersion":${CURRENT_FORMAT_VERSION+1}`))).toThrow()
    const legacy = createSession()
    append(legacy, { type: 'code/output', cellId: 'legacy', content: { type: 'text', text: 'literal old output' } })
    expect(fromJSONL(toJSONL(legacy).replace(`"formatVersion":${CURRENT_FORMAT_VERSION}`, '"formatVersion":9')).events[0]).toMatchObject({ content: { text: 'literal old output' } })
  })
  it('retains stack-safe native property semantics for a deep accessor result in one traversal', () => {
    let reads = 0
    let value: unknown = Object.defineProperty({}, 'answer', { enumerable: true, get() { reads++; return 42 } })
    for (let index = 0; index < 12000; index++) value = { child: value }
    let encoded: string | undefined
    expect(() => { encoded = stringifyJsonData(value) }).not.toThrow()
    expect(encoded?.endsWith('{"answer":42}' + '}'.repeat(12000))).toBe(true)
    expect(reads).toBe(1)
  })
  it('keeps a closed dependency catalog visible beside an inline primary result', () => {
    const session = createSession(), envelope = { ...ready(), dependencies: { kind: 'artifact-set', count: 1, ref: { version: 1, id: 'ctxv1_' + '1'.repeat(64), revision: '2'.repeat(64), codec: 'json-utf8-v1', encodedBytes: 500, contentDigest: '3'.repeat(64), completeness: 'source-limited' } } }
    append(session, { type: 'tool/call', callId: 'c', name: 'read', args: {} })
    expect(() => append(session, event(envelope))).not.toThrow()
    expect(deriveMessages(session).find(message => message.role === 'tool')?.content).toContain('"dependencies":{"kind":"artifact-set"')
    const invalid = { ...envelope, dependencies: { ...envelope.dependencies, count: 0 } }
    expect(() => append(createSession(), event(invalid))).toThrow()
  })
  it('binds child retained envelopes to a bounded original revision and rejects oversized ordinary previews', () => {
    const child = { type: 'subagent/end', version: 1, taskId: 'task-1', outcome: 'completed', resultRevision: 'original-result', envelope: ready(), resultText: 'preview' } as unknown as SessionEvent
    expect(() => append(createSession(), child)).not.toThrow()
    expect(() => append(createSession(), { ...child, resultRevision: undefined } as SessionEvent)).toThrow()
    expect(() => append(createSession(), { ...child, resultText: 'x'.repeat(2049) } as SessionEvent)).toThrow()
  })
  it('fences current mirrored job result revisions and rejects malformed retained metadata', () => {
    const job = { type: 'job/status', version: 1, job: { jobId: 'job-1', kind: 'subagent', label: 'job', status: 'completed', outputAvailable: true, result: { version: 1, kind: 'pending', revision: 'original' } } } as unknown as SessionEvent
    expect(() => append(createSession(), job)).not.toThrow()
    expect(() => append(createSession(), { ...job, job: { ...(job as any).job, result: { version: 1, kind: 'pending', revision: 'original', body: 'not metadata' } } } as SessionEvent)).toThrow()
  })
})
