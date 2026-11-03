import { afterEach as afterFixture, vi as fixtureVi } from 'vitest'
afterFixture(() => fixtureVi.unstubAllGlobals())
import { createGenerationLifecycle } from "../src/lifecycle/generation-actions.ts"
import { controlledModel } from "./controlled-model.ts"
import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createAgent } from '@i-harness/core-agent'
import { decodeFactBatch, type BatchKey } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createContextOutputService } from '@i-harness/context-output'
import { registerCodeMode } from '@i-harness/code-mode'
import { createSessionService } from '../src/service.ts'
import { installNativeContextOutput } from '../src/context-output.ts'
import { createCodeTextRetention } from '../src/lifecycle/code-text-retention.ts'
import type { CodeModeTextRetention } from '@i-harness/code-mode'

it('retains actual after-next output/ref across a held then rejected grant, blocks optional work and still saves received input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-after-next-grant-'))
  const backend = createJsonlBackend(join(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'actor' }); await coordinator.create({ sessionId: 'parent' })
  const parent = await coordinator.openManagedDocument('parent')
  const output = createContextOutputService({ root: join(root, 'outputs'), workspaceId: 'controlled', config: { enabled: true } })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const raw = 'original after-next body 中文 '.repeat(2000)
  let bodies = 0, captures = 0, grants = 0, sends = 0, finalizers = 0
  const capture = output.capture.bind(output)
  output.capture = async (...args) => { captures++; return capture(...args) }
  output.grant = async (_owner, _refs, destination) => {
    expect(destination).toBe('parent'); grants++; entered.resolve(); await release.promise
    throw new Error('controlled grant outcome unavailable')
  }
  const service = createSessionService({ workspace: root, coordinator, approveAll: true, sandbox: 'danger-full-access',
    model: controlledModel(async function* () {
      sends++; yield { type: 'tool_call', call: { id: 'original', name: 'long_body', args: {} } }; yield { type: 'end' }
    }),
    additionalTools: [{ name: 'long_body', description: '', inputSchema: {}, isReadOnly: true, execute: async () => { bodies++; return raw } }],
  })
  try {
    const assembly = await service.assemblyFor('actor')
    installNativeContextOutput(assembly.ctx, { service: output, session: parent.view, sessionId: 'parent', factOwner: parent })
    assembly.ctx.on('tools/post-execute', () => { finalizers++ })
    const execution = service.submit('actor', 'return the original body', new AbortController().signal)
    void execution.catch(() => {})
    await Promise.race([entered.promise, execution.then(() => { throw new Error('Execution completed before the actual grant barrier') })])
    expect([bodies, captures, grants, sends, finalizers]).toEqual([1, 1, 1, 1, 0])
    expect(assembly.session.events.some(event => event.type === 'tool/result')).toBe(false)
    release.resolve()
    await expect(execution).rejects.toThrow()
    const refs = assembly.session.events.filter(event => event.type === 'context/result-ref')
    expect(refs).toHaveLength(1)
    const page = await output.read({ sessionId: 'actor' }, { refId: refs[0]!.ref.id, offset: 0, maxBytes: 1024 })
    expect(raw.startsWith(page.text)).toBe(true)
    expect(parent.view.events).toEqual([])
    await expect(service.submit('actor', 'later received human input', new AbortController().signal)).rejects.toThrow()
    expect(assembly.inbox.pending().some(input => input.text === 'later received human input')).toBe(true)
    expect(assembly.session.events.some(event => event.type === 'user/message' && event.text === 'later received human input')).toBe(false)
    const count = assembly.session.events.length
    await service.contextState('actor'); await service.contextState('actor')
    expect(assembly.session.events).toHaveLength(count)
    await expect(service.closeSession('actor')).rejects.toThrow()
    await expect(service.closeSession('actor')).rejects.toThrow()
    expect(service.hasAssembly('actor')).toBe(true)
    expect(assembly.session.events.some(event => event.type === 'tool/result')).toBe(false)
    expect([bodies, captures, grants, sends, finalizers]).toEqual([1, 1, 1, 1, 0])
  } finally { release.resolve(); await service.close().catch(() => {}); await coordinator.close().catch(() => {}); await output.close() }
})

it.each(['quota-refused', 'f1-unknown'] as const)('keeps one real emitted window and no implicit parent publication (%s)', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-emitted-grants-'))
  const backend = createJsonlBackend(join(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const actorId = (await coordinator.create()).id, parentId = (await coordinator.create()).id
  const actor = await coordinator.openManagedDocument(actorId), parent = await coordinator.openManagedDocument(parentId)
  const output = createContextOutputService({ root: join(root, 'outputs'), workspaceId: 'controlled', config: { enabled: true } })
  if (mode === 'quota-refused') await output.configure({ maxDiskBytes: 4096 })
  const ctx = createContext(), tools = createToolRegistry(ctx)
  let sends = 0, calls = 0, finalizers = 0, key: BatchKey | undefined
  const actualAppend = backend.appendOwnedBatch!, actualReconcile = backend.reconcileOwnedBatch!
  let blocked = mode === 'f1-unknown'
  if (mode === 'f1-unknown') {
    backend.reconcileOwnedBatch = async (...args) => blocked ? { kind: 'unknown', key: args[3].key } : actualReconcile(...args)
    backend.appendOwnedBatch = async (...args) => {
      const outcome = await actualAppend(...args)
      if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'code/output')) { key = args[3].key; return { kind: 'unknown', key } }
      return outcome
    }
  }
  ctx.on('tools/post-execute', () => { finalizers++ })
  const mount = registerCodeMode(ctx, tools, { session: actor.view, sessionId: actorId, factOwner: actor, config: { mode: 'mixed' },
    retainText: createCodeTextRetention({ service: output, sessionId: actorId }),
  })
  const agent = createAgent(ctx, { generationFactory: action => createGenerationLifecycle(actor.view, actorId, action), session: actor.view, factOwner: actor, tools, sessionId: actorId, systemPrompt: '', model: controlledModel(async function* () {
    if (++sends === 1) { calls++; yield { type: 'tool_call', call: { id: 'original-cell', name: 'code_exec', args: { code: 'text("original retained emitted 中文 ".repeat(2000))', max_output_tokens: 16, yield_time_ms: 5000 } } } }
    else yield { type: 'text/chunk', text: 'done' }
    yield { type: 'end' }
  }) })
  try {
    if (mode === 'f1-unknown') {
      // The unknown receipt must not become a successful exchange; the tool
      // observation is a recovery failure, and the mount reports the same.
      await expect(agent.run('emit the original window')).rejects.toThrow()
      expect(key).toBeDefined()
      // An unknown receipt is not installed as a successful fact.
      expect(actor.view.events.filter(event => event.type === 'code/output')).toEqual([])
      expect(actor.view.events.filter(event => event.type === 'context/result-ref')).toEqual([])
      expect(parent.view.events).toEqual([])
      await expect(mount.dispose()).rejects.toThrow()
      await expect(mount.dispose()).rejects.toThrow()
      blocked = false
      await actor.reconcile(key!)
      await mount.dispose()
      const events = actor.view.events
      expect(events.filter(event => event.type === 'code/output')).toEqual([expect.objectContaining({ envelope: expect.objectContaining({ retention: expect.objectContaining({ kind: 'artifact' }) }) })])
      expect(JSON.stringify(events.filter(event => event.type === 'code/output'))).not.toContain('original retained emitted 中文 '.repeat(2000))
      expect(events.some(event => event.type === 'code/cell' && event.state === 'started')).toBe(true)
      expect(events.filter(event => event.type === 'context/result-ref')).toEqual([])
      expect(parent.view.events).toEqual([])
      expect(calls).toBe(1)
      // No second guest execution ever appears for the same window.
      expect(events.filter(event => event.type === 'code/output')).toHaveLength(1)
      expect(finalizers).toBeLessThanOrEqual(1)
    } else {
      // A known quota refusal is explicit and bounded; the guest still runs once.
      await agent.run('emit the original window')
      expect(actor.view.events.filter(event => event.type === 'code/output')).toEqual([expect.objectContaining({ envelope: expect.objectContaining({ retention: expect.objectContaining({ kind: 'unavailable', reason: 'quota' }) }) })])
      expect(JSON.stringify(actor.view.events.filter(event => event.type === 'code/output'))).not.toContain('original retained emitted 中文 '.repeat(2000))
      expect(actor.view.events.filter(event => event.type === 'context/result-ref')).toEqual([])
      expect(parent.view.events).toEqual([])
      const results = actor.view.events.filter(event => event.type === 'tool/result')
      expect(results).toHaveLength(1)
      const retention = (results[0]!.output as { textRetention: CodeModeTextRetention }).textRetention
      expect(retention).toMatchObject({ stored: false, unavailable: 'quota' })
      expect(Buffer.byteLength(JSON.stringify(results[0]!.output))).toBeLessThanOrEqual(64_000)
      await mount.dispose()
      expect([calls, finalizers]).toEqual([1, 1])
      expect(sends).toBeGreaterThanOrEqual(2)
    }
  } finally { await mount.dispose().catch(() => {}); await coordinator.close().catch(() => {}); await output.close(); await ctx.scope.unmount() }
})
