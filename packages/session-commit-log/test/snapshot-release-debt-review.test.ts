import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { SessionLock } from '@i-harness/fs-lock'

const fault = vi.hoisted(() => ({ enabled: false, original: undefined as SessionLock | undefined, error: Error('native shared unlock and close were unresolved') }))
vi.mock('@i-harness/fs-lock', async original => {
  const native = await original<typeof import('@i-harness/fs-lock')>()
  return { ...native, async acquireSessionLock(...args: Parameters<typeof native.acquireSessionLock>) {
    const held = await native.acquireSessionLock(...args)
    if (!fault.enabled || args[0].mode !== 'shared') return held
    fault.original = held
    let visibleHeld = true
    // Match the native lease's consumed held-bit behavior on an unresolved
    // unlock/close. Keep the actual kernel lease for the contention proof.
    return { get held() { return visibleHeld }, release() {
      if (!visibleHeld) return
      visibleHeld = false
      throw fault.error
    } }
  } }
})
import { createCommitLog, openCommitLog, type CommitLog } from '../src/store.ts'
import { CommitLogCleanupError } from '../src/resources.ts'
import { acquireCommitSnapshotLease } from '../src/lease.ts'

it('does not turn a consumed shared release failure into a successful reader close while the real lease remains held', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-snapshot-release-review-'))
  let reader: CommitLog | undefined
  try {
    const initial = await createCommitLog({ root, sessionId: '__documents__' }, { header: { kind: 'document-store' } })
    await initial.close()
    fault.enabled = true
    reader = await openCommitLog({ root, sessionId: '__documents__' }, 'read')
    const first = await reader.close().catch(error => error)
    expect(first).toBeInstanceOf(CommitLogCleanupError)
    const second = await Promise.allSettled([reader.close()])
    // A separate real native acquire proves that the original shared lease
    // was not released; the observer has not replaced contention semantics.
    await expect(acquireCommitSnapshotLease('__documents__', { lockRoot: root, deadlineMs: 0 }, 'exclusive')).rejects.toMatchObject({ name: 'SessionLockConflictError' })
    expect(second[0]?.status).toBe('rejected')
    for (const error of [first, second[0]?.status === 'rejected' ? second[0].reason : undefined]) {
      let cause = error
      while (cause instanceof CommitLogCleanupError) cause = cause.cause
      expect(cause).toBe(fault.error)
    }
    expect(reader.open).toBe(true)
  } finally {
    fault.enabled = false
    await fault.original?.release(); fault.original = undefined
    await reader?.close().catch(() => undefined)
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ih-snapshot-release-review-')) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
}, 15000)
