import type { SessionEvent } from '@i-harness/core-session'
import { attachArchiveReadResources } from '../archive-read-internal.ts'
import { createDocuments } from '../coordinator/documents.ts'
import { isOriginalCanonicalExclusion } from '../coordinator/artifact-path-association.ts'
import { createOwnership } from '../coordinator/ownership.ts'
import type { CoordinatorOptions, PersistenceBackend } from '../coordinator/types.ts'
import type { SessionMeta } from '../coordinator/types.ts'

/** One session read from a pre-commit-log generation (format 13/14). */
export type LegacySession = { readonly version: number; readonly events: readonly SessionEvent[]; readonly meta?: SessionMeta }

/** Legacy read port, with an optional constructor-owned exclusive migration scope. */
export type LegacySessionStore = {
  read(sessionId: string): Promise<LegacySession>
  list(): Promise<string[]>
  /** Exclusive original legacy ownership spans the read and generation publication. */
  migrate?<T>(sessionId: string, publish: (source: LegacySession | undefined) => Promise<T>): Promise<T>
  withDocuments?<T>(keys: readonly string[], work: () => Promise<T>): Promise<T>
  close?(): Promise<void>
  /** Read-through for documents that predate the commit-log store. */
  readDocument?(key: string): Promise<unknown | undefined>
}

/** The same canonical artifact/lease protocol as normal JSONL writers, without
 * repairing or adopting the legacy history. Cleanup stays in that owner. */
export function createOwnedLegacySessionStore(backend: PersistenceBackend, options?: CoordinatorOptions): LegacySessionStore {
  const owner = createOwnership(backend, { ...options, lock: { ...options?.lock, enabled: true } })
  if (!isOriginalCanonicalExclusion(owner.artifacts)) throw new TypeError('Original canonical legacy backend required')
  owner.artifacts!.assertOriginal()
  const absence = Object.getOwnPropertyDescriptor(backend, 'assertLegacyTargetAvailable')
  if (!absence || !('value' in absence) || typeof absence.value !== 'function' || absence.writable || absence.configurable) throw new TypeError('Original legacy namespace assertion required')
  const documents = createDocuments(backend, owner, () => {})
  const archiveReads = attachArchiveReadResources(backend)
  let closed = false
  return Object.freeze({
    async read(id: string) {
      archiveReads?.assertPublicReadAdmission()
      const source = await backend.read(id)
      archiveReads?.assertPublicReadAdmission()
      return source
    },
    list: () => backend.list(),
    readDocument: (key: string) => backend.getDocument(key),
    migrate<T>(id: string, publish: (source: LegacySession | undefined) => Promise<T>): Promise<T> {
      if (closed) return Promise.reject(new Error('Legacy migration owner is closed'))
      const work = () => owner.withSessionOperation(id, async () => {
        const claim = await owner.borrowOwnership(id)
        try {
          claim.assertHeld()
          let source: LegacySession | undefined
          try { source = await backend.read(id) }
          catch (error) {
            if ((error as NodeJS.ErrnoException | null | undefined)?.code !== 'ENOENT') throw error
            await Reflect.apply(absence.value, backend, [id])
          }
          claim.assertHeld()
          return await publish(source)
        } finally { await claim.release() }
      })
      return archiveReads ? archiveReads.withMutationRead(id, work) : work()
    },
    withDocuments<T>(keys: readonly string[], work: () => Promise<T>): Promise<T> {
      if (closed) return Promise.reject(new Error('Legacy document owner is closed'))
      return documents.withDocumentLeases(keys, work, true)
    },
    async close() {
      closed = true
      archiveReads?.fence()
      await Promise.allSettled([...owner.pendingOperations(), documents.pendingWrites()])
      const disposalFailures: unknown[] = []
      try { await documents.retryDisposals() } catch (error) { disposalFailures.push(error) }
      const results = await Promise.allSettled(owner.releaseHeldLocks())
      const failures = [...disposalFailures, ...results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])]
      try { await archiveReads?.settle() } catch (error) { failures.push(error) }
      if (failures.length) throw new AggregateError(failures, 'Legacy migration ownership cleanup unresolved')
    },
  })
}
