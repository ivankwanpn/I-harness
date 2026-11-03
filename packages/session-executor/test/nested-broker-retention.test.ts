import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { decodeFactBatch, type BatchKey } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createContextOutputService } from '@i-harness/context-output'
import { createCodeModeBroker } from '../../code-mode/src/broker.ts'
import { installNativeContextOutput } from '../src/context-output.ts'

it.each(['unknown', 'unknown-stop', 'grant-refused', 'grant-refused-stop'] as const)('retains an actual nested broker after-next body and source through %s', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-nested-retention-'))
  const backend = createJsonlBackend(join(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'actor' }); await coordinator.create({ sessionId: 'parent' })
  const actor = await coordinator.openManagedDocument('actor'), parent = await coordinator.openManagedDocument('parent')
  const ctx = createContext(), tools = createToolRegistry(ctx), output = createContextOutputService({ root: join(root, 'outputs'), workspaceId: 'fixture', config: { enabled: true } })
  const refused = mode.startsWith('grant'), destination = refused ? parent : actor
  installNativeContextOutput(ctx, { service: output, session: destination.view, factOwner: destination, sessionId: refused ? 'parent' : 'actor' })
  const raw = 'Original actual nested body 中文 '.repeat(3000)
  let bodies = 0, captures = 0, grants = 0, finalizers = 0, blocked = true, key: BatchKey | undefined
  const capture = output.capture.bind(output), append = backend.appendOwnedBatch!, reconcile = backend.reconcileOwnedBatch!
  output.capture = async (...args) => { captures++; return capture(...args) }
  if (refused) output.grant = async () => { grants++; throw new Error('controlled grant disposition unavailable') }
  backend.appendOwnedBatch = async (...args) => {
    const outcome = await append(...args)
    if (!refused && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'context/result-ref')) { key = args[3].key; return { kind: 'unknown', key } }
    return outcome
  }
  backend.reconcileOwnedBatch = async (...args) => blocked ? { kind: 'unknown', key: args[3].key } : reconcile(...args)
  tools.register({ name: 'long_text', description: '', inputSchema: {}, execute: async () => { bodies++; return raw } })
  ctx.on('tools/post-execute', () => { finalizers++ })
  const controller = new AbortController(), broker = createCodeModeBroker(ctx, tools, { session: actor.view, sessionId: 'actor', factOwner: actor })
  broker.startCell('original-cell')
  try {
    await expect(broker.invoke({ cellId: 'original-cell', invocationId: 'original-call', name: 'long_text', args: {}, origin: { sessionId: 'actor', callId: 'outer' }, signal: controller.signal })).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect([bodies, captures, finalizers]).toEqual([1, 1, 0])
    expect(actor.view.events.filter(event => event.type === 'code/result')).toEqual([])
    if (mode.endsWith('stop')) controller.abort(new Error('Stop after actual nested body'))
    if (refused) {
      await expect(broker.dispose()).rejects.toThrow()
      await expect(broker.dispose()).rejects.toThrow()
      expect(actor.view.events.filter(event => event.type === 'code/result')).toEqual([])
      expect([bodies, captures, grants, finalizers]).toEqual([1, 1, 1, 0])
      expect(parent.view.events.filter(event => event.type === 'context/result-ref')).toEqual([])
    } else {
      blocked = false
      expect((await actor.reconcile(key!)).kind).toBe('committed')
      await broker.dispose()
      await broker.dispose()
      expect(actor.view.events.filter(event => event.type === 'code/result')).toEqual([expect.objectContaining({ callId: 'original-call', output: raw })])
      expect(actor.view.events.filter(event => event.type === 'context/result-ref')).toHaveLength(1)
      expect([bodies, captures, grants, finalizers]).toEqual([1, 1, 0, 1])
    }
  } finally { blocked = false; await broker.dispose().catch(() => {}); await coordinator.close().catch(() => {}); await output.close() }
})
