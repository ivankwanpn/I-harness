import { expect, it, vi } from 'vitest'
const io = vi.hoisted(() => ({ enabled: false, writes: 0, bodies: 0, reads: 0, syncs: 0, failClose: 0, consume: false, closes: 0 }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, async open(...args: Parameters<typeof fs.open>) {
    const path = String(args[0]); if (io.enabled) { io.reads++; if (args[1] !== 'r') io.writes++; if (/[\\/]blobs[\\/]/.test(path)) io.bodies++ }
    const handle = await fs.open(...args)
    return new Proxy(handle, { get(target, name) {
      if (name === 'sync') return async () => { if (io.enabled) io.syncs++; return target.sync() }
      if (name === 'close' && path.endsWith('plan.json')) return async () => { if (io.enabled) io.closes++; if (io.failClose) { io.failClose--; if (io.consume) await target.close(); throw undefined }; return target.close() }
      const value = Reflect.get(target, name, target); return typeof value === 'function' ? value.bind(target) : value
    } })
  }, async readFile(...args: Parameters<typeof fs.readFile>) { if (io.enabled && /[\\/]blobs[\\/]/.test(String(args[0]))) io.bodies++; return fs.readFile(...args) } }
})
import * as originalService from '../src/service.ts'
import { inspectColdSelectedTarget, useColdSelectedTarget } from '../../session-persistence/src/selected-source-owner.ts'
import { coldLegacyFixture } from './fixtures/cold-selected-legacy.ts'
import { ContextStore } from '../src/store.ts'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'

it('qualifies the original nonready V2 legacy plan and keeps a finite seal after cold callback expiry', async () => {
  const f = await coldLegacyFixture()
  try {
    const acquire = (originalService as unknown as Record<string, any>).acquireColdSelectedQualification
    expect(typeof acquire).toBe('function')
    const target = await inspectColdSelectedTarget(f.coordinator, f.route)
    if (target.kind !== 'qualification-required') throw Error('Missing cold target')
    let qualification: any
    await useColdSelectedTarget(f.coordinator, target.target, async cold => {
      expect(() => cold.document.assertReady()).toThrow()
      qualification = acquire(f.service, f.coordinator, cold, f.sourceId)
      await qualification.qualify(); qualification.sealWhileActive()
    })
    await qualification.settle(); qualification.assertSettledCurrent()
    await qualification.close(); expect(() => qualification.assertSettledCurrent()).toThrow()
  } finally { await f.close() }
})

it('cold legacy qualification is read-only, expires visible grants independently and refuses copied authority', async () => {
  const f = await coldLegacyFixture(); let clock: { mockRestore(): void } | undefined
  const capture = vi.spyOn(f.service, 'capture'), grant = vi.spyOn(f.service, 'grant'), profile = vi.spyOn(f.coordinator, 'profile'), index = vi.spyOn(ContextStore.prototype, 'ensureIndex'), body = vi.spyOn(ContextStore.prototype, 'verifyBody')
  try {
    const target = await inspectColdSelectedTarget(f.coordinator, f.route); if (target.kind !== 'qualification-required') throw Error('Missing target')
    let selected!: ReturnType<typeof originalService.acquireColdSelectedQualification>
    await useColdSelectedTarget(f.coordinator, target.target, async cold => {
      expect(() => originalService.acquireColdSelectedQualification({ ...f.service }, f.coordinator, cold, f.sourceId)).toThrow()
      expect(() => originalService.acquireColdSelectedQualification(f.service, { ...f.coordinator }, cold, f.sourceId)).toThrow()
      expect(() => originalService.acquireColdSelectedQualification(f.service, f.coordinator, { ...cold }, f.sourceId)).toThrow()
      selected = originalService.acquireColdSelectedQualification(f.service, f.coordinator, cold, f.sourceId)
      io.writes = io.bodies = io.syncs = io.reads = 0; io.enabled = true
      await selected.qualify(); selected.sealWhileActive()
    })
    await selected.settle(); const reads = io.reads; selected.assertSettledCurrent(); expect(io.reads).toBe(reads)
    expect([io.writes, io.bodies, io.syncs]).toEqual([0, 0, 0]); for (const spy of [capture, grant, profile, index, body]) expect(spy).not.toHaveBeenCalled()
    expect(() => ({ ...selected }).assertSettledCurrent()).toThrow('receiver')
    clock = vi.spyOn(Date, 'now').mockReturnValue(f.ref.expiresAt); expect(() => selected.assertSettledCurrent()).toThrow('expired'); clock.mockRestore(); clock = undefined
    expect(() => selected.assertSettledCurrent()).toThrow(); await selected.close()
  } finally { clock?.mockRestore(); io.enabled = false; for (const spy of [capture, grant, profile, index, body]) spy.mockRestore(); await f.close() }
})

it.each([false, true])('cold legacy requires its genuine V2 plan even for an empty selected seed=%s', async empty => {
  const f = await coldLegacyFixture(empty)
  try {
    const target = await inspectColdSelectedTarget(f.coordinator, f.route); if (target.kind !== 'qualification-required') throw Error('Missing target')
    let selected!: ReturnType<typeof originalService.acquireColdSelectedQualification>
    await useColdSelectedTarget(f.coordinator, target.target, async cold => { selected = originalService.acquireColdSelectedQualification(f.service, f.coordinator, cold, f.sourceId); await selected.qualify(); selected.sealWhileActive() })
    await selected.settle(); selected.assertSettledCurrent(); await selected.close()
    const path = join(f.directory, 'plan.json'); await rename(path, path + '.original')
    try {
      await useColdSelectedTarget(f.coordinator, target.target, async cold => {
        const missing = originalService.acquireColdSelectedQualification(f.service, f.coordinator, cold, f.sourceId)
        await expect(missing.qualify()).rejects.toThrow(); expect(() => missing.sealWhileActive()).toThrow(); await missing.close(); expect(() => missing.assertSettledCurrent()).toThrow()
      })
    } finally { await rename(path + '.original', path) }
  } finally { await f.close() }
})

it('cold legacy service revocation fences the independent proof after callback expiry', async () => {
  const f = await coldLegacyFixture()
  try {
    const target = await inspectColdSelectedTarget(f.coordinator, f.route); if (target.kind !== 'qualification-required') throw Error('Missing target')
    let selected!: ReturnType<typeof originalService.acquireColdSelectedQualification>
    await useColdSelectedTarget(f.coordinator, target.target, async cold => { selected = originalService.acquireColdSelectedQualification(f.service, f.coordinator, cold, f.sourceId); await selected.qualify(); selected.sealWhileActive() })
    await selected.settle(); selected.assertSettledCurrent(); await f.service.clear('source'); selected.assertSettledCurrent()
    await f.service.clear('target'); expect(() => selected.assertSettledCurrent()).toThrow(); await selected.close()
  } finally { await f.close() }
})

it('cold legacy retains exact falsey acquisition cleanup and never requalifies during retry', async () => {
  const f = await coldLegacyFixture()
  try {
    const target = await inspectColdSelectedTarget(f.coordinator, f.route); if (target.kind !== 'qualification-required') throw Error('Missing target')
    let selected!: ReturnType<typeof originalService.acquireColdSelectedQualification>
    await useColdSelectedTarget(f.coordinator, target.target, async cold => {
      selected = originalService.acquireColdSelectedQualification(f.service, f.coordinator, cold, f.sourceId)
      io.enabled = true; io.failClose = 2; io.consume = false
      await expect(selected.qualify()).rejects.toBeUndefined(); expect(() => selected.sealWhileActive()).toThrow()
    })
    const reads = io.reads; await expect(selected.close()).rejects.toBeUndefined()
    const cleanup = originalService.selectedMetadataCleanupFor(f.service, undefined); expect(cleanup).toBeDefined(); await cleanup!.retry()
    expect(io.reads).toBe(reads); expect(() => selected.sealWhileActive()).toThrow(); expect(() => selected.assertSettledCurrent()).toThrow()
  } finally { io.failClose = 0; io.enabled = false; await f.close() }
})

it('cold legacy preserves consumed-held file uncertainty without accepting a later no-op', async () => {
  const f = await coldLegacyFixture()
  try {
    const target = await inspectColdSelectedTarget(f.coordinator, f.route); if (target.kind !== 'qualification-required') throw Error('Missing target')
    let selected!: ReturnType<typeof originalService.acquireColdSelectedQualification>
    await useColdSelectedTarget(f.coordinator, target.target, async cold => {
      selected = originalService.acquireColdSelectedQualification(f.service, f.coordinator, cold, f.sourceId)
      io.enabled = true; io.failClose = 1; io.consume = true
      await expect(selected.qualify()).rejects.toBeUndefined()
    })
    const reads = io.reads, closes = io.closes
    await expect(selected.close()).rejects.toBeUndefined(); await expect(selected.close()).rejects.toBeUndefined()
    expect(io.closes).toBe(closes); expect(io.reads).toBe(reads); expect(() => selected.sealWhileActive()).toThrow()
    await expect(f.service.close()).rejects.toBeUndefined()
  } finally { io.enabled = false; io.failClose = 0; io.consume = false; await f.coordinator.close(); await f.service.close().catch(() => {}) }
})

it('cold legacy service close revokes an independently settled proof even with no remaining file debt', async () => {
  const f = await coldLegacyFixture()
  try {
    const target = await inspectColdSelectedTarget(f.coordinator, f.route); if (target.kind !== 'qualification-required') throw Error('Missing target')
    let selected!: ReturnType<typeof originalService.acquireColdSelectedQualification>
    await useColdSelectedTarget(f.coordinator, target.target, async cold => { selected = originalService.acquireColdSelectedQualification(f.service, f.coordinator, cold, f.sourceId); await selected.qualify(); selected.sealWhileActive() })
    await selected.settle(); selected.assertSettledCurrent(); await f.service.close(); expect(() => selected.assertSettledCurrent()).toThrow()
  } finally { await f.close() }
})
