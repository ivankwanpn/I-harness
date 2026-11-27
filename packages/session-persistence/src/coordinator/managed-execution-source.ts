import {randomUUID} from 'node:crypto'
import {types} from 'node:util'
import {createArtifactCurrentGuard,composeOriginalArtifactGuards,isArtifactCurrentGuard,associateArtifactCurrentnessReader} from './artifact-path-association.ts'
import {originalOwnershipArtifactGuard} from './ownership.ts'
import {FactRecoveryRequiredError,type JournalPrefix,type SessionView} from '@i-harness/core-session'
import {restoreManagedExecutionState} from '@i-harness/core-session/internal/execution'
import type {OriginalConversationRestorationSource} from '@i-harness/core-session/internal/restoration'
import {readArchiveHistoryPrefix,recognizesOriginalCleanHistoryMaterialization} from '../archive-read-internal.ts'
import {openExecutionDependencies} from '../execution-internal.ts'
import {heldFactOwner} from './fact-owner.ts'
import type {PersistenceBackend} from './types.ts'
import type {Ownership} from './ownership.ts'
import type {ManagedEntry} from './bootstrap.ts'
import type {LoadOwnedExecution} from './load.ts'
import type {createTaskDocumentTransitions} from './task-document-transition.ts'

/** One original entry's construction/reader debt, registered before initialize. */
export function createManagedExecutionSource(ports:{id:string;entry:ManagedEntry;backend:PersistenceBackend;ownership:Ownership;transitions:ReturnType<typeof createTaskDocumentTransitions>;loadOwnedExecution:LoadOwnedExecution;foldFactory?:import('@i-harness/core-session/internal/execution').OriginalExecutionFoldFactory;assertEntry():void}){
 const revision=ports.entry.metadataRevision,token=Object.freeze({sessionId:ports.id,incarnation:randomUUID()})
 let retired=false,initial:SessionView|undefined,prefix:JournalPrefix|undefined,formatVersion:number|undefined,header:SessionView['header']
 let proof:{assertCurrent():Promise<void>}|undefined,scope:ReturnType<typeof openExecutionDependencies>|undefined,state:Awaited<ReturnType<typeof restoreManagedExecutionState>>|undefined,flight:Promise<unknown>|undefined
 let initialFailure:{cause:unknown}|undefined
 // Original native resource lifetime survives metadata-read invalidation only.
 const fields=types.isProxy(ports)?undefined:Object.getOwnPropertyDescriptors(ports)
 const data=fields&&Object.values(fields).every(field=>'value'in field),entryMethod=data?fields.assertEntry:undefined
 const entry=data?fields.entry?.value:undefined,ownership=data?fields.ownership?.value:undefined,id=data?fields.id?.value:undefined
 const entryCheck=entryMethod?.value
 const eligible=typeof entryCheck==='function'&&isArtifactCurrentGuard(entryCheck)&&entry&&typeof entry==='object'&&!types.isProxy(entry)&&Object.getPrototypeOf(entry)===Object.prototype
 const ownershipGuard=eligible&&ownership&&typeof id==='string'?originalOwnershipArtifactGuard(ownership,id):undefined
 const local=eligible?createArtifactCurrentGuard(()=>{
  if(Object.values(Object.getOwnPropertyDescriptors(ports)).some(field=>!('value'in field)))throw TypeError('Original execution source inputs changed')
  if(Object.getOwnPropertyDescriptor(ports,'assertEntry')?.value!==entryCheck||ports.entry!==entry||ports.ownership!==ownership||ports.id!==id)throw TypeError('Original execution source inputs changed')
  if(Object.values(Object.getOwnPropertyDescriptors(entry)).some(field=>!('value'in field)))throw TypeError('Original execution entry changed')
  entryCheck!();if(retired||entry.headerUnknown)throw new FactRecoveryRequiredError()
 }):undefined
 const assertOriginal=local&&ownershipGuard?composeOriginalArtifactGuards(local,ownershipGuard):()=>{ports.assertEntry();if(retired||ports.entry.headerUnknown)throw new FactRecoveryRequiredError();ports.ownership.assertHeld(ports.id)}
 const assertCurrent=isArtifactCurrentGuard(assertOriginal)
  ? composeOriginalArtifactGuards(assertOriginal,createArtifactCurrentGuard(()=>{if(entry!.metadataRevision!==revision)throw new FactRecoveryRequiredError()}))
  : ()=>{assertOriginal();if(ports.entry.metadataRevision!==revision)throw new FactRecoveryRequiredError()}
 const held=heldFactOwner(token,ports.ownership,assertOriginal)
 const source:OriginalConversationRestorationSource={
  get formatVersion(){if(formatVersion===undefined)throw new FactRecoveryRequiredError();return formatVersion},get header(){return header},get prefix(){if(!prefix)throw new FactRecoveryRequiredError();return prefix},assertCurrent,
  async consume(accept){
   assertCurrent()
   if(!initial)throw new FactRecoveryRequiredError()
   // This source already owns one immutable history under a held proof.
   // Stage its projection indexes once instead of copying their prefixes per event.
   if(initial.events.length)await accept(initial.events)
   assertCurrent()
  },
  async readEvent(ordinal){
   assertCurrent()
   // Initialization walks the frozen events of the original held history proof.
   // Its prefix is verified before the walk and settle rechecks the filesystem.
   if(initial){
    const event=Number.isSafeInteger(ordinal)&&ordinal>=0?initial.events[ordinal]:undefined
    if(!event||event.seq!==ordinal)throw new FactRecoveryRequiredError()
    return event
   }
   scope??=openExecutionDependencies(ports.backend,ports.id,held,prefix!)
   const event=await scope.readEvent(ordinal)
   assertCurrent()
   return event
  },
  async settle(){if(proof){await proof.assertCurrent();assertCurrent()}if(scope){await scope.close();scope=undefined}assertCurrent()},
  async close(){if(scope){await scope.close();scope=undefined}retired=true;initial=undefined;proof=undefined},
  appendCommitted(batch,receipt){assertCurrent();if(!prefix||batch.key.firstSeq!==prefix.eventCount||batch.key.previousPrefixDigest!==prefix.prefixDigest||receipt.key!==batch.key)throw new FactRecoveryRequiredError();prefix=Object.freeze({eventCount:prefix.eventCount+batch.key.count,bodyBytes:prefix.bodyBytes+batch.bytes.length,prefixDigest:receipt.prefixDigest})},
 }
 Object.freeze(source)
 for(const key of ['prefix','header','formatVersion'] as const)associateArtifactCurrentnessReader(source,key)
 return {
  held,assertCurrent,get prefix(){return source.prefix},
  async initialize(){
   if(initialFailure)throw initialFailure.cause;if(flight){await flight;return state!}if(state)return state
   const pending=ports.loadOwnedExecution(ports.id,async history=>{
     const snapshot=history.initial
     await history.assertCurrent();assertCurrent()
     const read=readArchiveHistoryPrefix(ports.backend,history,held)
     if(read.kind!=='available'||read.prefix.eventCount!==snapshot.events.length)throw new FactRecoveryRequiredError()
     initial=snapshot;proof=history;formatVersion=snapshot.formatVersion;header=snapshot.header;prefix=Object.freeze({...read.prefix})
     const decoded=recognizesOriginalCleanHistoryMaterialization(ports.backend,history)?snapshot:undefined
     state=await restoreManagedExecutionState(source,Object.freeze({token,assertHeld:held.assertHeld,openDependencies(expected:JournalPrefix){assertCurrent();return openExecutionDependencies(ports.backend,ports.id,held,expected)}}),ports.foldFactory,decoded)
     await history.assertCurrent();assertCurrent()
   });flight=pending
   try{await pending;return state!}catch(cause){initialFailure={cause};throw cause}finally{initial=undefined;proof=undefined;flight=undefined}
  },
  async close(){await flight?.catch(()=>{});if(state)await state.close();else await source.close();if(initialFailure)await ports.transitions.joinIO()},
 }
}
