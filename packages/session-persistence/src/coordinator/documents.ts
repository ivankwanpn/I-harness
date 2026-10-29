import type { PersistenceBackend } from "./types.ts"
import type { Ownership } from "./ownership.ts"
import { createBindingObservations } from './binding-observation.ts'
import type { createProcessReadLatches } from './process-read-latches.ts'
import { createTaskDocumentOperations, type TaskDocumentConfiguration } from './task-document-operation.ts'

export function createDocuments(
  backend: Pick<PersistenceBackend, 'putDocument'|'getDocument'> & Partial<Pick<PersistenceBackend, 'profile'|'readDocumentObserved'>>,
  ownership: Pick<Ownership, 'lockEnabled'|'acquireLease'> & Partial<Pick<Ownership, 'pinOwnership'|'withSessionOperation'>>,
  report: (error: unknown) => void,
  processLatches?: ReturnType<typeof createProcessReadLatches>,
  taskConfiguration?: TaskDocumentConfiguration,
) {
  const { lockEnabled, acquireLease } = ownership
  const observations = createBindingObservations(backend, ownership)
  const deletedDocuments = new Set<string>()
  const disposalDebt = new Set<Awaited<ReturnType<Ownership['acquireLease']>>>()
  let docChain: Promise<void> = Promise.resolve()
  const taskOperations = taskConfiguration && ownership.pinOwnership && ownership.withSessionOperation
    ? createTaskDocumentOperations(ownership as Ownership, observations, taskConfiguration, run => { const p = docChain.then(run); docChain = p.then(() => {}, () => {}); return p }, processLatches) : undefined
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
    observations.assertOutsideObservedDocument(key)
    if (deletedDocuments.has(key)) throw new Error('Session document is deleted')
    const token = processLatches?.beginMutation({ sessionIds: [], documentKeys: [key], kind: 'other' })
    let outcome: 'settled' | 'unknown' = 'unknown'
    let admission: ReturnType<typeof observations.beginMutation> | undefined
    try {
      admission = observations.beginMutation([], [key])
      await admission.join()
      if (deletedDocuments.has(key)) throw new Error('Session document is deleted')
      const p = docChain.then(() => {
        if (deletedDocuments.has(key)) throw new Error('Session document is deleted')
        return withDocumentLeases([key], () => backend.putDocument(key, data))
      })
      docChain = p.catch(() => {})
      await p
      outcome = 'settled'
    } finally { try { admission?.finish() } catch (error) { outcome = 'unknown'; throw error } finally { token?.end(outcome) } }
  }
  return {
    observations, withDocumentLeases, taskOperations,
    // Deletion closes this key for this coordinator lifetime; the retained token
    // keeps a later capture from treating the retired document as available.
    closeAdmissions(keys: string[]) { for (const key of keys) { if (!deletedDocuments.has(key)) processLatches?.beginMutation({ sessionIds: [], documentKeys: [key], kind: 'other' }); deletedDocuments.add(key) } },
    pendingWrites: () => docChain,
    async joinTaskDocumentIO() { await taskOperations?.joinTaskDocumentIO() },
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
