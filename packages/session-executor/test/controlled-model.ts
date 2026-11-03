import { afterEach, vi } from 'vitest'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { observeModelClient, type LLMRequest, type LLMStreamEvent } from '@i-harness/llm-seam'
import { encodedProjectionDigest } from '@i-harness/token-meter'

const handlers = new Map<string, (init: RequestInit) => Promise<Response>>()
let fixtureSerial = 0
afterEach(() => { vi.unstubAllGlobals(); handlers.clear() })
export function restoreControlledTransport() {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const handler = handlers.get(String(url))
    if (!handler) throw new Error('Unexpected network destination: ' + String(url))
    return handler(init)
  })
}

/** Test transport only: the actual built-in Chat terminal reserves/issues and
 * invokes this recording leaf. Arbitrary model callbacks receive no brand. */
export function controlledModel(response: (request: LLMRequest) => AsyncIterable<LLMStreamEvent>, identity: { modelId?: string; providerId?: string; executionIdentity?: import('@i-harness/llm-seam').LiveExecutionIdentity } = {}) {
  const serial = ++fixtureSerial, baseUrl = 'https://executor-model.fixture.invalid/client-' + serial
  const pending = new Map<string, LLMRequest[]>(), endpoint = baseUrl + '/v1/chat/completions'
  let responseOrdinal = 0
  restoreControlledTransport()
  handlers.set(endpoint, async init => {
    const id = encodedProjectionDigest('http-json-body', String(init.body)), entries = pending.get(id), request = entries?.shift()
    if (!request) throw new Error('Unobserved fixture transport candidate')
    const ordinal = ++responseOrdinal
    const { generation: _generation, confirmExecution: _confirm, validateBeforeTransport: _validate, onTransportIssue: _issue, onStreamActivity: _activity, onTerminalResponse: _terminal, ...data } = request
    const iterator = response({ ...data, signal: init.signal ?? undefined, maxOutputTokens: JSON.parse(String(init.body)).max_tokens })[Symbol.asyncIterator]()
    const encoder = new TextEncoder()
    let toolIndex = 0
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        for (;;) {
          const result = await iterator.next()
          if (result.done) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); return }
          const event = result.value
          if (event.type === 'error') throw event.error
          const frame = event.type === 'text/chunk' ? { choices: [{ delta: { content: event.text }, finish_reason: null }] }
            : event.type === 'reasoning' ? { choices: [{ delta: { reasoning_content: event.text }, finish_reason: null }] }
            : event.type === 'tool_call' ? { choices: [{ delta: { tool_calls: [{ index: toolIndex++, id: event.call.id ?? 'fixture-' + serial + '-' + ordinal + '-' + toolIndex, type: 'function', function: { name: event.call.name, arguments: JSON.stringify(event.call.args) } }] }, finish_reason: null }] }
            : event.type === 'usage' ? { choices: [], usage: { prompt_tokens: event.usage.inputTokens, completion_tokens: event.usage.outputTokens } }
            : event.type === 'end' ? { choices: [{ delta: {}, finish_reason: event.truncated ? 'length' : event.refused ? 'content_filter' : 'stop' }] } : undefined
          if (frame) { controller.enqueue(encoder.encode('data: ' + JSON.stringify(frame) + '\n\n')); return }
        }
      },
      async cancel() { await iterator.return?.() },
    }))
  })
  const inner = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: identity.modelId ?? 'fixture', providerId: identity.providerId, executionIdentity: identity.executionIdentity, baseUrl })
  return observeModelClient(inner, { start(request, measurement) {
    const id = measurement.payloadIdentity!.id, entries = pending.get(id) ?? []
    entries.push(request); pending.set(id, entries)
  }, finish() {} })
}
