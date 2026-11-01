import type { Session, JournalPrefix } from '@i-harness/core-session'
import { FactRecoveryRequiredError } from '@i-harness/core-session'
import type { CoordinatorOptions, PersistenceBackend } from './types.ts'
import type { Ownership } from './ownership.ts'
import type { Mutations } from './mutations.ts'
import { invalidateManagedMetadataWitness, createManagedDocument, captureManagedParentReadiness, captureManagedProcessRead } from './managed-document.ts'
import type { ManagedDocument } from './fact-types.ts'
import { heldFactOwner } from './fact-owner.ts'
import { createBootstrapOwner, markManagedEntryRevoked, revokeManagedEntry, type ManagedEntry } from './bootstrap.ts'
import { captureBootstrapRoute } from './bootstrap-route.ts'
import type { createProcessReadLatches } from './process-read-latches.ts'
import type { createColdExecutionWrites } from './cold-execution-writes.ts'
import { captureColdObservationEntry, type ColdSelectedObservation } from './cold-selected-target.ts'
import type { createTaskDocumentTransitions } from './task-document-transition.ts'

/** Sole opening/ready registry. A failed public call cannot evict issued work. */
export function createManagedDocuments(backend: PersistenceBackend, ownership: Ownership,
  loadOwned: (id: string) => Promise<{ session: Session }>, options: CoordinatorOptions | undefined,
  report: (error: unknown) => void, mutations: Mutations, processLatches?: ReturnType<typeof createProcessReadLatches>, assertTaskOutside: (id: string) => void = () => {}, revokeTaskOperations: (id: string) => Promise<void> = async () => {}, transitions?: ReturnType<typeof createTaskDocumentTransitions>, executionChanges?: ReturnType<typeof createColdExecutionWrites>) {
  for (const value of [options?.maxPendingGroups, options?.coalesceTargetBytes]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new TypeError('Managed scheduling options must be positive safe integers')
  }
  const documents = new Map<string, ManagedEntry>()
  const resolved = new Map<string, ReturnType<typeof createManagedDocument>>()
  const documentEntries = new WeakMap<ManagedDocument, { id: string; entry: ManagedEntry }>()
  function attach(id:string,entry:ManagedEntry,session:Session,prefix:JournalPrefix) {
    if(entry.document)return entry.document
    const document=createManagedDocument(id,session,prefix,backend,ownership,options,report,
      entry.bootstrap ? {operationId:entry.bootstrap.invocation.operationId,bind(control){entry.control=control}} : entry.selected ? {operationId:entry.selected.route.request.invocation.operationId,selected:true,bind(control){entry.control=control}} : undefined, processLatches, () => assertTaskOutside(id), executionChanges)
    entry.document=document
    documentEntries.set(document,{id,entry})
    const revoke=document.revokeNewWork
    document.revokeNewWork=()=>{assertTaskOutside(id);void revokeTaskOperations(id);markManagedEntryRevoked(entry);revoke()}
    const close=document.close
    let closeFlight:Promise<void>|undefined,closeComplete=false
    document.close=async()=>{
      // Refuse self-use before tokens, revocation or cleanup; all attached closes
      // share this wrapper rather than recursively entering closeOne.
      assertTaskOutside(id)
      bootstrap.assertOutsideCapture(id)
      if(closeComplete)return
      if(closeFlight)return closeFlight
      const token=entry.selected?.cold&&entry.selected.processToken ? undefined : processLatches?.beginMutation({sessionIds:[id],documentKeys:[],kind:'other'})
      let outcome:'settled'|'unknown'='unknown'
      const flight=(async()=>{
        try {
          revokeManagedEntry(entry)
          await entry.flight?.catch(()=>{})
          await bootstrap.settleCapture(entry)
          if(entry.headerUnknown)throw new FactRecoveryRequiredError()
          await revokeTaskOperations(id);await close();await bootstrap.releaseCapture(entry)
          if(documents.get(id)===entry){documents.delete(id);resolved.delete(id)}
          outcome='settled';closeComplete=true
        }finally{token?.end(outcome)}
      })().finally(()=>{if(closeFlight===flight)closeFlight=undefined})
      closeFlight=flight
      return flight
    }
    if(entry.revoked)document.revokeNewWork()
    if(!entry.bootstrap&&!entry.selected)resolved.set(id,document)
    return document
  }
  function assertEntry(entry:ManagedEntry|undefined) {
    if((entry?.bootstrap||entry?.selected) && !entry.ready)throw new FactRecoveryRequiredError()
  }
  async function closeOne(id:string) {
    assertTaskOutside(id)
    bootstrap.assertOutsideCapture(id)
    const entry=documents.get(id);if(!entry)return
    const attachedDocument=()=>entry.document
    if(entry.document){await entry.document.close();return}
    // Retain the original cold fence across failed cleanup instead of poisoning it.
    const token=entry.selected?.cold&&entry.selected.processToken ? undefined : processLatches?.beginMutation({sessionIds:[id],documentKeys:[],kind:'other'})
    let outcome:'settled'|'unknown'='unknown'
    try {
    revokeManagedEntry(entry);await entry.flight?.catch(()=>{})
    // The opening flight may have attached this exact entry while close waited.
    const attached=attachedDocument()
    if(attached){await attached.close();outcome='settled';return}
    await bootstrap.settleCapture(entry)
    if(entry.headerUnknown)throw new FactRecoveryRequiredError()
    if(entry.selected)await bootstrap.releaseSelected(entry.selected.route,entry.selected.identity);else await bootstrap.releaseCapture(entry)
    if(documents.get(id)===entry)documents.delete(id)
    outcome='settled'
    } finally { token?.end(outcome) }
  }
  const bootstrap=createBootstrapOwner(backend,ownership,documents,attach,mutations,processLatches,transitions,(id,entry)=>{if(documents.get(id)!==entry||!entry.ready||!entry.document)throw new FactRecoveryRequiredError();resolved.set(id,entry.document)},(id,entry)=>{if(documents.get(id)!==entry||entry.ready||!entry.document||entry.revoked)throw new FactRecoveryRequiredError();const document=entry.document;return ()=>{resolved.set(id,document)}})
  return {
    ...bootstrap,
    captureColdObservation(observation: ColdSelectedObservation) {
      const entry = captureColdObservationEntry(observation), association = entry.document && documentEntries.get(entry.document)
      if (!association || association.entry !== entry || documents.get(association.id) !== entry || entry.ready || entry.revoked || !entry.selected?.cold || observation.metadata.sessionId !== association.id) throw new FactRecoveryRequiredError()
      return observation
    },
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
    captureProcessReadById(id: string, documentKeys: readonly string[]) {
      const entry = documents.get(id), document = entry?.document
      if (!entry || !document || entry.revoked || entry.bootstrap || resolved.get(id) !== document) throw new FactRecoveryRequiredError()
      const check = () => { if (documents.get(id) !== entry || entry.document !== document || entry.revoked || entry.bootstrap || resolved.get(id) !== document) throw new FactRecoveryRequiredError() }
      return captureManagedProcessRead(document, ownership, documentKeys, check)
    },
    captureParent(document: ManagedDocument) {
      const association = documentEntries.get(document)
      if (!association) throw new FactRecoveryRequiredError()
      const { id, entry } = association
      const readiness = captureManagedParentReadiness(document, ownership)
      const check = () => {
        if (documents.get(id) !== entry || entry.document !== document || entry.revoked || ((entry.bootstrap||entry.selected) && !entry.ready)) throw new FactRecoveryRequiredError()
        readiness.assertCurrent()
      }
      check()
      const parent = Object.freeze({ id, assertCurrent() {
        if (this !== parent) throw new TypeError('Invalid parent receiver')
        check()
      }, assertTaskV3Parent() {
        if (this !== parent) throw new TypeError('Invalid parent receiver')
        check()
        if (!transitions || entry.headerUnknown) throw new FactRecoveryRequiredError()
        readiness.assertTask14Ready()
      } })
      return parent
    },
    has:(id:string)=>documents.has(id),
    assertMutation(id:string){assertEntry(documents.get(id))},
    invalidateMetadataWitness(id:string){
      assertTaskOutside(id);bootstrap.assertOutsideCapture(id)
      const entry=documents.get(id);assertEntry(entry)
      if(entry){entry.metadataRevision={};if(entry.document)invalidateManagedMetadataWitness(entry.document,ownership,entry.metadataRevision)}
    },
    revoke(id:string){assertTaskOutside(id);bootstrap.assertOutsideCapture(id);const entry=documents.get(id);if(entry)revokeManagedEntry(entry)},
    async assertObservable(id:string){const entry=documents.get(id);assertEntry(entry);await entry?.flight;entry?.document?.assertObservable()},
    async snapshot(id:string){const entry=documents.get(id);assertEntry(entry);await entry?.flight;entry?.document?.assertObservable();return entry?.document?.view},
    closeOne,
    open(id:string):Promise<ReturnType<typeof createManagedDocument>> {
      if(!ownership.lockEnabled||!backend.appendOwnedBatch||!backend.reconcileOwnedBatch||!backend.readJournalPrefix)return Promise.reject(Object.assign(new Error('Exclusive owned fact backend is required'),{code:'FACT_OWNER_UNSUPPORTED'}))
      const existing=documents.get(id)
      if(existing){try{assertEntry(existing)}catch(error){return Promise.reject(error)}return existing.flight ? existing.flight.then(()=>existing.document!) : Promise.resolve(existing.document!)}
      let token=transitions ? undefined : processLatches?.beginMutation({sessionIds:[id],documentKeys:[],kind:'other'})
      const entry:ManagedEntry={};documents.set(id,entry)
      const operation=(async()=>{
        const {session}=await loadOwned(id)
        if (transitions) token=processLatches?.beginMutation({sessionIds:[id],documentKeys:[],kind:'other'})
        return ownership.withSessionOperation(id,async()=>{
          ownership.assertHeld(id)
          const prefix=await backend.readJournalPrefix!(id,heldFactOwner({sessionId:id,incarnation:'cold-recovery'},ownership,()=>{}))
          if(prefix.eventCount!==session.events.length)throw new Error('Managed recovery archive mismatch')
          const birth=await backend.bootstrapRoutes?.resolveBirth?.(id)
          if(birth)entry.route=captureBootstrapRoute(birth.route)
          return attach(id,entry,session,prefix)
        })
      })()
      const tracked=operation.then(document=>{token?.end('settled');return document},error=>{token?.end('unknown');if(documents.get(id)===entry){documents.delete(id);resolved.delete(id)};throw error})
      entry.flight=tracked
      return tracked
    },
    async close(){const results=await Promise.allSettled([...documents.keys()].map(closeOne));const errors=results.flatMap(r=>r.status==='rejected'?[r.reason]:[]);if(errors.length)throw new AggregateError(errors,'Managed documents require recovery before close')},
  }
}
