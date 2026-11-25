import { retainManagedJournalCleanup, settleManagedJournalCleanup } from '../native-fact-writer-internal.ts'
import {associateArtifactCurrentnessReader,createArtifactCurrentGuard,isArtifactCurrentGuard,withImmediateArtifactCurrentChecks} from './artifact-path-association.ts'
import {runOriginalCurrentnessRead} from '../../../core-session/src/managed/currentness-guards.ts'
import { hasArchiveHistoryPrefixReader, originalColdArchiveHistoryReader } from '../archive-read-internal.ts'
import { createManagedRestoredRead, sameArchivePrefix } from './managed-restored-read.ts'
import type { ManagedRestoredContextRead } from '../restored-context-internal.ts'
import type { Session, JournalPrefix, OwnedSessionHistoryPage, SessionHistoryPageOptions } from '@i-harness/core-session'
import { FactRecoveryRequiredError, aggregateErrors, freezeJsonData } from '@i-harness/core-session'
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
import type { LoadOwnedExecution } from './load.ts'

/** The writer proves its own durable prefix. A native load can also identify
 * which prefix supplied the bodies that are about to be attached. */
class RecoveryArchiveMismatch extends Error {
  constructor() { super('Managed recovery archive mismatch') }
}
function assertRecoveryArchive(session: Session, observed: Readonly<JournalPrefix> | undefined, actual: JournalPrefix) {
  if (actual.eventCount !== session.events.length || observed && !sameArchivePrefix(observed, actual)) throw new RecoveryArchiveMismatch()
}

/** Sole opening/ready registry. A failed public call cannot evict issued work. */
export function createManagedDocuments(backend: PersistenceBackend, ownership: Ownership,
  loadOwned: (id: string, retainArchivePrefix?: boolean) => Promise<{ session: Session; readonly archivePrefix?: Readonly<JournalPrefix> }>, options: CoordinatorOptions | undefined,
  report: (error: unknown) => void, mutations: Mutations, processLatches?: ReturnType<typeof createProcessReadLatches>, assertTaskOutside: (id: string) => void = () => {}, revokeTaskOperations: (id: string) => Promise<void> = async () => {}, transitions?: ReturnType<typeof createTaskDocumentTransitions>, executionChanges?: ReturnType<typeof createColdExecutionWrites>, loadOwnedExecution?: LoadOwnedExecution) {
  const foldFactory = options?.originalExecutionFoldFactory
  for (const value of [options?.maxPendingGroups, options?.coalesceTargetBytes]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new TypeError('Managed scheduling options must be positive safe integers')
  }
  const documents = new Map<string, ManagedEntry>()
  const executions=new WeakMap<ManagedEntry,{source:ReturnType<typeof createManagedExecutionSource>;attachment?:ManagedExecutionAttachment;read?:ManagedRestoredContextRead}>()
  const restoredEntries = new WeakMap<ManagedEntry, ReturnType<typeof createManagedRestoredRead>>()
  const restoredBindings = new WeakSet<ManagedDocument>()
  const compatibilityOpenings = new WeakMap<ManagedEntry, Promise<ReturnType<typeof createManagedDocument>>>()
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
  function attach(id:string,entry:ManagedEntry,session:Session|undefined,prefix:JournalPrefix,execution?:Parameters<typeof createManagedDocument>[11],selectedOperationId?:string) {
    if(entry.document)return entry.document
    const document=createManagedDocument(id,session,prefix,backend,ownership,options,report,
      entry.bootstrap ? {operationId:entry.bootstrap.invocation.operationId,bind(control){entry.control=control}} : entry.selected ? {operationId:entry.selected.route.request.invocation.operationId,selected:true,bind(control){entry.control=control}} : selectedOperationId!==undefined ? {operationId:selectedOperationId,selected:true,bind(control){entry.control=control}} : undefined, processLatches, () => assertTaskOutside(id), executionChanges,execution,entry.journalCleanup ??= new Map())
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
  /** A selected-results (v3) durable birth owns a dedicated journal lane. Any
   * later execution attachment must re-bind that original lane before its first
   * fact admission; the ordinary journal writer refuses a v3 birth. */
  function selectedExecutionOperationId(state:{readonly header?:{readonly semanticSeed?:{readonly version?:number;readonly operationId?:string}}|undefined}):string|undefined {
    const seed=state.header?.semanticSeed
    return seed?.version===3&&typeof seed.operationId==='string'&&seed.operationId.length>0?seed.operationId:undefined
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
  function readPrivateExecution<T>(
    id: string,
    existing: ManagedEntry,
    readPrivate: (original: ReturnType<typeof originalManagedExecution>, assertCurrent: () => void) => Promise<T>,
    readMaterialized: (document: ReturnType<typeof createManagedDocument>) => T,
  ): Promise<T> {
    if (!existing.document || !Object.hasOwn(existing.document, 'view')) ownership.assertOutsideSessionOperation(id)
    const prior = existing.flight
    const operation = (async () => {
      await prior
      if (documents.get(id) !== existing || existing.revoked || !existing.document) throw new FactRecoveryRequiredError()
      const document = existing.document
      if (Object.hasOwn(document, 'view')) return readMaterialized(document)
      const original = originalManagedExecution(document, ownership)
      const assertCurrent = () => {
        if (documents.get(id) !== existing || existing.revoked || existing.document !== document) throw new FactRecoveryRequiredError()
        original.assertCurrent()
        original.held.assertHeld()
        document.assertObservable()
      }
      const read = async () => {
        assertCurrent()
        document.assertReady()
        return readPrivate(original, assertCurrent)
      }
      return original.readDuringPreparation(read) ?? ownership.withSessionOperation(id, read)
    })()
    const flight = operation.then(() => {})
    existing.flight = flight
    void flight.catch(() => {})
    void flight.finally(() => { if (existing.flight === flight) existing.flight = undefined }).catch(() => {})
    return operation
  }
  function materializeExecution(id: string, existing: ManagedEntry): Promise<ReturnType<typeof createManagedDocument>> {
    return readPrivateExecution(id, existing, async (original, assertCurrent) => {
      const expected = original.core.prefix
      const archive = await backend.read(id)
      assertCurrent()
      const actual = await original.readOwnedPrefix()
      assertCurrent()
      if (original.core.prefix !== expected || archive.version !== original.core.formatVersion
        || archive.events.length !== expected.eventCount || actual.eventCount !== expected.eventCount
        || actual.bodyBytes !== expected.bodyBytes || actual.prefixDigest !== expected.prefixDigest) throw new FactRecoveryRequiredError()
      return original.materialize(archive.events)
    }, document => document)
  }
  async function acquireExecution(id:string):Promise<ManagedExecutionAttachment>{
    if(!transitions||!loadOwnedExecution||!ownership.lockEnabled||!hasExecutionDependencies(backend))throw Object.assign(new Error('Original execution backend unavailable'),{code:'FACT_OWNER_UNSUPPORTED'})
    let entry=documents.get(id);assertEntry(entry)
    if(!entry){entry={};documents.set(id,entry)}
    const original=entry;
    if(original.flight)await original.flight
    if(documents.get(id)!==original||original.revoked)throw new FactRecoveryRequiredError()
    let retained=executions.get(original)
    if(retained?.attachment)return retained.attachment
    if(original.document||restoredEntries.has(original))throw Object.assign(new Error('Original execution attachment requires its original entry construction'),{code:'FACT_OWNER_UNSUPPORTED'})
    if(!retained){const source=createManagedExecutionSource({id,entry:original,backend,ownership,transitions,loadOwnedExecution,foldFactory,assertEntry:createArtifactCurrentGuard(()=>{if(documents.get(id)!==original)throw new FactRecoveryRequiredError();assertEntry(original)})});retained={source};executions.set(original,retained)}
    const record=retained;
    const flight=(async()=>{
      const state=await record.source.initialize();
      if(documents.get(id)!==original||original.revoked)throw new FactRecoveryRequiredError()
      const selectedOperationId=selectedExecutionOperationId(state)
      const document=attach(id,original,undefined,{...record.source.prefix},{state,held:record.source.held,assertCurrent:record.source.assertCurrent},selectedOperationId)
      if(selectedOperationId!==undefined){
        // A selected-results (v3) birth is written only through the selected
        // journal lane, exactly like the fork's own capture. A fresh execution
        // attachment must bind that lane before it may admit any fact, or the
        // ordinary journal writer would refuse/absent its first batch.
        if(!original.control?.bindSelected)throw new FactRecoveryRequiredError()
        await original.control.bindSelected()
        if(documents.get(id)!==original||original.revoked)throw new FactRecoveryRequiredError()
        original.control.ready()
        document.assertReady()
      }
      const exact=originalManagedExecution(document,ownership)
      const ready=Object.getOwnPropertyDescriptor(document,'assertReady')?.value
      const stateObserve=Object.getOwnPropertyDescriptor(state,'observe')?.value,current=exact.assertCurrent
      const observe=()=>{
        const read=()=>{if(documents.get(id)!==original||original.revoked)throw new FactRecoveryRequiredError();exact.assertCurrent();document.assertReady();return state.observe()}
        if(isArtifactCurrentGuard(current)&&typeof ready==='function'&&isArtifactCurrentGuard(ready)&&Object.getOwnPropertyDescriptor(exact,'assertCurrent')?.value===current&&Object.getOwnPropertyDescriptor(state,'observe')?.value===stateObserve&&Object.getOwnPropertyDescriptor(document,'assertReady')?.value===ready)return runOriginalCurrentnessRead(ready,read)
        let result:ReturnType<typeof state.observe>;withImmediateArtifactCurrentChecks(()=>{result=read()});return result!
      }
      const attachment:ManagedExecutionAttachment=Object.freeze({identity:state.identity,owner:document,async prepare(){if(this!==attachment)throw TypeError('Original execution receiver required');if(documents.get(id)!==original||original.revoked)throw new FactRecoveryRequiredError();exact.assertCurrent();document.assertReady();return retryArchiveRead(() => state.prepare())},observe(){if(this!==attachment)throw TypeError('Original execution receiver required');return observe()},async prepareRequest(action:ReturnType<ManagedExecutionAttachment['owner']['beginAction']>){if(this!==attachment)throw TypeError('Original execution receiver required');return ownership.withSessionOperation(id,async()=>{if(documents.get(id)!==original||original.revoked)throw new FactRecoveryRequiredError();exact.assertCurrent();document.assertReady();return state.prepareRequest(action)})},revokeNewWork(){if(this!==attachment)throw TypeError('Original execution receiver required');document.revokeNewWork()},close(){if(this!==attachment)throw TypeError('Original execution receiver required');return closeOne(id)}})
      record.attachment=attachment;
    })();original.flight=flight
    try{await flight;return record.attachment!}finally{if(original.flight===flight)original.flight=undefined}
  }
  return {
    acquireExecution,
    async closeBirthDocument(id: string) {
      const entry = documents.get(id)
      if (!entry || executions.has(entry)) return
      await closeOne(id)
    },
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
    async captureProcessReadById(id: string, documentKeys: readonly string[]) {
      const entry = documents.get(id), document = entry?.document
      if (!entry || !document || entry.revoked || entry.bootstrap || resolved.get(id) !== document) throw new FactRecoveryRequiredError()
      const check = () => { if (documents.get(id) !== entry || entry.document !== document || entry.revoked || entry.bootstrap || resolved.get(id) !== document) throw new FactRecoveryRequiredError() }
      if (executions.has(entry) && !Object.hasOwn(document, 'view')) {
        return readPrivateExecution(id, entry, (original, assertCurrent) => original.captureProcess(documentKeys, check, async () => {
          const read = originalColdArchiveHistoryReader(backend)
          if (!read?.readSealedHistory) throw new FactRecoveryRequiredError()
          const expected = original.core.prefix
          const archive = await read.readSealedHistory(id)
          assertCurrent()
          const header = original.core.header
          if (!archive || originalColdArchiveHistoryReader(backend) !== read || original.core.prefix !== expected
            || archive.version !== original.core.formatVersion || archive.meta?.semanticSeed !== undefined
            || archive.meta?.parentSession !== header?.parentSession || archive.meta?.seedLength !== header?.seedLength
            || archive.prefix.eventCount !== expected.eventCount || archive.prefix.bodyBytes !== expected.bodyBytes
            || archive.prefix.prefixDigest !== expected.prefixDigest || archive.events.some((event, ordinal) => event.seq !== ordinal)) throw new FactRecoveryRequiredError()
          return freezeJsonData({ formatVersion: archive.version, ...(header ? { header } : {}), events: archive.events })
        }), current => captureManagedProcessRead(current, ownership, documentKeys, check))
      }
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
      },assertOriginal(){if(this!==result)throw new TypeError('Invalid required parent');checkIdentity()},async acquireWriter(){if(this!==result)throw new TypeError('Invalid required parent');const lease=await original.acquireWriter();try{check();return lease}catch(error){lease.release();throw error}},joinIssuedWriter(read?:()=>void){if(this!==result)throw new TypeError('Invalid required parent');return original.joinIssuedWriter(()=>{check();read?.()})},assertCurrent(){if(this!==result)throw new TypeError('Invalid required parent');check()},assertTaskV3Parent(){if(this!==result)throw new TypeError('Invalid required parent');check();original.assertTask14Ready()}});return result;
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
    async readHistoryPage(id: string, options: SessionHistoryPageOptions): Promise<OwnedSessionHistoryPage | undefined> {
      const entry = documents.get(id)
      assertEntry(entry)
      if (!entry || !executions.has(entry)) return undefined
      return readPrivateExecution<OwnedSessionHistoryPage | undefined>(id, entry, async (original, assertCurrent) => {
        const observation = original.core.observe()
        const page = await observation.readHistoryPage(options)
        observation.assertCurrent()
        assertCurrent()
        return page
      }, () => undefined)
    },
    async snapshot(id:string){
      const entry=documents.get(id);assertEntry(entry)
      if(entry&&executions.has(entry)&&(!entry.document||!Object.hasOwn(entry.document,'view')))ownership.assertOutsideSessionOperation(id)
      await entry?.flight
      if(entry&&executions.has(entry)&&entry.document&&!Object.hasOwn(entry.document,'view'))await materializeExecution(id,entry)
      entry?.document?.assertObservable();return entry?.document?.view
    },
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
      if (!restored) {
        const reader = createManagedRestoredRead({ id, entry: original, backend, ownership, transitions, loadOwned,
          assertEntry: createArtifactCurrentGuard(() => {
            if (documents.get(id) !== original) throw new FactRecoveryRequiredError()
            assertEntry(original)
          }),
          async closeEntry() {
            if (documents.get(id) === original && restoredEntries.get(original) === reader) await closeOne(id)
          },
          onValidated() { if (original.document) bindRestored(original, original.document) },
        })
        restoredEntries.set(original, reader)
        restored = reader
      }
      const pending=restored.ensure();if(!original.document)original.flight=pending;await pending
      if(documents.get(id)!==original||original.revoked)throw new FactRecoveryRequiredError()
      if(original.document)bindRestored(original,original.document)
      return restored.read
    },
    open(id:string):Promise<ReturnType<typeof createManagedDocument>> {
      if(!ownership.lockEnabled||!backend.appendOwnedBatch||!backend.reconcileOwnedBatch||!backend.readJournalPrefix)return Promise.reject(Object.assign(new Error('Exclusive owned fact backend is required'),{code:'FACT_OWNER_UNSUPPORTED'}))
      const existing=documents.get(id)
      if(existing&&executions.has(existing))return materializeExecution(id,existing)
      if (existing) {
        try { assertEntry(existing) } catch (error) { return Promise.reject(error) }
        const opening = compatibilityOpenings.get(existing)
        if (opening) return opening
        if (existing.document || !restoredEntries.has(existing)) {
          return existing.flight ? existing.flight.then(() => existing.document!) : Promise.resolve(existing.document!)
        }
      }
      const entry: ManagedEntry = existing ?? {}
      if (!existing) documents.set(id, entry)
      const prior = entry.flight
      const restored = restoredEntries.get(entry)
      let token=transitions ? undefined : beginJournalMutation(id,entry)
      const operation=(async()=>{
        if (prior) await prior
        const { session, archivePrefix } = await loadOwned(id, true)
        // Retire any previous reader of a replaced log before the writer
        // takes the session lane. Retain its mapping if cleanup does not settle.
        if (archivePrefix && restored && !restored.matchesPrefix(archivePrefix)) {
          await restored.close()
          if (restoredEntries.get(entry) === restored) restoredEntries.delete(entry)
        }
        if (transitions) token=beginJournalMutation(id,entry)
        return ownership.withSessionOperation(id,async()=>{
          if (documents.get(id) !== entry || entry.revoked) throw new FactRecoveryRequiredError()
          ownership.assertHeld(id)
          const incarnation = restored ? 'restored-compatibility' : 'cold-recovery'
          const held = heldFactOwner({ sessionId: id, incarnation }, ownership, () => {})
          retainManagedJournalCleanup(entry.journalCleanup ??= new Map(),backend,id,held)
          const prefix=await backend.readJournalPrefix!(id,held)
          try { assertRecoveryArchive(session, archivePrefix, prefix) }
          catch (error) {
            if (!entry.journalCleanup?.get(held.owner)?.hasDebt()) entry.journalCleanup?.delete(held.owner)
            throw error
          }
          if (!restoredEntries.has(entry)) {
            const birth = await backend.bootstrapRoutes?.resolveBirth?.(id)
            if (birth) entry.route = captureBootstrapRoute(birth.route)
          }
          return attach(id,entry,session,prefix)
        })
      })()
      const tracked = operation.then(document => {
        finishJournalMutation(entry,token,'settled')
        return document
      }, error => {
        // A successful prefix read followed by a local mismatch has no
        // uncertain writer disposition. A new load may observe the new file.
        finishJournalMutation(entry, token, error instanceof RecoveryArchiveMismatch ? 'settled' : 'unknown')
        if (documents.get(id) === entry && !hasJournalDebt(entry)) {
          if (!restoredEntries.has(entry)) {
            documents.delete(id)
            resolved.delete(id)
          } else if (error instanceof RecoveryArchiveMismatch) {
            entry.flight = prior
          }
        }
        throw error
      }).finally(() => compatibilityOpenings.delete(entry))
      compatibilityOpenings.set(entry, tracked)
      entry.flight=tracked
      return tracked
    },
    async close(){const results=await Promise.allSettled([...documents.keys()].map(closeOne));const errors=results.flatMap(r=>r.status==='rejected'?[r.reason]:[]);if(errors.length)throw new AggregateError(errors,'Managed documents require recovery before close')},
  }
}

/** A dependency read can race a same-writer append between opening its extent
 * and the final size check. Re-open the read with a fresh extent (bounded);
 * the archive reader still rejects a genuinely changed archive after the bound. */
async function retryArchiveRead<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await read() }
    catch (error) {
      const message = String((error as { message?: unknown } | null)?.message ?? error)
      if (attempt >= 2 || !/archive (?:observation )?changed/i.test(message)) throw error
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
  }
}
