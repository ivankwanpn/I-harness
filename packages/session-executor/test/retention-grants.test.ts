import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createAgent } from '@i-harness/core-agent'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createContextOutputService } from '@i-harness/context-output'
import { registerCodeMode } from '@i-harness/code-mode'
import { createSessionService } from '../src/service.ts'
import { createNativeCodeTextRetention, installNativeContextOutput } from '../src/context-output.ts'

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
    model: { async *stream() {
      sends++; yield { type: 'tool_call', call: { id: 'original', name: 'long_body', args: {} } }; yield { type: 'end' }
    } },
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

it.each(['capture-failed', 'second-grant-failed'] as const)('retains the real emitted window without recapture, regrant or fake failure (%s)', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-emitted-grants-'))
  const backend = createJsonlBackend(join(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const actorId = (await coordinator.create()).id, hostId = (await coordinator.create()).id, parentId = (await coordinator.create()).id
  const actor = await coordinator.openManagedDocument(actorId), parent = await coordinator.openManagedDocument(parentId)
  const output = createContextOutputService({ root: join(root, 'outputs'), workspaceId: 'controlled', config: { enabled: true } })
  const ctx = createContext(), tools = createToolRegistry(ctx)
  const capture = output.capture.bind(output), grant = output.grant.bind(output)
  let captures = 0, sends = 0, finalizers = 0
  const grants: string[] = []
  output.capture = async (...args) => {
    captures++
    if (mode === 'capture-failed') throw new Error('controlled capture has no confirmed ref')
    return capture(...args)
  }
  output.grant = async (...args) => {
    grants.push(args[2])
    if (args[2] === parentId) throw new Error('controlled second grant unknown')
    return grant(...args)
  }
  ctx.on('tools/post-execute', () => { finalizers++ })
  const mount = registerCodeMode(ctx, tools, { session: actor.view, sessionId: actorId, factOwner: actor, config: { mode: 'mixed' },
    retainText: createNativeCodeTextRetention({ service: output, session: actor.view, sessionId: hostId, parent: { sessionId: parentId, session: parent.view, factOwner: parent } }),
  })
  const agent = createAgent(ctx, { session: actor.view, factOwner: actor, tools, sessionId: actorId, systemPrompt: '', model: { async *stream() {
    sends++; yield { type: 'tool_call', call: { id: 'original-cell', name: 'code_exec', args: { code: 'text("original retained emitted 中文 ".repeat(2000))', max_output_tokens: 16, yield_time_ms: 5000 } } }; yield { type: 'end' }
  } } })
  try {
    await expect(agent.run('emit the original window')).rejects.toThrow()
    expect(actor.view.events.filter(event => event.type === 'code/output')).toEqual([expect.objectContaining({ content: { type: 'text', text: 'original retained emitted 中文 '.repeat(2000) } })])
    expect(actor.view.events.filter(event => event.type === 'code/cell').map(event => event.state)).toEqual(['started', 'completed'])
    expect(actor.view.events.filter(event => event.type === 'context/result-ref')).toHaveLength(mode === 'capture-failed' ? 0 : 1)
    expect(parent.view.events).toEqual([])
    await expect(agent.run('new optional work')).rejects.toThrow()
    await mount.cancel('Stop after the actual emitted window')
    await expect(mount.dispose()).rejects.toThrow()
    await expect(mount.dispose()).rejects.toThrow()
    await expect(actor.close()).rejects.toThrow()
    expect(actor.view.events.filter(event => event.type === 'tool/result')).toEqual([])
    expect(grants).toEqual(mode === 'capture-failed' ? [] : [hostId, parentId])
    expect([captures, sends, finalizers]).toEqual([1, 1, 0])
  } finally { await mount.dispose().catch(() => {}); await coordinator.close().catch(() => {}); await output.close(); await ctx.scope.unmount() }
})
