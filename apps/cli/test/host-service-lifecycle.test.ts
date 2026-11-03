import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

// Construction/close coverage only. EOF executes no tool and supplies no A9
// bounded-result evidence; actual producer/finalizer routes live in executor.
const serviceCalls = vi.hoisted(() => ({ list: [] as Record<string, unknown>[] }))
vi.mock('@i-harness/session-executor', async importOriginal => {
  const actual = await importOriginal<typeof import('@i-harness/session-executor')>()
  const real = actual.createSessionService as unknown as (opts: Record<string, unknown>) => unknown
  return { ...actual, createSessionService: (opts: Record<string, unknown>) => { serviceCalls.list.push(opts); return real(opts) } }
})
const { main } = await import('../src/index.ts')
let configDir: string, previousConfigDir: string | undefined, previousStdin: PropertyDescriptor | undefined
beforeEach(() => {
  serviceCalls.list.length = 0
  configDir = mkdtempSync(join(tmpdir(), 'host-service-'))
  previousConfigDir = process.env.IH_CONFIG_DIR
  process.env.IH_CONFIG_DIR = configDir
  previousStdin = Object.getOwnPropertyDescriptor(process, 'stdin')
  Object.defineProperty(process, 'stdin', { value: Readable.from([]), configurable: true, writable: true })
})
afterEach(() => {
  if (previousStdin !== undefined) Object.defineProperty(process, 'stdin', previousStdin)
  if (previousConfigDir === undefined) delete process.env.IH_CONFIG_DIR
  else process.env.IH_CONFIG_DIR = previousConfigDir
  rmSync(configDir, { recursive: true, force: true })
})
it.each(['sdk', 'acp'])('main constructs and closes the real %s service on EOF', async command => {
  expect(await main(['node', 'i-harness', command])).toBe(0)
  expect(serviceCalls.list).toHaveLength(1)
  expect(serviceCalls.list[0]?.modelBindingFor).toBeTypeOf('function')
})
