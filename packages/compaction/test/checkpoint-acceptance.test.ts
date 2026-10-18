import { afterEach, expect, it, vi } from 'vitest'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { summarizeFixture } from './fixtures/summary.ts'
import { checkpointOfLength } from './fixtures/checkpoint.ts'
import { createPreparedPayload, type ModelClient, type PreparedTextOutput } from '@i-harness/llm-seam'
import { ProjectionCounter } from '@i-harness/token-meter'
import { append, createSession } from '@i-harness/core-session'
import { createCompactionHarness } from './fixtures/engine.ts'

afterEach(() => vi.unstubAllGlobals())
it.each([[' ', '## Unknown'], ['  ', '## Unknown'], ['   ', '## Unknown'], [' ', '## Objective'], ['  ', '## Objective'], ['   ', '## Objective']])('refuses indented sections without accepting or publishing (%j, %s)', async (indent, heading) => {
    const text = checkpointOfLength(600).replace('## Important Details', `${indent}${heading}\nUnexpected section.\n## Important Details`)
    let sends = 0
    const accepted: unknown[] = []
    vi.stubGlobal('fetch', async (url: unknown) => {
      expect(String(url)).toBe('https://api.openai.com/v1/chat/completions')
      sends++
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`)
    })
    const model = createOpenAICompatibleClient({ apiKey: 'controlled', model: 'fixture' })
    await expect(summarizeFixture(model, 'recorded input', 1024, undefined, undefined, 500, undefined, undefined, { onPieceAccepted: x => accepted.push(x) })).rejects.toMatchObject({ kind: 'checkpoint-format' })
    expect(sends).toBe(2)
    expect(accepted).toEqual([])
    const session = createSession()
    append(session, { type: 'user/message', text: 'Recorded objective and completed outcome.' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await createCompactionHarness({ model, config: { contextWindow: 100000 }, telemetry: { emit(e) { if (e.type === 'provider/context' && e.data.operation === 'summary-piece-accepted') accepted.push(e.data) }, close() {} } }).compact(session)
      expect(result).toMatchObject({ compacted: false, reason: 'summarizer-failed', blockedReason: 'checkpoint-format' })
      expect(sends).toBe(4)
      expect(accepted).toEqual([])
      expect(session.events.some(e => e.type === 'compaction/summary' || e.type === 'tool/result')).toBe(false)
      expect(warn).toHaveBeenCalledOnce()
    } finally { warn.mockRestore() }
})
it('refuses a length-valid sectionless checkpoint after two quality rounds', async () => {
  let sends = 0
  vi.stubGlobal('fetch', async () => {
    sends++
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(600) } }] })}\n\ndata: [DONE]\n\n`)
  })
  const model = createOpenAICompatibleClient({ apiKey: 'controlled', model: 'fixture' })
  await expect(summarizeFixture(model, 'recorded input', 1024)).rejects.toMatchObject({ kind: 'checkpoint-format' })
  expect(sends).toBe(2)
})
function preparedClient(initialBlocked: boolean, selectedBlocked: boolean, textOutput?: PreparedTextOutput) {
  let sends = 0, selections = 0
  const model: ModelClient = { async *stream() { throw Error('must prepare') }, async prepare(request) {
    return createPreparedPayload({ request, body: { blocked: initialBlocked, cap: 4096 },
      textOutput: b => textOutput ?? (b.blocked ? { status: 'blocked', reason: 'structured-output' } : { status: 'allowed', reason: 'ordinary-text' }),
      describe(b) { const c = new ProjectionCounter('projected-pricing-v2'); c.structured('otherInput', b); return { input: c.finish({ protocol: 'fixture', modelId: 'm' }, b, {}), packet: { sizeKind: 'http-json-body', inlineBinaryBytes: 0, cacheMetadataBytes: 0, signatureBytes: 0 } } },
      output: b => ({ capSupport: 'supported', effectiveCap: b.cap, minimumCap: 1, source: 'request' }),
      cap: (b, cap) => { selections++; return { ...b, blocked: selectedBlocked, cap: cap ?? 4096 } },
      async *execute(_b, _s, _c, execution) { sends++; execution.confirm(); yield { type: 'text/chunk', text: checkpointOfLength(500) }; yield { type: 'end' } },
    })
  } }
  return { model, counts: () => ({ sends, selections }) }
}
it.each([true, false])('uses only the actual selected derivative mode (initial blocked=%s)', async initialBlocked => {
  const f = preparedClient(initialBlocked, !initialBlocked), tracker = { count: 0 }, accepted: unknown[] = []
  const result = summarizeFixture(f.model, 'recorded', 128, undefined, undefined, 500, tracker, undefined, { onPieceAccepted: x => accepted.push(x) })
  if (initialBlocked) { expect(await result).toMatchObject({ text: checkpointOfLength(500), attempts: 1 }); expect(accepted).toHaveLength(1) }
  else { await expect(result).rejects.toMatchObject({ kind: 'output-incompatible' }); expect(accepted).toHaveLength(0) }
  expect(f.counts()).toEqual({ sends: initialBlocked ? 1 : 0, selections: 1 })
  expect(tracker.count).toBe(initialBlocked ? 1 : 0)
})
it.each([undefined, { status: 'allowed', reason: 'future' }, { status: 'allowed', reason: 'ordinary-text', raw: 'private' }])('refuses unknown custom declarations without streaming: %j', async textOutput => {
  let sends = 0
  const raw: ModelClient = { async *stream() { sends++; yield { type: 'end' } } }
  const f = textOutput ? preparedClient(false, false, textOutput as PreparedTextOutput).model : raw
  await expect(summarizeFixture(f, 'recorded', 128)).rejects.toMatchObject({ kind: 'output-unknown' })
  expect(sends).toBe(0)
})
it.each([499, 500, 512, 513])('enforces exact code-unit retained boundaries (%s)', async chars => {
  let sends = 0
  vi.stubGlobal('fetch', async () => { sends++; return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: checkpointOfLength(chars) } }] })}\n\ndata: [DONE]\n\n`) })
  const p = summarizeFixture(createOpenAICompatibleClient({ apiKey: 'controlled', model: 'fixture' }), 'recorded', 128)
  if (chars === 500 || chars === 512) expect((await p).text.length).toBe(chars)
  else await expect(p).rejects.toMatchObject({ kind: 'retention-output' })
  expect(sends).toBe(chars === 500 || chars === 512 ? 1 : 2)
})
it('accepts only the complete second round and keeps the main structured request sendable', async () => {
  let sends = 0
  const accepted: unknown[] = []
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    sends++
    const body = JSON.parse(String(init?.body))
    if (sends === 3) expect(body.response_format).toEqual({ type: 'json_object' })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: sends === 1 ? 'x'.repeat(600) : checkpointOfLength(600) } }] })}\n\ndata: [DONE]\n\n`)
  })
  expect((await summarizeFixture(createOpenAICompatibleClient({ apiKey: 'controlled', model: 'fixture' }), 'recorded', 1024, undefined, undefined, 500, undefined, undefined, { onPieceAccepted: x => accepted.push(x) })).attempts).toBe(2)
  expect(accepted).toHaveLength(1)
  const main = await createOpenAICompatibleClient({ apiKey: 'controlled', model: 'fixture', options: { response_format: { type: 'json_object' } } }).prepare!({ systemPrompt: '', tools: [], messages: [] })
  for await (const _event of main.stream()) { }
  expect(sends).toBe(3)
})
it('does not spend another attempt to conceal usage callback failure', async () => {
  let sends = 0
  const callback = Object.assign(Error('observation failed'), { code: 'CONTEXT_WINDOW_EXCEEDED' })
  vi.stubGlobal('fetch', async () => { sends++; return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(600) } }], usage: { prompt_tokens: 7, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`) })
  const p = summarizeFixture(createOpenAICompatibleClient({ apiKey: 'controlled', model: 'fixture' }), 'recorded', 1024, undefined, undefined, 500, undefined, undefined, { onUsage: () => { throw callback } })
  await expect(p).rejects.toMatchObject({ errors: [callback], cause: callback })
  expect(sends).toBe(1)
})
it.each([{ response_format: { type: 'json_object' } }, { tool_choice: 'required' }])('refuses incompatible final output controls before summary send: %j', async options => {
  let sends = 0
  vi.stubGlobal('fetch', async () => {
    sends++
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(600) } }] })}\n\ndata: [DONE]\n\n`)
  })
  const model = createOpenAICompatibleClient({ apiKey: 'controlled', model: 'fixture', options })
  const tracker = { count: 0 }
  await expect(summarizeFixture(model, 'recorded input', 1024, undefined, undefined, 500, tracker)).rejects.toMatchObject({ kind: 'output-incompatible' })
  expect(sends).toBe(0)
  expect(tracker.count).toBe(0)
})
