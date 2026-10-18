import { expect, it, vi } from 'vitest'
const gate = vi.hoisted(() => ({ entered: Promise.withResolvers<void>(), released: Promise.withResolvers<void>() }))
vi.mock('undici', async original => { gate.entered.resolve(); await gate.released.promise; return original<typeof import('undici')>() })
import { createSystemFetch } from '../src/index.ts'

it('checks current ownership after the actual dispatcher module acquisition await, before any global fetch', async () => {
  let calls = 0, reserves = 0, stopped = false
  vi.stubGlobal('fetch', async () => { calls++; throw new Error('Unexpected network destination') })
  const transport = createSystemFetch({ platform: 'linux', env: () => ({ HTTPS_PROXY: 'http://127.0.0.1:1' }) })
  const failure = Object.assign(new Error('owner revoked while dispatcher acquisition was held'), { code: 'GENERATION_STALE' })
  const pending = transport.fetch('https://dispatcher.fixture.invalid', { method: 'POST' }, async () => { reserves++; return () => { if (stopped) throw failure } })
  void pending.catch(() => {})
  try {
    await gate.entered.promise
    expect([calls, reserves]).toEqual([0, 0])
    stopped = true; gate.released.resolve()
    await expect(pending).rejects.toBe(failure)
    expect([calls, reserves]).toEqual([0, 1])
  } finally { gate.released.resolve(); await pending.catch(() => {}); await transport.close(); vi.unstubAllGlobals() }
})
