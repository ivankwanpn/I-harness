import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createSessionCoordinator } from '../../session-persistence/src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createGenerationLifecycle } from '../../session-executor/src/lifecycle/generation-actions.ts'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createLoopbackProvider } from './helpers/provider-loopback.ts'
import { createAgentWithSummary } from './fixtures/agent.ts'
import { checkpointOfLength } from '../../compaction/test/fixtures/checkpoint.ts'
import type { SessionRequestContext } from '../src/index.ts'

it('actual held summary retains its original instruction view and cannot publish after observation loss', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-instruction-summary-')), coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }), { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const frame = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`
  const server = await createLoopbackProvider('/v1/chat/completions', [async response => { response.end(frame('earlier response '.repeat(500))) }, async response => { entered.resolve(); await release.promise; response.end(frame(checkpointOfLength(300))) }])
  let held = 0, ready = true, reconciles = 0, succeeded = 0
  const token = Object.freeze({ kind: 'instruction-request' as const, version: 1 as const })
  const requestContext: SessionRequestContext = { async reconcile() { reconciles++ }, capture: () => token, current: value => ready && value === token,
    retain() { held++; let released = false; return { async release() { if (!released) { held--; released = true } } } }, succeeded() { succeeded++; return undefined }, promotedHumanRequest() {}, async close() {} }
  const model = createOpenAICompatibleClient({ model: 'fixture', apiKey: 'owned-loopback', baseUrl: server.baseUrl }), ctx = createContext()
  const agent = createAgentWithSummary(ctx, { session: document.view, factOwner: document, sessionId: id, tools: createToolRegistry(ctx), model, systemPrompt: 's', requestContext, budget: { contextWindow: 100000 }, maxOutputTokens: 1024,
    compact: { contextWindow: 100000, auto: false, retainTokens: 0, summarizationModel: model, summaryLimits: { contextWindow: 100000 }, prune: false },
    generationFactory: (action, dependencies) => createGenerationLifecycle(document.view, id, action, undefined, dependencies),
  })
  let reducing: ReturnType<NonNullable<typeof agent.compact>> | undefined
  try {
    await agent.run('earlier genuine source '.repeat(500)); expect(held).toBe(0); expect(succeeded).toBe(1)
    reducing = agent.compact!(); void reducing.catch(() => {})
    await entered.promise
    expect(held).toBeGreaterThan(0)
    ready = false; release.resolve()
    const result = await reducing
    expect(result.compacted).toBe(false)
    expect(document.view.events.some(event => event.type === 'compaction/replacement' || event.type === 'compaction/prune')).toBe(false)
    expect(server.requests).toHaveLength(2); expect(held).toBe(0); expect(succeeded).toBe(1); expect(reconciles).toBeGreaterThanOrEqual(2)
  } finally { release.resolve(); await reducing?.catch(() => {}); await coordinator.close(); await server.close(); await rm(root, { recursive: true, force: true }) }
}, 15000)
