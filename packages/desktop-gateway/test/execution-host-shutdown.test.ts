import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const state = vi.hoisted(() => ({ owner: undefined as any, coordinator: undefined as any, service: undefined as any, entered: undefined as PromiseWithResolvers<void> | undefined, gate: undefined as PromiseWithResolvers<void> | undefined }))
vi.mock('../src/execution-host-observation.ts', async original => { const actual = await original<any>(); return { ...actual, createExecutionHostObservation(...args: any[]) { state.coordinator = args[0]; state.service = args[2]; return state.owner = actual.createExecutionHostObservation(...args) } } })
vi.mock('../src/router.ts', async original => { const actual = await original<any>(); return { ...actual, createDesktopRouter(...args: any[]) { const router = actual.createDesktopRouter(...args), close = router.close.bind(router); router.close = async () => { state.entered?.resolve(); await state.gate?.promise; await close() }; return router } } })
import { createDesktopHost } from '../src/host.ts'
it.each(['held-router', 'observation-debt', 'held-snapshot'] as const)('fences actual host entry and retains dependency prerequisites (%s)', async mode => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'actual-host-fence-'))
  state.entered = Promise.withResolvers<void>(); state.gate = Promise.withResolvers<void>()
  const host = await createDesktopHost({ workspace: root, sessionDir: join(root, 'sessions'), settingsPath: join(root, 'settings.json'), onWrite() {} })
  const snapshotGate = Promise.withResolvers<void>(), snapshotEntered = Promise.withResolvers<void>()
  try {
    await state.coordinator.create({ sessionId: 's' }); await state.coordinator.releaseOwnership('s')
    const lease = await state.owner.subscribe('s', () => {})
    let reading: Promise<unknown> | undefined
    if (mode === 'held-snapshot') {
      const originalSnapshot = state.coordinator.snapshot.bind(state.coordinator)
      state.coordinator.snapshot = async (...args: any[]) => { const value = await originalSnapshot(...args); snapshotEntered.resolve(); await snapshotGate.promise; return value }
      reading = lease.snapshot(); void reading!.catch(() => {}); await snapshotEntered.promise
    }
    const original = state.owner.close.bind(state.owner)
    let fail = mode === 'observation-debt'
    state.owner.close = (...args: any[]) => { if (fail) { fail = false; return Promise.reject(false) }; return original(...args) }
    const coordinatorClose = vi.spyOn(state.service, 'close')
    const closing = host.close(); void closing.catch(() => {})
    await expect(lease.snapshot()).rejects.toThrow()
    await expect(state.owner.subscribe('s', () => {})).rejects.toThrow()
    await state.entered.promise
    snapshotGate.resolve(); if (reading) await expect(reading).rejects.toThrow()
    state.gate.resolve()
    if (mode === 'observation-debt') { await expect(closing).rejects.toThrow(); expect(coordinatorClose).not.toHaveBeenCalled(); await host.close() }
    else await closing
  } finally { snapshotGate.resolve(); state.gate.resolve(); await host.close(); await rm(root, { recursive: true, force: true }) }
})
