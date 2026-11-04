import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { committedFactSeqs, type ManagedAction } from '@i-harness/core-session'
import { createSessionCoordinator, type PersistenceBackend } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/backend-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'

type OwnedAppend = NonNullable<PersistenceBackend['appendOwnedBatch']>
type OwnedReconcile = NonNullable<PersistenceBackend['reconcileOwnedBatch']>

/** D-12 migration seam: hooks are installed BEFORE the backend's canonical-path
 * guard binds its descriptors, so tests no longer patch the guarded backend
 * after creation (which yielded PROCESS_READ_UNAVAILABLE). */
export interface TeamFixtureControl {
  append?: (original: OwnedAppend) => OwnedAppend
  reconcile?: (original: OwnedReconcile) => OwnedReconcile
}

export async function ownedTeamFixture(
  seed: Parameters<ManagedAction['captureTeamTransaction']>[0] = [],
  id = 'parent',
  options: { composed?: boolean; control?: TeamFixtureControl } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-team-owner-'))
  const control = options.control ?? {}
  const backend = createJsonlBackend(root, options.composed ? {
    wrapOwnedBatch: original => (control.append ? control.append(original) : original),
    wrapOwnedReconcile: original => (control.reconcile ? control.reconcile(original) : original),
  } : undefined)
  const coordinator = options.composed
    ? composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
    : createSessionCoordinator(backend, { lock: { enabled: true } })
  await coordinator.create({ sessionId: id })
  const document = await coordinator.openManagedDocument(id)
  if (seed.length) {
    const action = document.beginAction()
    try { committedFactSeqs(await action.captureTeamTransaction(seed).admit()) }
    finally { action.finish() }
  }
  return { root, backend, coordinator, document, control }
}
