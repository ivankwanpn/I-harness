import { retainManagedJournalCleanup, settleManagedJournalCleanup } from '../native-fact-writer-internal.ts'
import {associateArtifactCurrentnessReader,createArtifactCurrentGuard,isArtifactCurrentGuard,withImmediateArtifactCurrentChecks} from './artifact-path-association.ts'
import {runOriginalCurrentnessRead} from '../../../core-session/src/managed/currentness-guards.ts'
import { hasArchiveHistoryPrefixReader } from '../archive-read-internal.ts'
import { createManagedRestoredRead } from './managed-restored-read.ts'
import type { ManagedRestoredContextRead } from '../restored-context-internal.ts'
import type { Session, JournalPrefix } from '@i-harness/core-session'
import { FactRecoveryRequiredError, aggregateErrors } from '@i-harness/core-session'
import type { CoordinatorOptions, PersistenceBackend } from './types.ts'
import type { Ownership } from './ownership.ts'
import type { Mutations } from './mutations.ts'
import { beginManagedTaskMetadataUpdate, captureManagedTaskParentReadiness,originalManagedExecution, invalidateManagedMetadataWitness, createManagedDocument, bindManagedRestoredStage, captureManagedRequiredParent, captureManagedProcessRead } from './managed-document.ts'
import {createManagedExecutionSource} from './managed-execution-source.ts'
import {hasExecutionDependencies,type ManagedExecutionAttachment} from '../execution-internal.ts'
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
  const foldFactory = options?.originalExecutionFoldFactory
  for (const value of [options?.maxPendingGroups, options?.coalesceTargetBytes]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new TypeError('Managed scheduling options must be positive safe integers')
  }
  const documents = new Map<string, ManagedEntry>()
  const executions=new WeakMap<ManagedEntry,{source:ReturnType<typeof createManagedExecutionSource>;attachment?:ManagedExecutionAttachment;read?:ManagedRestoredContextRead}>()
  const restoredEntries = new WeakMap<ManagedEntry, ReturnType<typeof createManagedRestoredRead>>()
  const restoredBindings = new WeakSet<ManagedDocument>()
  function bindRestored(entry:ManagedEntry,document:ManagedDocument){const restored=restoredEntries.get(entry);if(restored&&!restoredBindings.has(document)){bindManagedRestoredStage(document,ownership,restored.stage);restoredBindings.add(document)}}
  const resolved = new Map<string, ReturnType<typeof createManagedDocument>>()
  const documentEntries = new WeakMap<object, { id: string; entry: ManagedEntry }>()
  const hasJournalDebt = (entry: ManagedEntry) => [...(entry.journalCleanup?.values() ?? [])].some(scope => scope.hasDebt())
  function primeJournalMutation(id: string, entry: ManagedEntry) {
    if (!processLatches) return
    const original = entry.journalMutation ??= {
      token: processLatches.beginMutation({sessionIds:[id],documentKeys:[],kind:'other'}),
      users: 0,
      unknown: false,
      finished: false,
    }
    return original
  }
  function beginJournalMutation(id: string, entry: ManagedEntry) {
    const original = primeJournalMutation(id, entry)
    if (!original) return
    original.users++
    return original
  }
  function finishJournalMutation(entry: ManagedEntry, original: ManagedEntry['journalMutation'], outcome: 'settled' | 'unknown') {
    if (!original) return
    if (entry.journalMutation !== original || original.users <= 0) throw new Error('Original journal mutation required')
    original.users--
    completeJournalMutation(entry,original,outcome)
  }
  function completeJournalMutation(entry: ManagedEntry, original: NonNullable<ManagedEntry['journalMutation']>, outcome: 'settled' | 'unknown') {
    const debt = hasJournalDebt(entry)
    if (outcome === 'unknown' && !debt) original.unknown = true
    if (original.users || debt) return
    original.token.end(original.unknown ? 'unknown' : 'settled')
    original.finished = true
    entry.journalMutation = undefined
  }
  function attach(id:string,entry:ManagedEntry,session:Session|undefined,prefix:JournalPrefix,execution?:Parameters<typeof createManagedDocument>[11]) {
    if(entry.document)return entry.document
    const document=createManagedDocument(id,session,prefix,backend,ownership,options,report,
      entry.bootstrap ? {operationId:entry.bootstrap.invocation.operationId,bind(control){entry.control=control}} : entry.selected ? {operationId:entry.selected.route.request.invocation.operationId,selected:true,bind(control){entry.control=control}} : undefined, processLatches, () => assertTaskOutside(id), executionChanges,execution,entry.journalCleanup ??= new Map())
    entry.document=document
    if(!execution)bindRestored(entry,document)
    documentEntries.set(document,{id,entry})
    const revoke=document.revokeNewWork
    const revokeAttached=()=>{assertTaskOutside(id);void revokeTaskOperations(id);markManagedEntryRevoked(entry);revoke()}
    document.revokeNewWork=revokeAttached
    const close=document.close
    let closeFlight:Promise<void>|undefined,closeComplete=false
    document.close=async()=>{
      // Refuse self-use before tokens, revocation or cleanup; all attached closes
      // share this wrapper rather than recursively entering closeOne.
      assertTaskOutside(id)
      bootstrap.assertOutsideCapture(id)
      if(closeComplete)return
      if(closeFlight)return closeFlight
      let token=entry.selected?.cold&&entry.selected.processToken ? undefined : beginJournalMutation(id,entry)
      let outcome:'settled'|'unknown'='unknown'
      const flight=(async()=>{
        try {
          markManagedEntryRevoked(entry)
          revokeAttached()
          await entry.flight?.catch(()=>{})
          await settleManagedJournalCleanup(entry.journalCleanup)
          await bootstrap.settleCapture(entry)
          if(entry.headerUnknown)throw new FactRecoveryRequiredError()
          await bootstrap.settlePendingFacts(entry)
          const cleanup=await Promise.allSettled([restoredEntries.get(entry)?.close(),(async()=>{await revokeTaskOperations(id);await close()})()]);const errors=cleanup.flatMap(result=>result.status==='rejected'?[result.reason]:[]);if(errors.length)throw aggregateErrors(errors,'Managed restored read/document cleanup unresolved');await settleManagedJournalCleanup(entry.journalCleanup);await bootstrap.releaseCapture(entry)
          finishJournalMutation(entry,token,'settled');token=undefined
          if(documents.get(id)===entry&&!entry.journalMutation){documents.delete(id);resolved.delete(id)}
          outcome='settled';closeComplete=true
        }finally{finishJournalMutation(entry,token,outcome)}
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
    let token=entry.selected?.cold&&entry.selected.processToken ? undefined : beginJournalMutation(id,entry)
    let outcome:'settled'|'unknown'='unknown'
    try {
    revokeManagedEntry(entry);await entry.flight?.catch(()=>{});await restoredEntries.get(entry)?.close()
    // The opening flight may have attached this exact entry while close waited.
    const attached=attachedDocument()
    if (attached) {
      await attached.close()
      finishJournalMutation(entry,token,'settled')
      token=undefined
      if(documents.get(id)===entry&&!entry.journalMutation){documents.delete(id);resolved.delete(id)}
      outcome='settled'
      return
    }
    await settleManagedJournalCleanup(entry.journalCleanup)
    await executions.get(entry)?.source.close()
    await bootstrap.settleCapture(entry)
    if(entry.headerUnknown)throw new FactRecoveryRequiredError()
    await bootstrap.settlePendingFacts(entry)
    await settleManagedJournalCleanup(entry.journalCleanup)
    if(entry.selected)await bootstrap.releaseSelected(entry.selected.route,entry.selected.identity);else await bootstrap.releaseCapture(entry)
    finishJournalMutation(entry,token,'settled');token=undefined
    if(documents.get(id)===entry&&!entry.journalMutation)documents.delete(id)
    outcome='settled'
    } finally { finishJournalMutation(entry,token,outcome) }
  }
  const bootstrap=createBootstrapOwner(backend,ownership,documents,attach,mutations,processLatches,transitions,(id,entry)=>{if(documents.get(id)!==entry||!entry.ready||!entry.document)throw new FactRecoveryRequiredError();resolved.set(id,entry.document)},(id,entry)=>{if(documents.get(id)!==entry||entry.ready||!entry.document||entry.revoked)throw new FactRecoveryRequiredError();const document=entry.document;return ()=>{resolved.set(id,document)}})
  function materializeExecution(id:string,existing:ManagedEntry):Promise<ReturnType<typeof createManagedDocument>>{
    const prior = existing.flight
    const operation = (async () => {
      await prior
      if (documents.get(id) !== existing || existing.revoked || !existing.document) throw new FactRecoveryRequiredError()
      const document = existing.document
      if (Object.hasOwn(document, 'view')) return document
      document.assertReady()
      document.assertObservable()
      const original = originalManagedExecution(document, ownership)
      const expected = original.core.prefix
      const archive = await backend.read(id)
      original.assertCurrent()
      original.held.assertHeld()
      retainManagedJournalCleanup(existing.journalCleanup ??= new Map(), backend, id, original.held)
      const actual = await backend.readJournalPrefix!(id, original.held)
      original.assertCurrent()
      document.assertObservable()
      if (documents.get(id) !== existing || existing.revoked || original.core.prefix !== expected
        || archive.version !== original.core.formatVersion || archive.events.length !== expected.eventCount
        || actual.eventCount !== expected.eventCount || actual.bodyBytes !== expected.bodyBytes
        || actual.prefixDigest !== expected.prefixDigest) throw new FactRecoveryRequiredError()
      return original.materialize(archive.events)
    })()
    const flight = operation.then(() => {})
    existing.flight = flight
    void flight.catch(() => {})
    void flight.finally(() => { if (existing.flight === flight) existing.flight = undefined }).catch(() => {})
    return operation
  }
  async function acquireExecution(id:string):Promise<ManagedExecutionAttachment>{
    if(!transitions||!ownership.lockEnabled||!hasExecutionDependencies(backend))throw Object.assign(new Error('Original execution backend unavailable'),{code:'FACT_OWNER_UNSUPPORTED'})
    let entry=documents.get(id);assertEntry(entry)
    if(!entry){entry={};documents.set(id,entry)}
    const original=entry;
    if(original.flight)await original.flight
    if(documents.get(id)!==original||original.revoked)throw new FactRecoveryRequiredError()
    let retained=executions.get(original)
    if(retained?.attachment)return retained.attachment
    if(original.document||restoredEntries.has(original))throw Object.assign(new Error('Original execution attachment requires its original entry construction'),{code:'FACT_OWNER_UNSUPPORTED'})
    if(!retained){const source=createManagedExecutionSource({id,entry:original,backend,ownership,transitions,loadOwned,foldFactory,assertEntry:createArtifactCurrentGuard(()=>{if(documents.get(id)!==original)throw new FactRecoveryRequiredError();assertEntry(original)})});retained={source};executions.set(original,retained)}
    const record=retained;
    const flight=(async()=>{
      const state=await record.source.initialize();
      if(documents.get(id)!==original||original.revoked)throw new FactRecoveryRequiredError()
      const document=attach(id,original,undefined,{...record.source.prefix},{state,held:record.source.held,assertCurrent:record.source.assertCurrent})
      const exact=originalManagedExecution(document,ownership)
      const ready=Object.getOwnPropertyDescriptor(document,'assertReady')?.value
      const stateObserve=Object.getOwnPropertyDescriptor(state,'observe')?.value,current=exact.assertCurrent
      const observe=()=>{
        const read=()=>{if(documents.get(id)!==original||original.revoked)throw new FactRecoveryRequiredError();exact.assertCurrent();document.assertReady();return state.observe()}
        if(isArtifactCurrentGuard(current)&&typeof ready==='function'&&isArtifactCurrentGuard(ready)&&Object.getOwnPropertyDescriptor(exact,'assertCurrent')?.value===current&&Object.getOwnPropertyDescriptor(state,'observe')?.value===stateObserve&&Object.getOwnPropertyDescriptor(document,'assertReady')?.value===ready)return runOriginalCurrentnessRead(ready,read)
        let result:ReturnType<typeof state.observe>;withImmediateArtifactCurrentChecks(()=>{result=read()});return result!
      }
      const attachment:ManagedExecutionAttachment=Object.freeze({identity:state.identity,owner:document,async prepare(){if(this!==attachment)throw TypeError('Original execution receiver required');if(documents.get(id)!==original||original.revoked)throw new FactRecoveryRequiredError();exact.assertCurrent();document.assertReady();return state.prepare()},observe(){if(this!==attachment)throw TypeError('Original execution receiver required');return observe()},async prepareRequest(action:ReturnType<ManagedExecutionAttachment['owner']['beginAction']>){if(this!==attachment)throw TypeError('Original execution receiver required');return ownership.withSessionOperation(id,async()=>{if(documents.get(id)!==original||original.revoked)throw new FactRecoveryRequiredError();exact.assertCurrent();document.assertReady();return state.prepareRequest(action)})},revokeNewWork(){if(this!==attachment)throw TypeError('Original execution receiver required');document.revokeNewWork()},close(){if(this!==attachment)throw TypeError('Original execution receiver required');return closeOne(id)}})
      record.attachment=attachment;
    })();original.flight=flight
    try{await flight;return record.attachment!}finally{if(original.flight===flight)original.flight=undefined}
  }
  return {
    acquireExecution,
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
    captureRequiredParent(owner:import('@i-harness/core-session/internal/execution').ManagedExecutionOwner,source:import('@i-harness/core-session').SettlementFacts<import('@i-harness/core-session').ProducerFactOutcome>) {
      const association=documentEntries.get(owner);if(!association)throw new FactRecoveryRequiredError();const{id,entry}=association,document=entry.document;if(!document||document!==owner)throw new FactRecoveryRequiredError();
      if(entry.revoked||documents.get(id)!==entry||entry.document!==document||!transitions||entry.headerUnknown)throw new FactRecoveryRequiredError();
      const original=captureManagedRequiredParent(document,ownership,source);
      const checkIdentity=()=>{if(documents.get(id)!==entry||entry.document!==document||entry.headerUnknown||((entry.bootstrap||entry.selected)&&!entry.ready))throw new FactRecoveryRequiredError();original.assertOriginal()};const check=()=>{checkIdentity();original.assertCurrent()};check();
      const result=Object.freeze({id,captureWriterRecovery(cause:unknown){
        if(this!==result||documents.get(id)!==entry||entry.document!==document||entry.headerUnknown)throw new FactRecoveryRequiredError();
        const recovered=original.captureWriterRecovery?.(cause);
        if(!recovered)return undefined;
        return ()=>!entry.headerUnknown&&(!documents.has(id)||documents.get(id)===entry)&&entry.document===document&&recovered();
      },assertOriginal(){if(this!==result)throw new TypeError('Invalid required parent');checkIdentity()},async acquireWriter(){if(this!==result)throw new TypeError('Invalid required parent');const lease=await original.acquireWriter();try{check();return lease}catch(error){lease.release();throw error}},async joinIssuedWriter(){if(this!==result)throw new TypeError('Invalid required parent');await original.joinIssuedWriter();check()},assertCurrent(){if(this!==result)throw new TypeError('Invalid required parent');check()},assertTaskV3Parent(){if(this!==result)throw new TypeError('Invalid required parent');check();original.assertTask14Ready()}});return result;
    },
    captureParent(owner: import('@i-harness/core-session/internal/execution').ManagedExecutionOwner) {
      const association = documentEntries.get(owner)
      if (!association) throw new FactRecoveryRequiredError()
      const { id, entry } = association
      const document=entry.document;if(!document||document!==owner)throw new FactRecoveryRequiredError()
      const readiness = captureManagedTaskParentReadiness(document, ownership)
      const check = () => {
        if (documents.get(id) !== entry || entry.document !== document || entry.revoked || ((entry.bootstrap||entry.selected) && !entry.ready)) throw new FactRecoveryRequiredError()
        readiness.assertCurrent()
      }
      check()
      const parent = Object.freeze({ id, assertOriginal(){if(this!==parent||documents.get(id)!==entry||entry.document!==document||entry.headerUnknown)throw new FactRecoveryRequiredError();readiness.assertOriginal()}, assertCurrent() {
        if (this !== parent) throw new TypeError('Invalid parent receiver')
        check()
      }, assertTaskV3Parent() {
        if (this !== parent) throw new TypeError('Invalid parent receiver')
        check()
        if (!transitions || entry.headerUnknown) throw new FactRecoveryRequiredError()
        readiness.assertTask14Ready()
      } })
      const ready=Object.getOwnPropertyDescriptor(document,'assertReady')?.value
      if(executions.has(entry)&&typeof ready==='function'&&isArtifactCurrentGuard(ready)){
        for(const key of ['assertOriginal','assertCurrent','assertTaskV3Parent'])associateArtifactCurrentnessReader(parent,key)
      }
      return parent
    },
    has:(id:string)=>documents.has(id),
    assertMutation(id:string){assertEntry(documents.get(id))},
    beginTaskMetadataUpdate(id:string){
      assertTaskOutside(id);bootstrap.assertOutsideCapture(id);const entry=documents.get(id);assertEntry(entry);const document=entry?.document;if(!entry||!document)return;const original=beginManagedTaskMetadataUpdate(document,ownership);return Object.freeze({before:original.before,after:original.after,finish(success:boolean){original.finish(success&&documents.get(id)===entry&&entry.document===document&&!entry.revoked&&!entry.headerUnknown)}})
    },
    invalidateMetadataWitness(id:string){
      assertTaskOutside(id);bootstrap.assertOutsideCapture(id)
      const entry=documents.get(id);assertEntry(entry)
      if(entry){entry.metadataRevision={};if(entry.document)invalidateManagedMetadataWitness(entry.document,ownership,entry.metadataRevision)}
    },
    revoke(id:string){assertTaskOutside(id);bootstrap.assertOutsideCapture(id);const entry=documents.get(id);if(entry)revokeManagedEntry(entry)},
    async assertObservable(id:string){const entry=documents.get(id);assertEntry(entry);await entry?.flight;entry?.document?.assertObservable()},
    async snapshot(id:string){const entry=documents.get(id);assertEntry(entry);await entry?.flight;if(entry&&executions.has(entry)&&entry.document&&!Object.hasOwn(entry.document,'view'))await materializeExecution(id,entry);entry?.document?.assertObservable();return entry?.document?.view},
    closeOne,
    borrowJournalRetirement(id: string) {
      assertTaskOutside(id)
      bootstrap.assertOutsideCapture(id)
      const entry = documents.get(id)
      if (!entry || (entry.selected?.cold && entry.selected.processToken)) return
      const original = primeJournalMutation(id, entry)
      if (!original) return
      return Object.freeze({ end(outcome: 'settled' | 'unknown') {
        if (original.finished) return
        if (documents.get(id) !== entry || entry.journalMutation !== original) throw new Error('Original journal retirement required')
        completeJournalMutation(entry,original,outcome)
      } })
    },
    async acquireRestoredContext(id:string):Promise<ManagedRestoredContextRead>{
      if(!transitions||!ownership.lockEnabled||!hasArchiveHistoryPrefixReader(backend))throw Object.assign(new Error('Owned restoration source unavailable'),{code:'FACT_OWNER_UNSUPPORTED'})
      let entry=documents.get(id);assertEntry(entry)
      if(entry&&executions.has(entry)){
        const execution=await acquireExecution(id),record=executions.get(entry)!;
        if(!record.read){const read:ManagedRestoredContextRead=Object.freeze({identity:execution.identity,prepare(){if(this!==read)throw TypeError('Original restored receiver required');return execution.prepare()},close(){if(this!==read)throw TypeError('Original restored receiver required');return execution.close()}});record.read=read}return record.read;
      }
      if(!entry){entry={};documents.set(id,entry)}
      const original=entry,prior=entry.flight
      if(prior)await prior
      if(documents.get(id)!==original||original.revoked)throw new FactRecoveryRequiredError()
      assertEntry(original)
      let restored=restoredEntries.get(original)
      if(!restored){restored=createManagedRestoredRead({id,entry:original,backend,ownership,transitions,loadOwned,assertEntry:createArtifactCurrentGuard(()=>{if(documents.get(id)!==original)throw new FactRecoveryRequiredError();assertEntry(original)}),closeEntry:()=>closeOne(id),onValidated(){if(original.document)bindRestored(original,original.document)}});restoredEntries.set(original,restored)}
      const pending=restored.ensure();if(!original.document)original.flight=pending;await pending
      if(documents.get(id)!==original||original.revoked)throw new FactRecoveryRequiredError()
      if(original.document)bindRestored(original,original.document)
      return restored.read
    },
    open(id:string):Promise<ReturnType<typeof createManagedDocument>> {
      if(!ownership.lockEnabled||!backend.appendOwnedBatch||!backend.reconcileOwnedBatch||!backend.readJournalPrefix)return Promise.reject(Object.assign(new Error('Exclusive owned fact backend is required'),{code:'FACT_OWNER_UNSUPPORTED'}))
      const existing=documents.get(id)
      if(existing&&executions.has(existing))return materializeExecution(id,existing)
      if(existing){try{assertEntry(existing)}catch(error){return Promise.reject(error)}
        if (restoredEntries.has(existing) && !existing.document) {
          const prior = existing.flight
          const operation = (async () => {
            await prior
            const { session } = await loadOwned(id)
            return ownership.withSessionOperation(id, async () => {
              if (documents.get(id) !== existing || existing.revoked) throw new FactRecoveryRequiredError()
              const held = heldFactOwner({sessionId:id,incarnation:'restored-compatibility'},ownership,()=>{})
              retainManagedJournalCleanup(existing.journalCleanup ??= new Map(), backend, id, held)
              const prefix = await backend.readJournalPrefix!(id, held)
              return attach(id, existing, session, prefix)
            })
          })()
          existing.flight = operation
          return operation
        }
        return existing.flight ? existing.flight.then(()=>existing.document!) : Promise.resolve(existing.document!)}
      const entry:ManagedEntry={};documents.set(id,entry)
      let token=transitions ? undefined : beginJournalMutation(id,entry)
      const operation=(async()=>{
        const {session}=await loadOwned(id)
        if (transitions) token=beginJournalMutation(id,entry)
        return ownership.withSessionOperation(id,async()=>{
          ownership.assertHeld(id)
          const held=heldFactOwner({sessionId:id,incarnation:'cold-recovery'},ownership,()=>{})
          retainManagedJournalCleanup(entry.journalCleanup ??= new Map(),backend,id,held)
          const prefix=await backend.readJournalPrefix!(id,held)
          if(prefix.eventCount!==session.events.length)throw new Error('Managed recovery archive mismatch')
          const birth=await backend.bootstrapRoutes?.resolveBirth?.(id)
          if(birth)entry.route=captureBootstrapRoute(birth.route)
          return attach(id,entry,session,prefix)
        })
      })()
      const tracked = operation.then(document => {
        finishJournalMutation(entry,token,'settled')
        return document
      }, error => {
        finishJournalMutation(entry,token,'unknown')
        const hasCleanup = hasJournalDebt(entry)
        if (documents.get(id) === entry && !hasCleanup) {
          documents.delete(id)
          resolved.delete(id)
        }
        throw error
      })
      entry.flight=tracked
      return tracked
    },
    async close(){const results=await Promise.allSettled([...documents.keys()].map(closeOne));const errors=results.flatMap(r=>r.status==='rejected'?[r.reason]:[]);if(errors.length)throw new AggregateError(errors,'Managed documents require recovery before close')},
  }
}
