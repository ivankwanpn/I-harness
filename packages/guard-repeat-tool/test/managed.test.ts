import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createSessionCoordinator } from '../../session-persistence/src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { decodeFactBatch } from '@i-harness/core-session'
import { createRepeatToolGuard } from '../src/index.ts'

it('awaits the actual owned repeat-feedback receipt for the exact observed session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-repeat-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id), ctx = createContext()
  ctx.mount(createRepeatToolGuard(ctx, { thresholds: [2], factsFor: view => {
    expect(view).toBe(document.view)
    return { async feedback(event) { const action = document.beginAction(); try { return await action.facts.agent.feedback(event) } finally { action.finish() } } }
  } }))
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), actual = backend.appendOwnedBatch!
  backend.appendOwnedBatch = async (...args) => {
    if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'user/message' && event.source?.kind === 'plugin')) { entered.resolve(); await release.promise }
    return actual(...args)
  }
  try {
    await ctx.emit('agent/post-tool', { name: 'read', args: { path: 'a' }, session: document.view })
    let returned = false
    const emitted = ctx.emit('agent/post-tool', { name: 'read', args: { path: 'a' }, session: document.view }).then(() => { returned = true })
    void emitted.catch(() => {})
    await Promise.race([entered.promise, emitted])
    expect(returned).toBe(false)
    expect(document.view.events).toEqual([])
    release.resolve(); await emitted
    expect((await backend.read(id)).events).toEqual([expect.objectContaining({ type: 'user/message', source: { kind: 'plugin', plugin: 'guard-repeat-tool' }, internal: true })])
  } finally { release.resolve(); await coordinator.close().catch(() => {}); await ctx.scope.unmount() }
})
