import type { PersistenceBackend } from "./types.ts"
import type { Ownership, OwnershipCleanup } from "./ownership.ts"
import { createBindingObservations } from './binding-observation.ts'
import type { createProcessReadLatches } from './process-read-latches.ts'
import { createTaskDocumentOperations, type TaskDocumentConfiguration } from './task-document-operation.ts'
import { createTaskDocumentTransitions, type TaskTransitionConfiguration } from './task-document-transition.ts'

export interface DeletionDocumentCleanup { assertCovered(keys: readonly string[]): void; assertSettled(): void; close(): Promise<void> }

export function createDocuments(
  backend: Pick<PersistenceBackend, 'putDocument'|'getDocument'> & Partial<Pick<PersistenceBackend, 'profile'|'readDocumentObserved'>>,
  ownership: Pick<Ownership, 'lockEnabled'|'acquireLease'> & Partial<Pick<Ownership, 'pinOwnership'|'withSessionOperation'|'pinDocumentOwnership'|'pinDocumentOwnershipRetained'|'acquireDocumentLease'|'exclusionScope'|'artifacts'>>,
  report: (error: unknown) => void,
  processLatches?: ReturnType<typeof createProcessReadLatches>,
  taskConfiguration?: TaskDocumentConfiguration,
  transitionConfiguration?: TaskTransitionConfiguration,
) {
  const { lockEnabled, acquireLease } = ownership
  const observations = createBindingObservations(backend, ownership)
  const deletedDocuments = new Set<string>()
  const isDeleted = (key: string) => [...deletedDocuments].some(value => ownership.exclusionScope ? ownership.exclusionScope([], [key]).keys.some(resource => ownership.exclusionScope!([], [value]).keys.includes(resource)) : value === key)
  type Disposal = { pins: Awaited<ReturnType<Ownership['pinDocumentOwnership']>>[]; locks: Awaited<ReturnType<Ownership['acquireLease']>>[]; acquisitions: OwnershipCleanup[] }
  const disposalDebt = new Set<Disposal>()
  function trackLease(raw: Awaited<ReturnType<Ownership['acquireLease']>>) {
    let failed = false, cause: unknown
    const release = raw.release.bind(raw)
    return { get held() { return raw.held }, async release() {
      if (failed && raw.held === false) throw cause
      try { await release(); failed = false } catch (error) { failed = true; cause = error; throw error }
    } }
  }
  async function dispose(record: Disposal) {
    while (record.acquisitions.length) { await record.acquisitions.at(-1)!.close(); record.acquisitions.at(-1)!.assertSettled(); record.acquisitions.pop() }
    record.locks.length = 0; record.pins.length = 0
    disposalDebt.delete(record)
  }
  let docChain: Promise<void> = Promise.resolve()
  const taskOperations = taskConfiguration && ownership.pinOwnership && ownership.withSessionOperation
    ? createTaskDocumentOperations(ownership as Ownership, observations, taskConfiguration, run => { const p = docChain.then(run); docChain = p.then(() => {}, () => {}); return p }, processLatches) : undefined
  const taskTransitions = transitionConfiguration && ownership.pinOwnership && ownership.withSessionOperation
    ? createTaskDocumentTransitions(ownership as Ownership, observations, transitionConfiguration, () => docChain, processLatches) : undefined
  async function withDocumentLeases<T>(keys: readonly string[], run: () => Promise<T>, queued = false, retain?: (cleanup: DeletionDocumentCleanup) => void): Promise<T> {
    const record: Disposal = { pins: [], locks: [], acquisitions: [] }
    async function acquire<T extends { release(): void | Promise<void> }>(start: (retain: (cleanup: OwnershipCleanup) => void) => Promise<T>, protectLease = false): Promise<T> {
      let captured = false
      const resource = await start(cleanup => { captured = true; record.acquisitions.push(cleanup) })
      // Compatibility for a minimal custom Ownership test adapter. The original
      // owner always registers before its first acquisition await.
      if (!captured) { let settled = false; const disposal = protectLease ? trackLease(resource as unknown as Awaited<ReturnType<Ownership['acquireLease']>>) : resource; record.acquisitions.push({ assertSettled() { if (!settled) throw Error('Document cleanup unresolved') }, async close() { await disposal.release(); settled = true } }) }
      return resource
    }
    let active = false
    let captured: ReturnType<NonNullable<typeof ownership.exclusionScope>> | undefined
    const cleanup = Object.freeze({
      assertSettled() { if (this !== cleanup || active || record.locks.length || record.pins.length || record.acquisitions.length) throw new Error('Deletion document cleanup unresolved') },
      assertCovered(requested: readonly string[]) {
        if (this !== cleanup || !active) throw new Error('Deletion document coverage unavailable')
        captured?.assertCurrent()
        const coverage = captured?.keys ?? keys
        const wanted = ownership.exclusionScope?.([], requested)
        wanted?.assertCurrent()
        if ((wanted?.keys ?? requested).some(key => !coverage.includes(key))) throw new Error('Deletion document is not covered')
        for (const pin of record.pins) pin.assertHeld()
        if (record.locks.some(lock => !lock.held)) throw new Error('Deletion document lease unavailable')
      },
      async close() { if (this !== cleanup || active) throw new Error('Deletion document cleanup conflict'); await dispose(record) },
    })
    retain?.(cleanup)
    let result: T | undefined, failure: unknown, failed = false
    let completion: PromiseWithResolvers<void> | undefined
    try {
      if (ownership.artifacts) for (const key of [...new Set(keys)].sort()) await ownership.artifacts.prepareDocument(key)
      const canonical = new Map<string, string>()
      for (const key of keys) canonical.set(ownership.exclusionScope?.([], [key]).keys[0] ?? key, key)
      const ordered = [...canonical].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, key]) => key)
      captured = retain ? ownership.exclusionScope?.([], keys) : undefined
      if (lockEnabled && ownership.pinDocumentOwnership) for (const key of ordered) record.pins.push(await acquire(retain => ownership.pinDocumentOwnershipRetained ? ownership.pinDocumentOwnershipRetained(key, retain) : ownership.pinDocumentOwnership!(key)))
      const execute = async () => {
        if (lockEnabled) for (const key of ordered) record.locks.push(trackLease(await acquire(retain => ownership.acquireDocumentLease ? ownership.acquireDocumentLease(key, retain) : acquireLease('doc:' + key, retain), true)))
        for (const pin of record.pins) pin.assertHeld()
        active = true
        try { return await run() } finally { active = false }
      }
      if (queued) { const p = docChain.then(execute); completion = Promise.withResolvers<void>(); docChain = completion.promise; result = await p } else result = await execute()
    } catch (error) { failed = true; failure = error }
    try { await dispose(record) } catch (error) { disposalDebt.add(record); throw new AggregateError([...(failed ? [failure] : []), error], 'Document lease cleanup failed') } finally { completion?.resolve() }
    if (failed) throw failure
    return result as T
  }
  async function putDocumentStrict(key: string, data: unknown) {
    observations.assertOutsideObservedDocument(key)
    if (isDeleted(key)) throw new Error('Session document is deleted')
    const entryScope = ownership.exclusionScope?.([], [key])
    let writeScope = entryScope
    const token = processLatches?.beginMutation({ sessionIds: [], documentKeys: [key], kind: 'other' })
    let outcome: 'settled' | 'unknown' = 'unknown'
    let admission: ReturnType<typeof observations.beginMutation> | undefined
    let finalAdmission: ReturnType<typeof observations.beginMutation> | undefined
    let finalToken: ReturnType<NonNullable<typeof processLatches>['beginMutation']> | undefined
    try {
      admission = observations.beginMutation([], [key])
      await admission.join()
      if (entryScope?.ready !== false) entryScope?.assertCurrent()
      if (isDeleted(key)) throw new Error('Session document is deleted')
      await ownership.artifacts?.prepareDocument(key)
      if (entryScope?.ready === false) writeScope = ownership.exclusionScope?.([], [key])
      if (writeScope?.ready === false) throw new Error('Document artifact preparation is incomplete')
      writeScope?.assertCurrent()
      finalToken = processLatches?.beginMutation({ sessionIds: [], documentKeys: [key], kind: 'other' })
      finalAdmission = observations.beginMutation([], [key]); await finalAdmission.join()
      writeScope?.assertCurrent()
      await withDocumentLeases([key], () => {
        writeScope?.assertCurrent()
        if (isDeleted(key)) throw new Error('Session document is deleted')
        return backend.putDocument(key, data)
      }, true)
      writeScope?.assertCurrent()
      outcome = 'settled'
    } finally { try { finalToken?.end(outcome); token?.end(outcome) } catch (error) { outcome = 'unknown'; throw error } finally { finalAdmission?.finish(outcome); admission?.finish(outcome) } }
  }
  return {
    withDeletionDocumentLeases<T>(keys: readonly string[], run: () => Promise<T>, retain: (cleanup: DeletionDocumentCleanup) => void) { return withDocumentLeases(keys, run, false, retain) },
    observations, withDocumentLeases, taskOperations, taskTransitions,
    // Deletion closes this key for this coordinator lifetime; the retained token
    // keeps a later capture from treating the retired document as available.
    closeAdmissions(keys: string[]) { for (const key of keys) { if (!isDeleted(key)) processLatches?.beginMutation({ sessionIds: [], documentKeys: [key], kind: 'other' }); deletedDocuments.add(key) } },
    pendingWrites: () => docChain,
    async joinTaskDocumentIO() { await taskOperations?.joinTaskDocumentIO(); await taskTransitions?.joinIO() },
    putDocumentStrict,
    async putDocument(key: string, data: unknown) { observations.assertOutsideObservedDocument(key); try { await putDocumentStrict(key, data) } catch (error) { report(error) } },
    async getDocument(key: string) { return backend.getDocument(key) },
    async retryDisposals() {
      const failures: unknown[] = []
      for (const record of disposalDebt) try { await dispose(record) } catch (error) { failures.push(error) }
      if (failures.length) throw new AggregateError(failures, 'Document lease cleanup is unresolved')
    },
  }
}
export type Documents = ReturnType<typeof createDocuments>
