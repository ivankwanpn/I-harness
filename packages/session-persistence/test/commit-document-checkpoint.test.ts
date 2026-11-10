import { expect, it } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { openCommitLog } from '@i-harness/session-commit-log'
import { createCommitCoordinator } from '../src/commit/coordinator.ts'

it('checkpoints through normal document writes while preserving deletion and legacy fallback semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-coordinator-checkpoint-'))
  const legacy = {
    async list() { return [] },
    async read(): Promise<never> { throw Error('No legacy session') },
    async readDocument(key: string) { return ['legacy-cleared', 'legacy-kept'].includes(key) ? { legacy: key } : undefined },
  }
  let coordinator = createCommitCoordinator({ root, legacy })
  try {
    expect(await coordinator.getDocument('legacy-cleared')).toEqual({ legacy: 'legacy-cleared' })
    await coordinator.create({ sessionId: 'gone' })
    await coordinator.deleteOwnedSession('gone', { documents: ['legacy-cleared'] })
    for (let revision = 0; revision < 75; revision++) await coordinator.putDocument('current', { revision })
    await coordinator.close()
    coordinator = createCommitCoordinator({ root, legacy })
    expect(await coordinator.getDocument('current')).toEqual({ revision: 74 })
    expect(await coordinator.getDocument('legacy-cleared')).toBeUndefined()
    expect(await coordinator.getDocument('legacy-kept')).toEqual({ legacy: 'legacy-kept' })
    expect(await coordinator.deletionReceipt('gone')).toMatchObject({ manifest: { documents: ['legacy-cleared'] } })
    expect(await coordinator.list()).not.toContain('gone')
    const log = await openCommitLog({ root, sessionId: '__documents__' }, 'read')
    try { expect(log.records().length).toBeLessThan(64) } finally { await log.close() }
    expect((await readdir(join(root, '__documents__', 'side'))).length).toBeLessThan(64)
  } finally {
    await coordinator.close()
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ih-coordinator-checkpoint-')) throw Error('Unsafe cleanup')
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
