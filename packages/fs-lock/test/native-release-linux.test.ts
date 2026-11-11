import { expect, it, vi } from 'vitest'
import { mkdtempSync, openSync, closeSync, fstatSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const observed = vi.hoisted(() => ({ fd: -1, flags: [] as number[], closes: 0, fail: false, failure: undefined as unknown }))
vi.mock('node:module', async original => {
  const native = await original<typeof import('node:module')>()
  return { ...native, createRequire(...args: Parameters<typeof native.createRequire>) {
    const require = native.createRequire(...args)
    return (name: string) => name === 'koffi' ? { errno: () => 0, load: () => ({ func: () => (fd: number, flags: number) => { observed.fd = fd; observed.flags.push(flags); return 0 } }) } : require(name)
  } }
})
vi.mock('node:fs', async original => {
  const native = await original<typeof import('node:fs')>()
  return { ...native, closeSync(fd: number) {
    if (fd === observed.fd) observed.closes++
    native.closeSync(fd)
    // Linux close may release the descriptor before reporting an error. The
    // actual second file below must remain open after another release call.
    if (observed.fail && fd === observed.fd) { observed.fail = false; throw observed.failure }
  } }
})
import { acquireLinux } from '../src/linux.ts'

it.each(['shared', 'exclusive'] as const)('uses successful original close alone for Linux %s disposal', async mode => {
  const root = mkdtempSync(join(tmpdir(), 'ih-linux-release-'))
  observed.closes = 0; observed.flags = []; observed.fail = false
  try {
    const lease = await acquireLinux({ lockPath: join(root, 'owned.lock') }, mode)
    lease.release(); lease.release()
    expect(lease.held).toBe(false); expect(observed.closes).toBe(1)
    expect(observed.flags).toEqual([mode === 'shared' ? 5 : 6])
  } finally {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ih-linux-release-')) throw Error('Unsafe fixture cleanup')
    rmSync(root, { recursive: true, force: true })
  }
})

it.each([Error('native close result unknown'), undefined, false])('retains a Linux close failure without closing a later descriptor', async failure => {
  const root = mkdtempSync(join(tmpdir(), 'ih-linux-release-'))
  observed.closes = 0; observed.flags = []; observed.fail = false
  let later: number | undefined
  try {
    const lease = await acquireLinux({ lockPath: join(root, 'owned.lock') })
    observed.failure = failure; observed.fail = true
    const first = (await Promise.allSettled([Promise.resolve().then(() => lease.release())]))[0]!
    later = openSync(join(root, 'later.file'), 'w+')
    const second = (await Promise.allSettled([Promise.resolve().then(() => lease.release())]))[0]!
    expect(first).toMatchObject({ status: 'rejected', reason: failure })
    expect(second).toMatchObject({ status: 'rejected', reason: failure })
    expect(lease.held).toBe(false); expect(observed.closes).toBe(1)
    expect(fstatSync(later).isFile()).toBe(true)
    expect(observed.flags).toEqual([6])
  } finally {
    observed.fail = false
    if (later !== undefined) closeSync(later)
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ih-linux-release-')) throw Error('Unsafe fixture cleanup')
    rmSync(root, { recursive: true, force: true })
  }
})
