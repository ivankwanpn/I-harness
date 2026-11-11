import { expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { SessionLock } from '@i-harness/fs-lock'

const fault = vi.hoisted(() => ({
  enabled: false,
  releaseAllowed: false,
  attempts: 0,
  originals: [] as SessionLock[],
  error: Error('Original snapshot release is temporarily unavailable'),
}))

vi.mock('@i-harness/fs-lock', async original => {
  const native = await original<typeof import('@i-harness/fs-lock')>()
  return {
    ...native,
    async acquireSessionLock(...args: Parameters<typeof native.acquireSessionLock>) {
      const lease = await native.acquireSessionLock(...args)
      if (!fault.enabled || args[0].mode !== 'shared') return lease
      fault.originals.push(lease)
      return {
        get held() { return lease.held },
        release() {
          fault.attempts++
          if (!fault.releaseAllowed) throw fault.error
          return lease.release()
        },
      }
    },
  }
})

import { acquireSessionLock, lockPathFor } from '@i-harness/fs-lock'
import { createCommitLog } from '@i-harness/session-commit-log'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/backend-factory.ts'
import { createJsonlCommitCoordinator } from '../../session-persistence-jsonl/src/commit-coordinator.ts'

async function fixture(run: (root: string, owners: { close(): Promise<void> }[]) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'ih-commit-cleanup-retention-'))
  const owners: { close(): Promise<void> }[] = []
  fault.enabled = false
  fault.releaseAllowed = false
  fault.attempts = 0
  try { await run(root, owners) }
  finally {
    fault.enabled = false
    fault.releaseAllowed = true
    const results = await Promise.allSettled(owners.map(owner => owner.close()))
    for (const lease of fault.originals.splice(0)) await lease.release()
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ih-commit-cleanup-retention-')) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Original cleanup owners did not settle')
  }
}

async function expectRetained(root: string, sessionId: string) {
  await expect(acquireSessionLock({
    lockPath: lockPathFor(root, `commit-log-snapshots:${sessionId}`),
    deadlineMs: 0,
  })).rejects.toMatchObject({ name: 'SessionLockConflictError' })
}

async function expectReleased(root: string, sessionId: string) {
  const lease = await acquireSessionLock({
    lockPath: lockPathFor(root, `commit-log-snapshots:${sessionId}`),
    deadlineMs: 0,
  })
  await lease.release()
}

it.each([false, true])('retains an original commit reader cleanup across coordinator close, failed open %s', async corrupt => {
  await fixture(async (root, owners) => {
    const sessionId = 'original'
    const initial = await createCommitLog({ root, sessionId }, {
      header: { sessionId, formatVersion: 14, createdAt: new Date().toISOString() },
    })
    await initial.close()
    if (corrupt) await writeFile(join(root, sessionId, 'session.v15.jsonl'), 'invalid committed bytes\n')
    const coordinator = createJsonlCommitCoordinator(root)
    owners.push(coordinator)
    fault.enabled = true
    await expect(coordinator.profile(sessionId)).rejects.toMatchObject({ code: 'COMMIT_LOG_CLEANUP_REQUIRED' })
    expect(fault.originals).toHaveLength(1)
    await expectRetained(root, sessionId)
    await expect(coordinator.close()).rejects.toThrow('Commit coordinator close failed')
    await expectRetained(root, sessionId)
    expect(fault.attempts).toBeGreaterThanOrEqual(2)
    fault.releaseAllowed = true
    await coordinator.close()
    expect(fault.originals[0]!.held).toBe(false)
    await expectReleased(root, sessionId)
    await coordinator.close()
  })
})

it.each([false, true])('retains a document-claim reader in the original JSONL backend cleanup, failed open %s', async corrupt => {
  await fixture(async (root, owners) => {
    const initial = await createCommitLog({ root, sessionId: '__documents__' }, { header: { kind: 'document-store' } })
    await initial.close()
    if (corrupt) await writeFile(join(root, '__documents__', 'session.v15.jsonl'), 'invalid document bytes\n')
    const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
    owners.push(coordinator)
    fault.enabled = true
    await expect(coordinator.putDocumentStrict!('unclaimed', { value: 'cannot publish' })).rejects.toThrow()
    expect(fault.originals).toHaveLength(1)
    await expectRetained(root, '__documents__')
    await expect(coordinator.close()).rejects.toThrow()
    await expectRetained(root, '__documents__')
    expect(fault.attempts).toBeGreaterThanOrEqual(2)
    fault.releaseAllowed = true
    await coordinator.close()
    expect(fault.originals[0]!.held).toBe(false)
    await expectReleased(root, '__documents__')
    await coordinator.close()
  })
})
