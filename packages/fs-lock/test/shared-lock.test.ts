import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireSessionLock, SessionLockConflictError } from '../src/index.ts'
import { originalHeldStateFor } from '../src/original-held-state.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ih-shared-lock-')) throw Error('Unsafe cleanup')
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(!['win32', 'linux'].includes(process.platform))('retains concurrent readers while excluding maintenance and exclusive ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-shared-lock-'))
  roots.push(root)
  const options = { lockPath: join(root, 'snapshot.lock'), deadlineMs: 30, retryMs: 5 }
  const first = await acquireSessionLock({ ...options, mode: 'shared' })
  const second = await acquireSessionLock({ ...options, mode: 'shared' })
  try {
    expect(first.held && second.held).toBe(true)
    expect(originalHeldStateFor(first)).toBeUndefined()
    expect(originalHeldStateFor(second)).toBeUndefined()
    await expect(acquireSessionLock(options)).rejects.toBeInstanceOf(SessionLockConflictError)
    await first.release()
    await expect(acquireSessionLock(options)).rejects.toBeInstanceOf(SessionLockConflictError)
  } finally { await first.release(); await second.release() }
  const writer = await acquireSessionLock(options)
  try {
    expect(originalHeldStateFor(writer)?.read()).toBe(true)
    await expect(acquireSessionLock({ ...options, mode: 'shared' })).rejects.toBeInstanceOf(SessionLockConflictError)
  } finally { await writer.release() }
})

it('rejects an invalid mode before opening a native lock', async () => {
  await expect(acquireSessionLock({ lockPath: 'unused', mode: 'invalid' as never })).rejects.toThrow('Invalid file lock mode')
})
