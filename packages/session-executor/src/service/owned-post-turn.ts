import {isOriginalExecutionObservation} from '@i-harness/core-session/internal/execution'
import {committedFactSeqs, type CapturedActionFact, type FactOutcome} from '@i-harness/core-session'
import type {ModelClient,ModelBudgetBinding} from '@i-harness/llm-seam'
import {requestTitle} from '../../../session-title/src/index.ts'
import {isOwnedTitleSnapshot} from '../../../session-title/src/owned-projection.ts'
import {isManagedExecutionAttachment,type ManagedExecutionAttachment} from '../../../session-persistence/src/execution-internal.ts'
import {createExecutionTitleGenerationContext} from '../lifecycle/title-generation.ts'

export async function runOwnedPostTurn(options:{execution:ManagedExecutionAttachment;sessionId:string;signal:AbortSignal;model:ModelClient;selectedClient():ModelClient|undefined;localTestEnabled?:boolean;assertCurrent():void;retainCleanup(cleanup:()=>Promise<void>):()=>void;budgetBinding?:ModelBudgetBinding;contextWindow?:number;maxOutputTokens?:number;titleMaxOutputTokens?:number;timeoutMs?:number;coordinator?:import('@i-harness/session-persistence').SessionCoordinator;passiveGeneration?:import('@i-harness/llm-seam/internal/passive-observation').OriginalPassiveObserver}):Promise<void>{
 const {execution}=options
 if(!isManagedExecutionAttachment(execution))throw TypeError('Original execution attachment required')
 const read=()=>{options.assertCurrent();const observation=execution.observe();if(!isOriginalExecutionObservation(observation)||observation.identity!==execution.identity)throw TypeError('Original title observation required');observation.assertCurrent();const value=observation.metadata.title;if(value.kind!=='available'||!isOwnedTitleSnapshot(value.snapshot))throw TypeError('Original title fold unavailable');observation.assertCurrent();return value.snapshot}
 const selected=read()
 if(options.coordinator)void options.coordinator.putDocument(`session-title/${options.sessionId}`,{formatVersion:1,title:selected.title?.title??null}).catch(()=>{})
 if(selected.title!==null||selected.candidate===null)return
 const action=execution.owner.beginAction(options.signal)
 let generation:ReturnType<typeof createExecutionTitleGenerationContext>|undefined,source:ReturnType<typeof action.registerSettlementSource>|undefined
 let failed=false,failure:unknown,finished=false
 let release=()=>{}
 const cleanup=async()=>{
  const errors:unknown[]=[]
  try{await source?.close()}catch(error){errors.push(error)}
  try{await generation?.drain()}catch(error){errors.push(error)}
  if(errors.length===1)throw errors[0]
  if(errors.length)throw new AggregateError(errors,'Post-turn settlement requires recovery')
  if(!finished){action.finish();finished=true;release()}
 }
 try{release=options.retainCleanup(cleanup)}catch(error){action.finish();throw error}
 try{
  const assertSource=()=>{action.assertOpen();const now=read();if(now.title!==null||now.revision!==selected.revision||JSON.stringify(now.candidate)!==JSON.stringify(selected.candidate))throw Error('Title source changed')}
  const current=()=>{try{assertSource();return true}catch{return false}}
  generation=createExecutionTitleGenerationContext(execution,options.sessionId,action,{localTestEnabled:options.localTestEnabled,selectedClient:options.selectedClient,passiveGeneration:options.passiveGeneration})
  const result=await requestTitle(options,{signal:action.signal,assertOpen:assertSource,openGeneration:generation.open},selected.candidate)
  assertSource()
  if(!action.captureMetadata)throw TypeError('Guarded original metadata capture required')
  const capture:CapturedActionFact<FactOutcome>=action.captureMetadata({type:'session/title',title:result.title,source:result.source,messageSeqs:[...selected.candidate.messageSeqs]},current)
  let invoked=false,terminal=false
  const settle=async()=>{let outcome=invoked?await capture.observe():await capture.admit();invoked=true;if(outcome.kind==='unknown'||outcome.kind==='recovery-required'||outcome.kind==='not-issued'&&outcome.code==='FACT_RECOVERY_REQUIRED')outcome=await capture.reconcile();if(outcome.kind==='committed'||outcome.kind==='not-issued'&&outcome.code!=='FACT_RECOVERY_REQUIRED')terminal=true;return outcome}
  source=action.registerSettlementSource(async()=>{if(!terminal)committedFactSeqs(await settle())})
  committedFactSeqs(await settle())
  action.assertOpen();options.assertCurrent()
  if(options.coordinator)void options.coordinator.putDocument(`session-title/${options.sessionId}`,{formatVersion:1,title:result.title,source:result.source}).catch(()=>{})
 }catch(error){failed=true;failure=error}
 try{await cleanup()}catch(error){if(failed)throw new AggregateError([failure,error],'Post-turn settlement requires recovery',{cause:failure});throw error}
 if(failed)throw failure
}

/** Mount close on the constructor lifetime before the constructor first awaits. */
export function createOwnedPostTurnLifetime(){
 const retained=new Set<()=>Promise<void>>(),running=new Set<Promise<unknown>>()
 let closing=false
 const retainCleanup=(cleanup:()=>Promise<void>)=>{if(closing)throw Error('Post-turn lifetime closed');retained.add(cleanup);return ()=>{retained.delete(cleanup)}}
 return Object.freeze({
  run(options:Omit<Parameters<typeof runOwnedPostTurn>[0],'retainCleanup'>){
   if(closing)throw Error('Post-turn lifetime closed')
   const work=runOwnedPostTurn({...options,assertCurrent(){if(closing)throw Error('Post-turn lifetime closed');options.assertCurrent();if(closing)throw Error('Post-turn lifetime closed')},retainCleanup});running.add(work)
   void work.then(()=>running.delete(work),()=>running.delete(work));return work
  },
  async close(){
   closing=true;await Promise.allSettled([...running])
   const failures:unknown[]=[]
   for(const cleanup of [...retained])try{await cleanup()}catch(error){failures.push(error)}
   if(failures.length)throw new AggregateError(failures,'Post-turn lifetime cleanup requires recovery')
  },
 })
}
