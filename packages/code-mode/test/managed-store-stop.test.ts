import { expect, it, vi } from 'vitest'
import { mkdtemp, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { decodeFactBatch, type BatchKey } from '@i-harness/core-session'
import { createSessionCoordinator } from '../../session-persistence/src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { registerCodeMode } from '../src/register.ts'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

it.each(['before-issue', 'issued-unknown-absent'] as const)('Stop never reissues or installs the original optional store (%s)', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-store-stop-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const ctx = createContext(), tools = createToolRegistry(ctx)
  let bodies = 0, finalizations = 0, attempts = 0, writes = 0, broken = false
  let key: BatchKey | undefined
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const actualAppend = backend.appendOwnedBatch!, native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  tools.register({ name: 'probe', description: '', inputSchema: {}, execute: async () => { bodies++; return 7 } })
  ctx.on('tools/post-execute', () => { finalizations++ })
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await native.open(...args)
    if (!broken || String(args[0]) !== join(root, `${id}.jsonl`) || args[1] !== 'r+') return handle
    return new Proxy(handle, { get(target, name) {
      if (name === 'write') return async (buffer: Uint8Array, offset: number, length: number, position: number) => {
        writes++
        await target.write(buffer, offset, Math.min(9, length), position)
        throw new Error('controlled partial original store write')
      }
      if (name === 'truncate') return async () => { throw new Error('controlled rollback uncertainty') }
      const value = Reflect.get(target, name)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  })
  backend.appendOwnedBatch = async (...args) => {
    if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'code/store')) {
      attempts++; key = args[3].key
      if (mode === 'before-issue') { entered.resolve(); await release.promise }
      else broken = true
    }
    const outcome = await actualAppend(...args)
    if (broken) entered.resolve()
    return outcome
  }
  const mount = registerCodeMode(ctx, tools, { session: document.view, sessionId: id, factOwner: document, config: { mode: 'mixed' } })
  const observing = tools.get('code_exec')!.execute({ code: 'store("original", await tools.probe({})); text("computed once")', yield_time_ms: 5000 }, { session: document.view, sessionId: id })
  void observing.catch(() => {})
  try {
    await entered.promise
    const stopping = mount.cancel('Stop at original store boundary')
    release.resolve()
    if (mode === 'issued-unknown-absent') {
      await expect(observing).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
      broken = false
      expect(await document.reconcile(key!)).toMatchObject({ kind: 'absent', key })
    }
    await stopping
    if (mode === 'before-issue') expect(await observing).toMatchObject({ status: 'terminated' })
    await mount.dispose()
    const events = (await backend.read(id)).events
    expect(events.filter(event => event.type === 'code/store')).toEqual([])
    expect(events.filter(event => event.type === 'code/cell').map(event => event.state)).toEqual(['started', 'terminated'])
    expect([bodies, finalizations, attempts]).toEqual([1, 1, 1])
    expect(writes).toBe(mode === 'before-issue' ? 0 : 1)
  } finally {
    release.resolve(); broken = false; vi.mocked(open).mockImplementation(native.open)
    await mount.dispose().catch(() => {}); await coordinator.close().catch(() => {})
  }
})
