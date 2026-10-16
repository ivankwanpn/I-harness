import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { committedFactSeqs, type ManagedAction } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'

export async function ownedTeamFixture(seed: Parameters<ManagedAction['captureTeamTransaction']>[0] = [], id = 'parent') {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-team-owner-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  await coordinator.create({ sessionId: id })
  const document = await coordinator.openManagedDocument(id)
  if (seed.length) {
    const action = document.beginAction()
    try { committedFactSeqs(await action.captureTeamTransaction(seed).admit()) }
    finally { action.finish() }
  }
  return { root, backend, coordinator, document }
}
