import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import * as locking from '@i-harness/fs-lock'
import { createWorkspaceMutationOwner, type WorkspaceMutationTurn } from '../src/workspace-mutation.ts'
import { ContextStore } from '../src/store.ts'
import { createLegacyUseGate } from '../src/legacy/use-gate.ts'

it('requires actual owner tokens, expires them, and rejects own-tail waits/reentry promptly', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'workspace-turn-'))
  const owner = createWorkspaceMutationOwner({ root, workspaceId: 'w' }), foreign = createWorkspaceMutationOwner({ root, workspaceId: 'other' })
  let stale!: WorkspaceMutationTurn
  try {
    expect(await owner.mutate(async turn => {
      stale = turn; owner.assertTurn(turn); turn.assertCurrent()
      expect(() => foreign.assertTurn(turn)).toThrow(/stale|foreign/)
      expect(() => owner.assertTurn({ assertCurrent() {} })).toThrow(/stale|foreign/)
      await expect(owner.mutate(async () => {})).rejects.toThrow(/reentry/)
      await expect(owner.cleanup(async () => {})).rejects.toThrow(/reentry/)
      await expect(owner.join()).rejects.toThrow(/reentry/)
      await expect(owner.close()).rejects.toThrow(/reentry/)
      return 42
    })).toBe(42)
    expect(() => owner.assertTurn(stale)).toThrow(/stale|foreign/)
    const inventory = new ContextStore(root, 'inventory')
    await expect(inventory.acquireLifetime()).rejects.toThrow(/ownership/)
    const gate = createLegacyUseGate()
    await gate.exclusive(undefined, async lease => {
    await expect(inventory.open({ assertCurrent() {} }, lease, 1024 * 1024, 'query')).rejects.toThrow(/lifetime/)
    const store = new ContextStore(root, 'w', owner, gate.assertLease)
    await store.acquireLifetime()
    try {
      await owner.mutate(turn => store.open(turn, lease, 1024 * 1024, 'query'))
      await expect(foreign.mutate(turn => store.prune(turn, lease))).rejects.toThrow(/stale|foreign/)
      await expect(store.prune(stale, lease)).rejects.toThrow(/stale|foreign/)
      await expect(store.clear({ assertCurrent() {} }, lease, 1024 * 1024)).rejects.toThrow(/stale|foreign/)
    } finally { await store.close(lease) }
    })
  } finally { await owner.close(); await foreign.close(); await rm(root, { recursive: true, force: true }) }
})

it.each([false, true])('preserves work/release failures and original quota lease debt (consumed=%s)', async consumed => {
  const root = await mkdtemp(resolve(tmpdir(), 'workspace-debt-'))
  const owner = createWorkspaceMutationOwner({ root, workspaceId: 'w' })
  const acquire = locking.acquireSessionLock, workFailure = new Error('original work failure'), releaseFailure = new Error('original release failure')
  let original: locking.SessionLock | undefined, releases = 0
  const spy = vi.spyOn(locking, 'acquireSessionLock').mockImplementation(async options => {
    const lease = original = await acquire(options)
    return { get held() { return lease.held }, async release() {
      releases++
      if (releases === 1) { if (consumed) await lease.release(); throw releaseFailure }
      await lease.release()
    } }
  })
  try {
    const failure = await owner.mutate(async () => { throw workFailure }).catch(error => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors).toEqual([workFailure, releaseFailure])
    await expect(owner.mutate(async () => {})).rejects.toThrow(/unresolved/)
    expect(spy).toHaveBeenCalledTimes(1)
    if (consumed) {
      await expect(owner.close()).rejects.toBe(releaseFailure)
      await expect(owner.close()).rejects.toBe(releaseFailure)
      expect(releases).toBe(1)
    } else {
      await owner.close(); expect(releases).toBe(2)
    }
    expect(spy).toHaveBeenCalledTimes(1)
  } finally { spy.mockRestore(); await original?.release(); await rm(root, { recursive: true, force: true }) }
})
