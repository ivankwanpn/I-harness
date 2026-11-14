import { expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { ModelClient } from '@i-harness/llm-seam'
import type { SuccessfulInstructionHandoff } from '@i-harness/core-agent'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createOpenAIClient } from '../../llm-openai/src/index.ts'
import { createSessionService } from '../src/index.ts'
import { rmWorkspaceSync } from './helpers.ts'

const observed = vi.hoisted(() => ({ handoffs: [] as SuccessfulInstructionHandoff[] }))
vi.mock('../src/context/instructions/manager.ts', async original => {
  const api = await original<typeof import('../src/context/instructions/manager.ts')>()
  return { ...api, createMainInstructionManager(options: Parameters<typeof api.createMainInstructionManager>[0]) {
    const manager = api.createMainInstructionManager(options), succeeded = manager.succeeded.bind(manager)
    manager.succeeded = handoff => { observed.handoffs.push(handoff); return succeeded(handoff) }
    return manager
  } }
})

it.each((['chat', 'responses'] as const).flatMap(route => (['messages', 'non-message'] as const).map(mode => ({ route, mode }))))('actual $route raw $mode precedence preserves representability before consumption', async ({ route, mode }) => {
  observed.handoffs = []
  const root = await mkdtemp(join(tmpdir(), 'ih-instruction-raw-')), a = join(root, 'a'), b = join(root, 'b')
  await mkdir(a); await mkdir(b); await writeFile(join(root, 'AGENTS.md'), 'RAW_REQUIRED_RULE'); await writeFile(join(a, 'AGENTS.md'), 'RAW_PENDING_A'); await writeFile(join(b, 'AGENTS.md'), 'RAW_PENDING_B')
  const bodies: string[] = [], server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk; bodies.push(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(route === 'chat' ? `data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` : `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'done' })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing loopback')
  const config = { apiKey: 'owned-loopback', model: 'fixture', baseUrl: `http://127.0.0.1:${address.port}` }
  const factory = route === 'chat' ? createOpenAICompatibleClient : createOpenAIClient
  const overridden = route === 'chat' ? { messages: [{ role: 'user', content: 'FIXED_RAW_MESSAGES' }] } : { input: [{ role: 'user', content: [{ type: 'input_text', text: 'FIXED_RAW_INPUT' }] }] }
  const adapter = factory({ ...config, options: mode === 'messages' ? overridden : { temperature: 0.125 } })
  const measurements: string[][] = []
  const model: ModelClient = { ...adapter, async prepare(request) { const prepared = await adapter.prepare!(request); measurements.push([...prepared.measurement.input.overriddenInputFields]); return prepared } }
  const service = createSessionService({ workspace: root, model, contextWindow: 100000, codeMode: { mode: 'off' } })
  try {
    const assembly = await service.assemblyFor('raw')
    const list = async (path: string) => {
      const prepared = await assembly.tools.prepare({ name: 'list_dir', args: { path } }, undefined, { session: assembly.session, callId: 'raw-selection' })
      return assembly.tools.dispatch(prepared)
    }
    await list(a)
    const first = await assembly.agent.followup('first raw precedence request').then(() => ({ kind: 'completed' as const }), error => ({ kind: 'failed' as const, error }))
    const firstSends = bodies.length, firstHandoffs = observed.handoffs.length
    await list(b)
    assembly.setModel(factory(config))
    await assembly.agent.followup('normal representable continuation')
    const firstWire = firstSends ? JSON.parse(bodies[0]!) : undefined, handoff = observed.handoffs[0]
    console.log('actual-raw-instruction-consumption', JSON.stringify({ route, mode, first: first.kind, firstError: first.kind === 'failed' ? String(first.error) : undefined, firstSends, firstHandoffs, overriddenInputFields: measurements, firstWire: firstWire && { model: firstWire.model, messages: firstWire.messages, input: firstWire.input, temperature: firstWire.temperature }, handoff: firstHandoffs && handoff ? { acceptedSeq: handoff.acceptedSeq, outcome: handoff.outcome.kind, receipt: handoff.physicalExecutionReceipt } : undefined, nextHasA: bodies.at(-1)!.includes('RAW_PENDING_A'), nextHasB: bodies.at(-1)!.includes('RAW_PENDING_B') }))
    if (mode === 'messages') {
      expect(measurements[0]).toContain('messages')
      expect(first.kind).toBe('failed'); expect(firstSends).toBe(0); expect(firstHandoffs).toBe(0)
      if (first.kind === 'failed') expect(first.error).toMatchObject({ code: 'CONTEXT_CURRENT_UNREPRESENTABLE' })
      expect(bodies.at(-1)).toContain('RAW_PENDING_A'); expect(bodies.at(-1)).toContain('RAW_PENDING_B')
    } else {
      expect(first.kind).toBe('completed'); expect(firstSends).toBe(1); expect(firstHandoffs).toBe(1)
      expect(JSON.parse(bodies[0]!)).toMatchObject({ temperature: 0.125 })
      expect(bodies[0]).toContain('RAW_REQUIRED_RULE'); expect(bodies[0]).toContain('RAW_PENDING_A')
      expect(bodies.at(-1)).not.toContain('RAW_PENDING_A'); expect(bodies.at(-1)).toContain('RAW_PENDING_B')
    }
  } finally { await service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmWorkspaceSync(root) }
})
