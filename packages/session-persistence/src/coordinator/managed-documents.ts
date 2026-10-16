import type { Session } from '@i-harness/core-session'
import type { CoordinatorOptions, PersistenceBackend } from './types.ts'
import type { Ownership } from './ownership.ts'
import { createManagedDocument } from './managed-document.ts'
import { heldFactOwner } from './fact-owner.ts'

/** Composition registry shares the existing owned load and lane. Completed
 * documents are retained until their explicit lifecycle close, never mirrored. */
export function createManagedDocuments(backend: PersistenceBackend, ownership: Ownership,
  loadOwned: (id: string) => Promise<{ session: Session }>, options: CoordinatorOptions | undefined,
  report: (error: unknown) => void) {
  for (const value of [options?.maxPendingGroups, options?.coalesceTargetBytes]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new TypeError('Managed scheduling options must be positive safe integers')
  }
  type Document = ReturnType<typeof createManagedDocument>
  const documents = new Map<string, Promise<Document>>()
  const resolved = new Map<string, Document>(), revoked = new Set<string>()
  return {
    has: (id: string) => documents.has(id),
    revoke(id: string) { if (documents.has(id)) { revoked.add(id); resolved.get(id)?.revokeNewWork() } },
    async assertObservable(id: string) { (await documents.get(id))?.assertObservable() },
    async snapshot(id: string) { const document = await documents.get(id); document?.assertObservable(); return document?.view },
    async closeOne(id: string) { await (await documents.get(id))?.close() },
    open(id: string): Promise<Document> {
      if (!ownership.lockEnabled || !backend.appendOwnedBatch || !backend.reconcileOwnedBatch || !backend.readJournalPrefix) {
        return Promise.reject(Object.assign(new Error('Exclusive owned fact backend is required'), { code: 'FACT_OWNER_UNSUPPORTED' }))
      }
      const existing = documents.get(id)
      if (existing) return existing
      const operation = (async () => {
        const { session } = await loadOwned(id)
        return ownership.withSessionOperation(id, async () => {
          ownership.assertHeld(id)
          const prefix = await backend.readJournalPrefix!(id, heldFactOwner({ sessionId: id, incarnation: 'cold-recovery' }, ownership, () => {}))
          if (prefix.eventCount !== session.events.length) throw new Error('Managed recovery archive mismatch')
          const document = createManagedDocument(id, session, prefix, backend, ownership, options, report)
          const close = document.close
          document.close = async () => { await close(); if (documents.get(id) === operation) { documents.delete(id); resolved.delete(id); revoked.delete(id) } }
          resolved.set(id, document)
          if (revoked.has(id)) document.revokeNewWork()
          return document
        })
      })()
      documents.set(id, operation)
      operation.catch(() => { if (documents.get(id) === operation) { documents.delete(id); resolved.delete(id); revoked.delete(id) } })
      return operation
    },
    async close() {
      const results = await Promise.allSettled([...documents.values()].map(async document => (await document).close()))
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Managed documents require recovery before close')
      documents.clear()
    },
  }
}
