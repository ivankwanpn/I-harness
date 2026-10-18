import { expect, it, vi } from 'vitest'
const observed = vi.hoisted(() => ({ active: false, pending: 0, peak: 0, calls: 0, directories: 0, directoryPeak: 0 }))
vi.mock('node:fs/promises', async original => {
  const native = await original<typeof import('node:fs/promises')>()
  return { ...native, readdir: vi.fn(async (...args: Parameters<typeof native.readdir>) => {
    if (!observed.active) return native.readdir(...args)
    observed.pending++; observed.directories++; observed.peak = Math.max(observed.peak, observed.pending); observed.directoryPeak = Math.max(observed.directoryPeak, observed.directories)
    try { return await native.readdir(...args) } finally { observed.pending--; observed.directories-- }
  }), lstat: vi.fn(async (...args: Parameters<typeof native.lstat>) => {
    if (!observed.active) return native.lstat(...args)
    observed.calls++; observed.pending++; observed.peak = Math.max(observed.peak, observed.pending)
    try { return await native.lstat(...args) } finally { observed.pending-- }
  }) }
})
import { mkdtemp, mkdir, writeFile, rm, lstat, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { physicalBytes } from '../src/artifact/quota.ts'

it('counts every staged/protected/unknown physical file with bounded metadata concurrency and rejects an incomplete inventory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quota-metadata-concurrency-'))
  try {
    for (let index = 0; index < 20; index++) {
      const directory = join(root, `operation-${index}`); await mkdir(join(directory, 'pins'), { recursive: true })
      await writeFile(join(directory, 'body'), Buffer.alloc(64)); await writeFile(join(directory, 'unknown.pending'), Buffer.alloc(13)); await writeFile(join(directory, 'pins', 'protected.json'), Buffer.alloc(7))
    }
    observed.active = true
    expect(await physicalBytes(root)).toBe(1680)
    expect(observed.calls).toBe(100)
    expect(observed.peak).toBeGreaterThan(1)
    expect(observed.peak).toBeLessThanOrEqual(32)
    expect(observed.directoryPeak).toBeGreaterThan(1)
    expect(observed.pending).toBe(0)
    const measuredLstat = vi.mocked(lstat).getMockImplementation()!
    vi.mocked(lstat).mockImplementation(async (...args) => {
      const info = await measuredLstat(...args)
      if (String(args[0]) === join(root, 'operation-0', 'body')) Object.defineProperty(info, 'size', { value: Number.MAX_SAFE_INTEGER })
      return info
    })
    await expect(physicalBytes(root)).rejects.toThrow(/overflow/)
    expect(observed.pending).toBe(0)
    vi.mocked(lstat).mockImplementation(measuredLstat)
    const link = join(root, 'linked')
    await symlink(join(root, 'operation-0'), link, 'junction')
    await expect(physicalBytes(root)).rejects.toThrow(/path unavailable/)
    expect(observed.pending).toBe(0)
    await unlink(link)
    vi.mocked(lstat).mockRejectedValueOnce(Object.assign(new Error('Inventory metadata unavailable'), { code: 'EACCES' }))
    await expect(physicalBytes(root)).rejects.toMatchObject({ code: 'EACCES' })
    expect(observed.pending).toBe(0)
  } finally { observed.active = false; await rm(root, { recursive: true, force: true }) }
})
