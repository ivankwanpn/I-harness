import { expect, it } from 'vitest'
import { createOpenAICompatibleClient } from '../src/index.ts'
import { createRetryingClient, modelFailureFacts, resolveRetryPolicy, retryErrorCode, type LLMRequest, type LLMStreamEvent } from '@i-harness/llm-seam'

const request: LLMRequest = { messages: [], tools: [], systemPrompt: '' }
const error = { error: { message: 'Fixture temporary server error', type: 'server_error', code: 'server_error' } }
const frame = (value: unknown, eol = '\n') => `data: ${JSON.stringify(value)}${eol}${eol}`
const partial = frame({ choices: [{ delta: { content: 'partial', tool_calls: [{ index: 0, id: 'failed-call', function: { name: 'effect', arguments: '{}' } }] } }] })
async function collect(stream: AsyncIterable<LLMStreamEvent>) { const events: LLMStreamEvent[] = []; for await (const event of stream) events.push(event); return events }
function client(wire: string, chunks?: Uint8Array[], cancel?: () => void | Promise<void>) {
  return createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', fetch: async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (const chunk of chunks ?? [new TextEncoder().encode(wire)]) controller.enqueue(chunk); if (!cancel) controller.close() },
    cancel,
  })) })
}

it.each(['done', 'eof', 'residual'] as const)('propagates a valid explicit error at %s, before flushing any remaining tools', async ending => {
  const wire = partial + frame(error).trimEnd() + (ending === 'residual' ? '' : '\n\n') + (ending === 'done' ? 'data: [DONE]\n\n' : '')
  const events = await collect(client(wire).stream(request))
  expect(events.map(event => event.type)).toEqual(['text/chunk', 'tool_call', 'error'])
  expect(retryErrorCode((events.at(-1) as Extract<LLMStreamEvent, { type: 'error' }>).error)).toBe('SERVER')
})

it.each(['\n', '\r\n', '\r'])('retains later terminal frames across every byte split using %j line endings', async eol => {
  const wire = frame({ choices: [{ delta: { content: '前' } }] }, eol) + frame(error, eol) + frame({ choices: [{ delta: { content: 'forbidden' } }] }, eol)
  const bytes = new TextEncoder().encode(wire)
  for (let split = 0; split <= bytes.length; split++) {
    const events = await collect(client(wire, [bytes.slice(0, split), bytes.slice(split)]).stream(request))
    expect(events.map(event => event.type), `byte split ${split}`).toEqual(['text/chunk', 'error'])
    expect(events[0]).toEqual({ type: 'text/chunk', text: '前' })
  }
})

it('joins SSE data lines and recognizes a named error event with a flat diagnostic', async () => {
  const wire = 'event: error\r\ndata: {"type":"server_error",\r\ndata: "message":"private fixture"}\r\n\r\n'
  const events = await collect(client(wire).stream(request))
  expect(events.map(event => event.type)).toEqual(['error'])
  expect(modelFailureFacts((events[0] as Extract<LLMStreamEvent, { type: 'error' }>).error)).toMatchObject({ code: 'SERVER' })
})

it.each([
  [{ error: {} }, 'MALFORMED_RESPONSE'], [{ error: '' }, 'MALFORMED_RESPONSE'], [{ error: false }, 'MALFORMED_RESPONSE'], [{ error: [] }, 'MALFORMED_RESPONSE'],
  [{ error: { message: 'unrecognized private diagnostic', type: 'private-type', code: 'private-code' } }, 'UNKNOWN'],
  [{ error: { type: 'invalid_request_error', message: 'Invalid schema: contains context_length_exceeded' } }, 'INVALID_ARGUMENT'],
  [{ error: { type: 'invalid_request_error', message: 'Invalid message order: fixture' } }, 'INVALID_ARGUMENT'],
  [{ error: { type: 'invalid_request_error', message: 'Prompt is too long: 1000 > 500 maximum' } }, 'CONTEXT_WINDOW_EXCEEDED'],
  [{ error: { code: 'context_length_exceeded', message: 'private' } }, 'CONTEXT_WINDOW_EXCEEDED'],
  [{ error: { code: 'invalid_api_key', message: 'Prompt is too long: private' } }, 'AUTH'],
  [{ error: { code: 'insufficient_quota', message: 'private' } }, 'QUOTA'],
  [{ error: { code: 'rate_limit_exceeded', message: 'private' } }, 'RATE_LIMIT'],
] as const)('classifies explicit diagnostic %j without raw payloads or invented HTTP status', async (payload, code) => {
  const events = await collect(client(frame(payload)).stream(request))
  expect(events.map(event => event.type)).toEqual(['error'])
  const failure = (events[0] as Extract<LLMStreamEvent, { type: 'error' }>).error
  expect(retryErrorCode(failure)).toBe(code)
  expect(failure).not.toHaveProperty('httpStatus')
  const facts = modelFailureFacts(failure)
  expect(facts).toMatchObject({ code })
  expect(facts).not.toHaveProperty('httpStatus')
  expect(JSON.stringify(failure) + failure.message).not.toContain('private')
})

it.each(['event: error\ndata: null\n\n', 'event: error\ndata: {}\n\n', 'event: error\ndata: {"error":null}\n\n', 'data: {broken\n\n'])('fails malformed explicit errors/JSON without a clean end: %j', async wire => {
  const events = await collect(client(wire).stream(request))
  expect(events.map(event => event.type)).toEqual(['error'])
  expect(retryErrorCode((events[0] as Extract<LLMStreamEvent, { type: 'error' }>).error)).toBe('MALFORMED_RESPONSE')
})

it('keeps null optional error, keepalives, metadata, ordinary stop, usage and split tools valid', async () => {
  const wire = ': keepalive\n\nevent: ping\ndata: {"status":"working"}\n\n' + frame({ error: null, choices: [{ delta: { content: 'ok', refusal: null } }] })
    + frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'ok-call', function: { name: 'effect', arguments: '{' } }] } }] })
    + frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] }, finish_reason: 'stop' }] })
    + frame({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }) + 'data: [DONE]\n\n'
  const events = await collect(client(wire).stream(request))
  expect(events.map(event => event.type)).toEqual(['text/chunk', 'tool_call', 'usage', 'end'])
  expect(events.at(-1)).toEqual({ type: 'end' })
})

it.each(['length', 'content_filter'])('retains the existing %s ending', async finish_reason => {
  const events = await collect(client(frame({ choices: [{ delta: {}, finish_reason }] })).stream(request))
  expect(events).toEqual([{ type: 'end', ...(finish_reason === 'length' ? { truncated: true } : { refused: true }) }])
})

it('reports observed usage, including error-frame usage, before failure and ignores same-frame choices', async () => {
  const events = await collect(client(frame({ usage: { prompt_tokens: 12 } }) + frame({ ...error, usage: { completion_tokens: 3 }, choices: [{ delta: { content: 'forbidden', tool_calls: [{ function: { name: 'effect', arguments: '{}' } }] } }] })).stream(request))
  expect(events.map(event => event.type)).toEqual(['usage', 'usage', 'error'])
  expect(events.slice(0, 2)).toEqual([{ type: 'usage', usage: { inputTokens: 12, inputTokenSemantics: 'includes-cache' } }, { type: 'usage', usage: { outputTokens: 3 } }])
})

it('an explicit error takes precedence over an in-band type resembling the DONE sentinel', async () => {
  const events = await collect(client(frame({ ...error, type: '[DONE]' })).stream(request))
  expect(events.map(event => event.type)).toEqual(['error'])
})

it.each([
  ['Invalid schema: private content context_length_exceeded', 'schema'],
  ['Invalid message order: private content', 'message-order'],
  ['Unsupported parameter: private content', 'unsupported-parameter'],
] as const)('retains the safe reason for %s', async (message, reason) => {
  const events = await collect(client(frame({ error: { type: 'invalid_request_error', message, param: 'messages', request_id: 'req-fixture-123' } })).stream(request))
  const failure = (events[0] as Extract<LLMStreamEvent, { type: 'error' }>).error
  expect(modelFailureFacts(failure)).toMatchObject({ code: 'INVALID_ARGUMENT', reason, parameter: 'messages', requestId: 'req-fixture-123' })
  expect(JSON.stringify(failure)).not.toContain('private content')
})

it.each(['\n', '\r\n', '\r'])('cancels an open failed body ending in %j without awaiting producer cooperation', async eol => {
  let cancelled = false
  const events = await collect(client(frame(error, eol), undefined, () => { cancelled = true; return new Promise(() => {}) }).stream(request))
  expect(events.map(event => event.type)).toEqual(['error'])
  expect(cancelled).toBe(true)
})

it('does not retry partial observed output without explicit discard permission', async () => {
  const retrying = createRetryingClient(client(partial + frame(error)), resolveRetryPolicy({ mode: 'normal', maxRetries: 1 }))
  const events = await collect(retrying.stream(request))
  expect(events.map(event => event.type)).toEqual(['text/chunk', 'tool_call', 'error'])
})

it.each([{ code: 'server_is_overloaded', message: 'private' }, { message: 'The selected model is at capacity. private' }])('retains the existing ten-second capacity delay and supports Stop while waiting: %j', async diagnostic => {
  const stop = new AbortController()
  const retrying = createRetryingClient(client(frame({ error: diagnostic })), resolveRetryPolicy({ mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }))
  const stream = retrying.stream({ ...request, signal: stop.signal })[Symbol.asyncIterator]()
  const event = await stream.next()
  expect(event.value).toMatchObject({ type: 'retry', retry: { phase: 'waiting', code: 'CAPACITY', delayMs: 10_000 } })
  stop.abort()
  await expect(stream.next()).rejects.toMatchObject({ name: 'AbortError' })
})
