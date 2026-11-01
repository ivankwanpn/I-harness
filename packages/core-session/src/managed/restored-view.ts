import type { SessionEventView, EncodedFactBatch, FactReceipt } from './types.ts'
import type { ConversationPayloadCapture } from '../conversation/payload.ts'
import { preparePrunedResultProjection } from '../conversation/payload.ts'
import type { ConversationProjection } from '../conversation/types.ts'
import type { PreparedConversationArchive, PreparedPrunedResult, PreparedResultProjection } from '../conversation/restoration-types.ts'
import type { OriginalConversationRestorationSource } from '../conversation/restoration-input.ts'
import { createConversationValidationScan, takeConversationValidationScan, readConversationDeliveries } from '../conversation/validation.ts'
import { createConversationSourceCoordinates, archiveConversationSources } from '../conversation/sources.ts'
import { createConversationStateIndex, readIndexedConversationState, type ConversationStateRead } from '../conversation/state.ts'
import { createContextStateIndex } from '../projection/context.ts'
import { createPruneDependencyIndex, preparePruneSubstitutes, selectPruneDependencies } from '../projection/pruning.ts'
import { historyVisibility } from '../conversation/history/visibility.ts'
import { renderConversationItems } from '../conversation/render-items.ts'

const failure = (code: string): never => { throw Object.assign(new Error(code), {code}) }
type Candidate = { source: OriginalConversationRestorationSource; owner: object; sessionId: string; index: ReturnType<typeof takeConversationValidationScan>; sources: ReturnType<typeof createConversationSourceCoordinates>; state: ReturnType<typeof createConversationStateIndex>; context: ReturnType<typeof createContextStateIndex>; prune: ReturnType<typeof createPruneDependencyIndex>; installed: boolean; retired: boolean }
const candidates = new WeakMap<object, Candidate>()
type Preparation = { candidate: Candidate; current(): void; archive: {length:number;get(index:number):SessionEventView}; pruned: Map<number,PreparedPrunedResult>; substitutes: Awaited<ReturnType<typeof preparePruneSubstitutes>>; coordinates: ReturnType<Candidate['sources']['read']>; state: object }
const preparations = new WeakMap<object, Preparation>()

/** Full validation is original scan/finish; the candidate keeps no source array. */
export async function restoreManagedConversation(source: OriginalConversationRestorationSource, owner: object, sessionId: string): Promise<object> {
  source.assertCurrent()
  const scan = createConversationValidationScan({formatVersion:source.formatVersion,header:{...source.header,sessionId},readEvent:source.readEvent.bind(source)})
  const sources=createConversationSourceCoordinates(),state=createConversationStateIndex(),context=createContextStateIndex(),prune=createPruneDependencyIndex()
  await source.consume(async unit=>{
    source.assertCurrent();await scan.push(unit);source.assertCurrent()
    sources.stage(unit).commit();state.stage(unit).commit();context.stage(unit).commit();prune.stage(unit).commit()
  })
  const index=takeConversationValidationScan(scan.finish())
  if(index.eventCount!==source.prefix.eventCount)failure('CONVERSATION_RESTORATION_PREFIX_MISMATCH')
  await source.settle();source.assertCurrent()
  const candidate=Object.freeze({})
  candidates.set(candidate,{source,owner,sessionId,index,sources,state,context,prune,installed:false,retired:false})
  return candidate
}
/** Original managed constructor alone consumes its exact owner's candidate. */
export function installRestoredManagedConversation(candidate:object,owner:object) {
  const record=candidates.get(candidate)
  if(!record||record.owner!==owner||record.installed||record.retired)failure('CONVERSATION_RESTORATION_CANDIDATE_INVALID')
  record.source.assertCurrent();record.installed=true
  const owned=record;let revision=0
  const leases=new Set<PreparedConversationArchive>()
  const check=()=>{if(owned.retired)failure('CONVERSATION_RESTORATION_RETIRED');owned.source.assertCurrent()}
  return {
    async prepare():Promise<PreparedConversationArchive>{
      check();const expected=revision,history=owned.index.history(),facts=owned.index.resultFacts(),coordinates=owned.sources.read(),pruneView=owned.prune.read()
      const current=()=>{check();if(revision!==expected)failure('CONVERSATION_PREPARATION_EXPIRED')}
      const wanted=new Set<number>(),callIds=new Set<string>()
      if(history.current)wanted.add(history.current.index)
      for(const item of history.items){wanted.add(item.establishmentIndex);if(item.admissionIndex!==undefined)wanted.add(item.admissionIndex);if(item.imageAdmissionIndex!==undefined)wanted.add(item.imageAdmissionIndex);for(const recipe of item.recipes){if(recipe.index!==undefined)wanted.add(recipe.index);for(const index of recipe.calls??[])wanted.add(index)}}
      for(const index of wanted){const fact=facts[index];if(fact?.type==='tool/result'&&fact.callId)callIds.add(fact.callId)}
      const prunedCalls=selectPruneDependencies(pruneView,callIds)
      const read=async(index:number)=>{current();const event=await owned.source.readEvent(index);current();return event}
      const substitutes=await preparePruneSubstitutes(pruneView,prunedCalls,read)
      const full=new Map<number,SessionEventView>(),pruned=new Map<number,PreparedPrunedResult>()
      for(const index of wanted){const event=await read(index),substitute=event.type==='tool/result'?substitutes.get(event.callId):undefined;if(event.type==='tool/result'&&substitute)pruned.set(index,preparePrunedResultProjection(event,substitute,{index:pruneView,callId:event.callId}));else full.set(index,event)}
      // Selected preparation text/provenance must use actual original bodies.
      for(const event of [...full.values()])if(event.type==='user/message'&&event.inputPreparation){const resultIndex=event.inputPreparation.resultSeq;const result=full.get(resultIndex)??await read(resultIndex);full.set(resultIndex,result);if(result.type==='agent/input/preparation'){const admission=result.admissionSeq;if(!full.has(admission))full.set(admission,await read(admission))}}
      await owned.source.settle();current()
      let active=true
      const assert=()=>{if(!active)failure('CONVERSATION_PREPARATION_EXPIRED');current()}
      const eventAt=(index:number)=>{assert();if(!full.has(index))failure('CONVERSATION_PAYLOAD_NOT_PREPARED');return full.get(index)!}
      const archive={length:owned.index.eventCount,get:eventAt}
      const lease:PreparedConversationArchive=Object.freeze({length:archive.length,assertCurrent:assert,preparedEvent(index:number){if(this!==lease)failure('CONVERSATION_PREPARATION_INVALID');return eventAt(index)},preparedResult(index:number):PreparedResultProjection{if(this!==lease)failure('CONVERSATION_PREPARATION_INVALID');assert();const selected=pruned.get(index);if(selected)return selected;const event=eventAt(index);if(event.type!=='tool/result')failure('CONVERSATION_PAYLOAD_NOT_PREPARED');return {kind:'complete-result',event:event as Extract<SessionEventView,{type:'tool/result'}>}},async settle(){if(this!==lease)failure('CONVERSATION_PREPARATION_INVALID');active=false;full.clear();pruned.clear();substitutes.clear();leases.delete(lease)}})
      preparations.set(lease,{candidate:owned,current:assert,archive,pruned,substitutes,coordinates,state:owned.state.read()});leases.add(lease)
      return lease
    },
    stageAppend(events:readonly SessionEventView[],readCurrentEvent:(index:number)=>SessionEventView|undefined){
      check();const expected=revision,validation=owned.index.stage(events,{readCurrentEvent}),sources=owned.sources.stage(events),state=owned.state.stage(events),context=owned.context.stage(events),prune=owned.prune.stage(events);let installed=false
      return {install(batch:EncodedFactBatch,receipt:FactReceipt){if(installed)return;check();if(revision!==expected)failure('CONVERSATION_RESTORATION_STALE_SUFFIX');if(batch.key.firstSeq!==owned.index.eventCount||batch.key.count!==events.length)failure('CONVERSATION_RESTORATION_PREFIX_MISMATCH');owned.source.appendCommitted(batch,receipt);validation.commit();sources.commit();state.commit();context.commit();prune.commit();revision++;installed=true}}
    },
    async close(){owned.retired=true;for(const lease of [...leases])await lease.settle();await owned.source.close()},
  }
}
/** Paired projection/state from one live original preparation. No Session replay. */
export function readRestoredConversation(lease:PreparedConversationArchive,options:{ownerSessionId:string;capturePayload?:ConversationPayloadCapture}):{projection:ConversationProjection;state:ConversationStateRead}{
 const prepared=preparations.get(lease);if(!prepared)failure('CONVERSATION_PREPARATION_INVALID');prepared.current()
 const owned=prepared.candidate;if(options.ownerSessionId!==owned.sessionId)failure('CONVERSATION_RESTORATION_OWNER_MISMATCH')
 const projection=renderConversationItems(prepared.archive,owned.index.history(),{...options,header:owned.source.header,sourceCoordinates:prepared.coordinates,pruneSubstitutes:prepared.substitutes,prunedResults:prepared.pruned})
 const sources=archiveConversationSources(prepared.archive,options.ownerSessionId,[],{header:owned.source.header,coordinates:prepared.coordinates,prunedResults:prepared.pruned})
 const state=readIndexedConversationState(prepared.state,projection,{sources,visibility:historyVisibility(owned.index.resultFacts()),delivery:readConversationDeliveries(owned.index)!,seedEnd:owned.source.header?.seedLength??0})
 prepared.current();return {projection,state}
}
