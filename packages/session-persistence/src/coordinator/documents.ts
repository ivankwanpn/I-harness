import type { PersistenceBackend } from "./types.ts"
import type { Ownership } from "./ownership.ts"
import { createBindingObservations } from './binding-observation.ts'

export function createDocuments(
  backend: Pick<PersistenceBackend, 'putDocument'|'getDocument'> & Partial<Pick<PersistenceBackend, 'profile'|'readDocumentObserved'>>,
  ownership: Pick<Ownership, 'lockEnabled'|'acquireLease'> & Partial<Pick<Ownership, 'pinOwnership'|'withSessionOperation'>>,
  report: (error: unknown) => void,
) {
  const { lockEnabled, acquireLease } = ownership
  const observations = createBindingObservations(backend, ownership)
  const deletedDocuments = new Set<string>()
  const disposalDebt = new Set<Awaited<ReturnType<Ownership['acquireLease']>>>()
  let docChain: Promise<void> = Promise.resolve()
  async function withDocumentLeases<T>(keys: readonly string[], run: () => Promise<T>): Promise<T> {
    const locks: Awaited<ReturnType<Ownership['acquireLease']>>[] = []
    let result: T | undefined, failure: unknown, failed = false
    try {
      if (lockEnabled) for (const key of [...new Set(keys)].sort()) locks.push(await acquireLease(`doc:${key}`))
      result = await run()
    } catch (error) { failed = true; failure = error }
    const errors: unknown[] = []
    for (const lock of locks.reverse()) try { await lock.release() } catch (error) { disposalDebt.add(lock); errors.push(error) }
    if (errors.length) throw new AggregateError([...(failed ? [failure] : []), ...errors], 'Document lease cleanup failed')
    if (failed) throw failure
    return result as T
  }
  async function putDocumentStrict(key: string, data: unknown) {
    if (deletedDocuments.has(key)) throw new Error('Session document is deleted')
    const admission = observations.beginMutation([], [key])
    try {
      await admission.join()
      if (deletedDocuments.has(key)) throw new Error('Session document is deleted')
      const p = docChain.then(() => {
        if (deletedDocuments.has(key)) throw new Error('Session document is deleted')
        return withDocumentLeases([key], () => backend.putDocument(key, data))
      })
      docChain = p.catch(() => {})
      await p
    } finally { admission.finish() }
  }
  return {
    observations, withDocumentLeases,
    closeAdmissions(keys: string[]) { for (const key of keys) deletedDocuments.add(key) },
    pendingWrites: () => docChain,
    putDocumentStrict,
    async putDocument(key: string, data: unknown) { observations.assertOutsideObservedDocument(key); try { await putDocumentStrict(key, data) } catch (error) { report(error) } },
    async getDocument(key: string) { return backend.getDocument(key) },
    async retryDisposals() {
      const failures: unknown[] = []
      for (const lock of disposalDebt) try { await lock.release(); disposalDebt.delete(lock) } catch (error) { failures.push(error) }
      if (failures.length) throw new AggregateError(failures, 'Document lease cleanup is unresolved')
    },
  }
}
export type Documents = ReturnType<typeof createDocuments>
