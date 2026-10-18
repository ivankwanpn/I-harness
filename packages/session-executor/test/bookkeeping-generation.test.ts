import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createRetryingClient, resolveRetryPolicy, type LiveExecutionIdentity } from '@i-harness/llm-seam'
import { captureRequestCandidate, sameRequestCandidate, type RequestEvidence } from '../../core-agent/src/agent/request-snapshot.ts'
import { createSessionService } from '../src/index.ts'

afterEach(() => vi.unstubAllGlobals())
it('actual durable attempt bookkeeping preserves the captured C3 candidate and the compatible live B2 anchor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-bookkeeping-anchor-')), backend = createJsonlBackend(root)
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create()
  const executionIdentity: LiveExecutionIdentity = Object.freeze({ version: 1, runtimeId: 'fixture-runtime', bindingLifetimeId: 'fixture-binding', authEpoch: 'fixture-epoch', scope: 'binding-credential', coldCompatible: false })
  let sends = 0, captured: RequestEvidence | undefined
  const selected = Object.assign(createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://bookkeeping.fixture.invalid', executionIdentity }), { executionIdentity })
  const model = createRetryingClient(selected, resolveRetryPolicy({ mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }))
  const service = createSessionService({ workspace: root, coordinator, model, contextWindow: 100000, maxOutputTokens: 1000, compact: { auto: false }, codeMode: { mode: 'off' } })
  vi.stubGlobal('fetch', async (url: string) => {
    if (url !== 'https://bookkeeping.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination')
    sends++
    if (sends > 1) {
      const current = captureRequestCandidate(service.liveSession(id)!, id, { model, executionIdentity }, { systemPrompt: '', tools: [] }, 0)
      if (!captured) captured = current
      else {
        expect(sameRequestCandidate(captured, current)).toBe(true)
        const { archive: beforeArchive, ...before } = captured.snapshot.coordinates, { archive: afterArchive, ...after } = current.snapshot.coordinates
        expect(after).toEqual(before)
        expect(afterArchive.eventCount).toBeGreaterThan(beforeArchive.eventCount)
      }
    }
    if (sends === 2) return new Response('synthetic server failure', { status: 503 })
    const usage = sends === 1 ? 'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}}\n\n' : ''
    return new Response('data: {"choices":[{"delta":{"content":"answer"},"finish_reason":null}]}\n\n' + usage + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  })
  try {
    const assembly = await service.assemblyFor(id)
    await assembly.agent.run('establish the live anchor', new AbortController().signal)
    await assembly.agent.run('a transient failure then missing usage', new AbortController().signal)
    expect(sends).toBe(3)
    const events = (await backend.read(id)).events
    const samples = events.filter(event => event.type === 'context/usage' && event.version === 2 && event.op === 'sample')
    expect(samples).toHaveLength(1)
    expect(events.filter(event => event.type === 'context/usage' && event.version === 2 && event.op === 'retire')).toEqual([])
    expect(events.filter(event => event.type === 'model/exchange-accepted').map(event => event.version)).toEqual([2, 2])
    expect(events.filter(event => event.type === 'context/budget').at(-1)).toMatchObject({ snapshot: { estimateSource: 'provider-anchor-plus-projection' } })
    expect(events.filter(event => event.type === 'context/attempt' && event.op === 'reserve')).toHaveLength(3)
    const accepted = events[samples[0]!.checkpoint.accepted.acceptedSeq]
    expect(accepted).toMatchObject({ type: 'model/exchange-accepted', version: 2, request: samples[0]!.checkpoint.request })
  } finally { await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})
