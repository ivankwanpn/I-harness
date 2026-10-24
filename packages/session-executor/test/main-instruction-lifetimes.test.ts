import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstructionService } from '../../instructions/src/service.ts'
import { createMainInstructionManager } from '../src/context/instructions/manager.ts'
import { rmWorkspaceSync } from './helpers.ts'

it('the original pinned IA lease can retry its failed close without reopening the retired view', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-pin-'))
  await writeFile(join(root, 'AGENTS.md'), 'ORIGINAL_PINNED_TEXT')
  const child = join(root, 'child'); await mkdir(child); await writeFile(join(child, 'AGENTS.md'), 'CHILD_TEXT')
  const originalServices: ReturnType<typeof createInstructionService>[] = []
  const closed: number[] = []
  let failOriginal = true
  const manager = createMainInstructionManager({ cwd: root, authority: () => ({ kind: 'unbound', revision: 'root', workspaceRoot: root }), available: () => true, publish: async () => {},
    environment: { policy: { current: () => ({ kind: 'ready', generation: '1', policy: { enabled: true, maxBytes: 24000, globalSources: [] } }), ready: async () => {}, subscribe: () => () => {} },
      host: { create(scope) {
        const ordinal = originalServices.length
        const service = createInstructionService({ scope, observation: { subscribe() { return {
          async update() { return { revision: 1, available: true, pending: [] } },
          async close() { closed.push(ordinal); if (ordinal === 0 && failOriginal) { failOriginal = false; throw new Error('original lease close fault') } },
        } } } }); originalServices.push(service); return service
      }, close: async () => {} }, dispose() {}, close: async () => {} },
  })
  try {
    await manager.reconcile()
    const evidence = manager.capture()!, pin = manager.retain(evidence)
    expect(manager.current({ ...evidence })).toBe(false)
    expect(await manager.observe({ path: child, kind: 'directory' })).toEqual({ status: 'queued' })
    await manager.reconcile()
    expect(manager.current(evidence)).toBe(true)
    expect(closed).toEqual([])
    await expect(pin.release()).rejects.toThrow('original lease close fault')
    expect(manager.current(evidence)).toBe(false)
    await expect(originalServices[0]!.prepare([])).rejects.toMatchObject({ code: 'INSTRUCTIONS_CLOSED' })
    await expect(pin.release()).resolves.toBeUndefined()
    expect(closed).toEqual([0, 0])
    await pin.release()
    expect(closed).toEqual([0, 0])
  } finally { await manager.close(); rmWorkspaceSync(root) }
})

it('a replacement close failure fences the manager until that same original lease is retried', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-retirement-')), child = join(root, 'child')
  await writeFile(join(root, 'AGENTS.md'), 'ROOT_TEXT'); await mkdir(child); await writeFile(join(child, 'AGENTS.md'), 'CHILD_TEXT')
  let ordinal = 0, attempts = 0, allowClose = false
  const manager = createMainInstructionManager({ cwd: root, authority: () => ({ kind: 'unbound', revision: 'root', workspaceRoot: root }), available: () => true, publish: async () => {},
    environment: { policy: { current: () => ({ kind: 'ready', generation: '1', policy: { enabled: true, maxBytes: 24000, globalSources: [] } }), ready: async () => {}, subscribe: () => () => {} },
      host: { create(scope) { const index = ordinal++; return createInstructionService({ scope, observation: { subscribe() { return { async update() { return { revision: 1, available: true, pending: [] } }, async close() { if (index === 0) { attempts++; if (!allowClose) throw Error('retired original cleanup held') } } } } } }) }, close: async () => {} }, dispose() {}, close: async () => {} },
  })
  try {
    await manager.reconcile(); await manager.observe({ path: child, kind: 'directory' })
    await expect(manager.reconcile()).rejects.toThrow('retired original cleanup held')
    expect(manager.current(manager.capture())).toBe(false)
    await expect(manager.reconcile()).rejects.toThrow('retired original cleanup held')
    expect(attempts).toBe(2)
    allowClose = true; await manager.reconcile()
    expect(attempts).toBe(3); expect(ordinal).toBe(2)
    expect(manager.current(manager.capture())).toBe(true)
  } finally { allowClose = true; await manager.close(); rmWorkspaceSync(root) }
})
