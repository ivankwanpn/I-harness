import { expect, it, vi } from 'vitest'
import { legacyFixture } from './legacy-fork-fixture.ts'
const debt = vi.hoisted(() => ({ enabled: false, failed: false, consume: false, calls: 0, gate: undefined as undefined | { entered(): void; wait: Promise<void> }, handle: undefined as undefined | import('node:fs/promises').FileHandle }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, async open(...args: Parameters<typeof fs.open>) {
    const handle = await fs.open(...args)
    if (debt.gate && String(args[0]).replaceAll('\\', '/').endsWith('/pages/0-0.json')) { debt.handle = handle; debt.gate.entered(); await debt.gate.wait }
    if (debt.enabled && String(args[0]).replaceAll('\\', '/').endsWith('/pages/0-0.json')) {
      const close = handle.close.bind(handle)
      handle.close = async () => { debt.calls++; if (!debt.failed) { debt.failed = true; debt.handle = handle; if (debt.consume) await close(); throw Error('Original legacy file close failed') } await close() }
    }
    return handle
  } }
})

it('closes a late-acquired original page handle when service retirement invalidates its awaiting reader', async () => {
  const f = await legacyFixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    expect((await f.run()).kind).toBe('ready')
    const observation = await f.observation()
    debt.gate = { entered: () => entered.resolve(), wait: release.promise }
    const read = f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, observation).catch(error => error)
    await entered.promise
    let retired = false
    const closing = f.service().close().then(() => { retired = true })
    await new Promise(resolve => setTimeout(resolve, 5)); expect(retired).toBe(false)
    debt.gate = undefined; release.resolve()
    expect(await read).toBeInstanceOf(Error); await closing
    expect(debt.handle?.fd).toBe(-1)
  } finally { debt.gate = undefined; release.resolve(); await debt.handle?.close(); await f.close(); debt.handle = undefined }
})

it('retries the same transfer-scope original handle before its actual host callback exits', async () => {
  const f = await legacyFixture()
  try {
    debt.enabled = true; debt.failed = false; debt.calls = 0
    const outcome = await f.run()
    expect(outcome.kind).toBe('ready')
    expect(debt.calls).toBeGreaterThanOrEqual(2)
    expect(debt.handle?.fd).toBe(-1)
    debt.enabled = false
  } finally { debt.enabled = false; await debt.handle?.close(); await f.close(); debt.failed = false; debt.handle = undefined }
})

it('keeps a failed consumed native close as unknown instead of accepting a later no-op', async () => {
  const f = await legacyFixture()
  try {
    expect((await f.run()).kind).toBe('ready')
    const observation = await f.observation(); debt.enabled = debt.consume = true; debt.failed = false
    await expect(f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, observation)).rejects.toThrow()
    debt.enabled = false; expect(debt.handle?.fd).toBe(-1)
    await expect(f.service().close()).rejects.toThrow(/Original/)
    await expect(f.service().close()).rejects.toThrow(/Original/)
  } finally {
    debt.enabled = debt.consume = false; debt.failed = true; await debt.handle?.close(); debt.handle = undefined; debt.failed = false
    await f.broker().close(); await f.coordinator().close()
  }
})
it('joins and retries the original legacy page handle before the store lifetime closes', async () => {
  const f = await legacyFixture()
  try {
    expect((await f.run()).kind).toBe('ready')
    const observation = await f.observation(); debt.enabled = true
    await expect(f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, observation)).rejects.toThrow()
    debt.enabled = false
    expect(debt.handle?.fd).toBeGreaterThanOrEqual(0)
    await f.service().close()
    expect(debt.handle?.fd).toBe(-1)
  } finally { debt.enabled = false; await debt.handle?.close(); await f.close(); debt.failed = false; debt.handle = undefined }
})
