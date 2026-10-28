import type { Session, JournalPrefix } from '@i-harness/core-session'
import { FactRecoveryRequiredError } from '@i-harness/core-session'
import type { CoordinatorOptions, PersistenceBackend } from './types.ts'
import type { Ownership } from './ownership.ts'
import type { Mutations } from './mutations.ts'
import { createManagedDocument, captureManagedParentReadiness, captureManagedProcessRead } from './managed-document.ts'
import type { ManagedDocument } from './fact-types.ts'
import { heldFactOwner } from './fact-owner.ts'
import { createBootstrapOwner, markManagedEntryRevoked, revokeManagedEntry, type ManagedEntry } from './bootstrap.ts'
import { captureBootstrapRoute } from './bootstrap-route.ts'
import type { createProcessReadLatches } from './process-read-latches.ts'

/** Sole opening/ready registry. A failed public call cannot evict issued work. */
export function createManagedDocuments(backend: PersistenceBackend, ownership: Ownership,
  loadOwned: (id: string) => Promise<{ session: Session }>, options: CoordinatorOptions | undefined,
  report: (error: unknown) => void, mutations: Mutations, processLatches?: ReturnType<typeof createProcessReadLatches>) {
  for (const value of [options?.maxPendingGroups, options?.coalesceTargetBytes]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new TypeError('Managed scheduling options must be positive safe integers')
  }
  const documents = new Map<string, ManagedEntry>()
  const resolved = new Map<string, ReturnType<typeof createManagedDocument>>()
  const documentEntries = new WeakMap<ManagedDocument, { id: string; entry: ManagedEntry }>()
  function attach(id:string,entry:ManagedEntry,session:Session,prefix:JournalPrefix) {
    if(entry.document)return entry.document
    const document=createManagedDocument(id,session,prefix,backend,ownership,options,report,
      entry.bootstrap ? {operationId:entry.bootstrap.invocation.operationId,bind(control){entry.control=control}} : undefined, processLatches)
    entry.document=document
    documentEntries.set(document,{id,entry})
    const revoke=document.revokeNewWork
    document.revokeNewWork=()=>{markManagedEntryRevoked(entry);revoke()}
    const close=document.close
    document.close=async()=>{await close();await bootstrap.releaseCapture(entry);if(documents.get(id)===entry){documents.delete(id);resolved.delete(id)}}
    if(entry.revoked)document.revokeNewWork()
    if(!entry.bootstrap)resolved.set(id,document)
    return document
  }
  function assertEntry(entry:ManagedEntry|undefined) {
    if(entry?.bootstrap && !entry.ready)throw new FactRecoveryRequiredError()
  }
  async function closeOne(id:string) {
    bootstrap.assertOutsideCapture(id)
    const entry=documents.get(id);if(!entry)return
    revokeManagedEntry(entry);await entry.flight?.catch(()=>{})
    await bootstrap.settleCapture(entry)
    if(entry.headerUnknown)throw new FactRecoveryRequiredError()
    if(entry.document)await entry.document.close()
    else {await bootstrap.releaseCapture(entry);if(documents.get(id)===entry)documents.delete(id)}
  }
  const bootstrap=createBootstrapOwner(backend,ownership,documents,attach,mutations)
  return {
    ...bootstrap,
    captureProcessRead(document: ManagedDocument, documentKeys: readonly string[]) {
      const association = documentEntries.get(document)
      if (!association) throw new FactRecoveryRequiredError()
      const { id, entry } = association
      const check = () => {
        if (documents.get(id) !== entry || entry.document !== document || entry.revoked || entry.bootstrap) throw new FactRecoveryRequiredError()
      }
      check()
      return captureManagedProcessRead(document, ownership, documentKeys, check)
    },
    captureParent(document: ManagedDocument) {
      const association = documentEntries.get(document)
      if (!association) throw new FactRecoveryRequiredError()
      const { id, entry } = association
      const readiness = captureManagedParentReadiness(document, ownership)
      const check = () => {
        if (documents.get(id) !== entry || entry.document !== document || entry.revoked || (entry.bootstrap && !entry.ready)) throw new FactRecoveryRequiredError()
        readiness.assertCurrent()
      }
      check()
      const parent = Object.freeze({ assertCurrent() {
        if (this !== parent) throw new TypeError('Invalid parent receiver')
        check()
      } })
      return parent
    },
    has:(id:string)=>documents.has(id),
    assertMutation(id:string){assertEntry(documents.get(id))},
    revoke(id:string){bootstrap.assertOutsideCapture(id);const entry=documents.get(id);if(entry)revokeManagedEntry(entry)},
    async assertObservable(id:string){const entry=documents.get(id);assertEntry(entry);await entry?.flight;entry?.document?.assertObservable()},
    async snapshot(id:string){const entry=documents.get(id);assertEntry(entry);await entry?.flight;entry?.document?.assertObservable();return entry?.document?.view},
    closeOne,
    open(id:string):Promise<ReturnType<typeof createManagedDocument>> {
      if(!ownership.lockEnabled||!backend.appendOwnedBatch||!backend.reconcileOwnedBatch||!backend.readJournalPrefix)return Promise.reject(Object.assign(new Error('Exclusive owned fact backend is required'),{code:'FACT_OWNER_UNSUPPORTED'}))
      const existing=documents.get(id)
      if(existing){try{assertEntry(existing)}catch(error){return Promise.reject(error)}return existing.flight ? existing.flight.then(()=>existing.document!) : Promise.resolve(existing.document!)}
      const entry:ManagedEntry={};documents.set(id,entry)
      const operation=(async()=>{
        const {session}=await loadOwned(id)
        return ownership.withSessionOperation(id,async()=>{
          ownership.assertHeld(id)
          const prefix=await backend.readJournalPrefix!(id,heldFactOwner({sessionId:id,incarnation:'cold-recovery'},ownership,()=>{}))
          if(prefix.eventCount!==session.events.length)throw new Error('Managed recovery archive mismatch')
          const birth=await backend.bootstrapRoutes?.resolveBirth?.(id)
          if(birth)entry.route=captureBootstrapRoute(birth.route)
          return attach(id,entry,session,prefix)
        })
      })()
      entry.flight=operation
      operation.catch(()=>{if(documents.get(id)===entry){documents.delete(id);resolved.delete(id)}})
      return operation
    },
    async close(){const results=await Promise.allSettled([...documents.keys()].map(closeOne));const errors=results.flatMap(r=>r.status==='rejected'?[r.reason]:[]);if(errors.length)throw new AggregateError(errors,'Managed documents require recovery before close')},
  }
}
