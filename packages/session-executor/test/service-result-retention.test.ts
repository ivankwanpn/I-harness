import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContextOutputService } from '@i-harness/context-output'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { deriveMessages, type ManagedArtifactRef } from '@i-harness/core-session'
import { createSessionService } from '../src/service.ts'
import { controlledModel } from './controlled-model.ts'

it.each(['modelBindingFor', 'modelBuilder'] as const)('publishes mandatory bounded results through the actual %s service assembly route', async route => {
  const root = await mkdtemp(join(tmpdir(), 'service-results-'))
  const backend = createJsonlBackend(join(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create()
  const contextOutput = createContextOutputService({ root: join(root, 'context'), workspaceId: 'service-fixture', config: { enabled: false } })
  // Escaping, multibyte text and metadata all count in the final envelope/model budget.
  const large = { content: '"\\\0🙂'.repeat(20000), code: 'TOOL_FAILED', error: 'ordinary payload data' }, small = { answer: 'small' }
  let sends = 0, bodies = 0
  const observed: unknown[] = []
  const model = controlledModel(async function* (request) {
    observed.push(...request.messages.filter(message => message.role === 'tool'))
    if (++sends <= 2) yield { type: 'tool_call', call: { id: 'original-' + sends, name: sends === 1 ? 'large' : 'small', args: {} } }
    else yield { type: 'text/chunk', text: 'done' }
    yield { type: 'end' }
  })
  const service = createSessionService({ workspace: root, coordinator, contextOutput, modelPolicy: 'required', approveAll: true,
    additionalTools: [
      { name: 'large', description: 'large original', inputSchema: {}, isReadOnly: true, async execute() { bodies++; return large } },
      { name: 'small', description: 'small original', inputSchema: {}, isReadOnly: true, async execute() { bodies++; return small } },
    ],
    ...(route === 'modelBindingFor' ? { modelBindingFor: async () => ({ status: 'ready' as const, binding: { model, providerId: 'fixture', modelId: 'fixture', label: 'fixture' } }) } : { modelBuilder: async () => model }),
  })
  let ref: ManagedArtifactRef | undefined
  try {
    await service.submit(id, 'run both original tools', new AbortController().signal)
    const session = service.liveSession(id)!
    const results = session.events.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(2)
    const [big, little] = results
    expect(big).toMatchObject({ envelope: { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'artifact' } } })
    expect(little).toMatchObject({ envelope: { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', retention: { kind: 'inline', value: small } } })
    for (const result of results) {
      expect(result).not.toHaveProperty('output')
      expect(Buffer.byteLength(JSON.stringify(result.envelope))).toBeLessThanOrEqual(64000)
    }
    for (const message of [...observed, ...deriveMessages(session).filter(message => message.role === 'tool')])
      expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThanOrEqual(64000)
    expect(observed.length).toBeGreaterThanOrEqual(2)
    expect({ bodies, sends }).toEqual({ bodies: 2, sends: 3 })
    await coordinator.flush(id)
    expect((await backend.read(id)).events.filter(event => event.type === 'tool/result')).toEqual(results)
    if (big?.envelope?.retention.kind !== 'artifact') throw new Error('Expected original managed body')
    ref = big.envelope.retention.ref
  } finally { await service.close(); await coordinator.close(); await contextOutput.close() }
  const cold = createContextOutputService({ root: join(root, 'context'), workspaceId: 'service-fixture' })
  try {
    const parts: string[] = []; let offset = 0
    for (;;) {
      const page = await cold.readResult({ sessionId: id }, { ref: ref!, offset })
      if (page.data.kind !== 'text') throw new Error('Expected JSON text page')
      parts.push(page.data.text)
      if (page.eof) break
      expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset!
    }
    expect(JSON.parse(parts.join(''))).toEqual(large)
    expect({ bodies, sends }).toEqual({ bodies: 2, sends: 3 })
  } finally { await cold.close(); await rm(root, { recursive: true, force: true }) }
})

it('keeps an unsupported nondurable owner bounded and truthful without an optional spill setting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'service-unsupported-'))
  let sends = 0, bodies = 0
  const service = createSessionService({ workspace: root, modelPolicy: 'required', approveAll: true,
    modelBuilder: async () => controlledModel(async function* () {
      if (++sends === 1) yield { type: 'tool_call', call: { id: 'original', name: 'large', args: {} } }
      else yield { type: 'text/chunk', text: 'done' }
      yield { type: 'end' }
    }), additionalTools: [{ name: 'large', description: 'large', inputSchema: {}, isReadOnly: true, async execute() { bodies++; return 'x'.repeat(200000) } }],
  })
  try {
    await service.submit('nondurable', 'run original', new AbortController().signal)
    const session = service.liveSession('nondurable')!, result = session.events.find(event => event.type === 'tool/result')
    expect(result).toMatchObject({ envelope: { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'unavailable', reason: 'unsupported-owner' } } })
    expect(result).not.toHaveProperty('output')
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(64000)
    for (const message of deriveMessages(session).filter(message => message.role === 'tool')) expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThanOrEqual(64000)
    expect({ bodies, sends }).toEqual({ bodies: 1, sends: 2 })
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})
