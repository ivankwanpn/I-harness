import {canonicalJsonData,type SessionView,type ManagedAction,type FactOutcome,type SettlementFacts} from '@i-harness/core-session'
import {isManagedExecutionSource,readManagedActionMembers,type ManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
import type {ExecutionHookChannel} from '@i-harness/core-plugin'
import type {PreparedCall} from '@i-harness/core-tools'
import type {BatchCall} from './types.ts'
import type {ManagedFactWitness,createManagedModelInvocation} from './managed-model-origin.ts'

const originals=new WeakSet<object>()
export interface ManagedBatchSource {
 readonly kind:'managed-batch-source'
 readonly domain:ManagedExecutionDomain
 readonly action:ManagedAction<FactOutcome>
 captureBatch(calls:BatchCall[]):BatchCall[]
 register(drain:()=>Promise<void>):SettlementFacts<FactOutcome>
 assertCall(index:number,call:BatchCall):void
 markDispatch(index:number,call:BatchCall):Promise<FactOutcome>
 readCall(index:number):Extract<import('@i-harness/core-session').SessionEventView,{type:'tool/call'}>
 readDispatch(index:number):Extract<import('@i-harness/core-session').SessionEventView,{type:'tool/dispatch'}>
 indexOfCall(call:BatchCall):number
 attach(index:number,prepared:PreparedCall,source:SettlementFacts<FactOutcome>):void
 synthetic(index:number,source:SettlementFacts<FactOutcome>):import('@i-harness/core-tools').ManagedSyntheticResultContext
 postTool(payload:object):Promise<unknown>
 release():void
}
export type BatchSource=SessionView|ManagedBatchSource
export function isManagedBatchSource(source:BatchSource):source is ManagedBatchSource{return originals.has(source)}
export function createManagedBatchSource(domain:ManagedExecutionDomain,action:ManagedAction<FactOutcome>,invocation:ReturnType<typeof createManagedModelInvocation>,batch:object,calls:readonly BatchCall[],witnesses:readonly ManagedFactWitness[],hooks:ExecutionHookChannel,register:(drain:()=>Promise<void>)=>SettlementFacts<FactOutcome>):ManagedBatchSource{
 domain.assertCurrent();if(!domain.owner.ownsAction(action)||calls.length!==witnesses.length)throw TypeError('Original batch action/captures required')
 const surface=hooks.capture(),dispatches=new Map<number,import('@i-harness/core-session').CapturedActionFact<FactOutcome>>(),dispatchOutcomes=new Map<number,Extract<FactOutcome,{kind:'committed'}>>();let registered=false,drainRecords:(()=>Promise<void>)|undefined,snapshots=calls.map(call=>canonicalJsonData(call)),owned=calls.map(call=>Object.freeze({...call}))
 Object.freeze(owned)
 const ordinals=new Map<BatchCall,number>();calls.forEach((call,index)=>ordinals.set(call,index));owned.forEach((call,index)=>ordinals.set(call,index))
 const member=(index:number,call:BatchCall)=>{const witness=witnesses[index];if(!witness||calls[index]!==call&&owned[index]!==call||snapshots[index]!==canonicalJsonData(call))throw TypeError('Original batch call required');const events=readManagedActionMembers(domain,action,witness.capture,witness.outcome),event=events[0];if(events.length!==1||event?.type!=='tool/call'||event.callId!==call.callId||event.name!==call.name||event.seq!==call.eventSeq||canonicalJsonData(event.args)!==canonicalJsonData(call.args))throw TypeError('Original call ACK required');return witness}
 const source:ManagedBatchSource=Object.freeze({kind:'managed-batch-source',domain,action,
  captureBatch(input:BatchCall[]){if(this!==source||input!==calls||registered)throw TypeError('Original unconsumed batch required');invocation.assertCurrent();input.forEach((call,index)=>member(index,call));return owned},
  register(drain:()=>Promise<void>){if(this!==source||registered)throw TypeError('Original unconsumed batch required');invocation.assertCurrent();registered=true;drainRecords=drain;const settlement=register(async()=>{for(const capture of dispatches.values()){let outcome=await capture.observe();if(outcome.kind==='unknown'||outcome.kind==='conflict'||outcome.kind==='recovery-required')outcome=await capture.reconcile();if(outcome.kind==='unknown'||outcome.kind==='conflict'||outcome.kind==='recovery-required')throw Object.assign(Error('Original tool dispatch requires recovery'),{code:'FACT_RECOVERY_REQUIRED'})}await drainRecords?.()});if(!isManagedExecutionSource(domain,settlement))throw TypeError('Original batch settlement source required');return settlement},
  assertCall(index:number,call:BatchCall){if(this!==source)throw TypeError('Original batch receiver required');invocation.assertCurrent();hooks.assertCurrent(surface);member(index,call)},
  indexOfCall(call:BatchCall){if(this!==source)throw TypeError('Original batch receiver required');const index=ordinals.get(call);if(index===undefined)throw TypeError('Original batch member object required');source.assertCall(index,call);return index},
  async markDispatch(index:number,call:BatchCall){if(this!==source)throw TypeError('Original batch receiver required');source.assertCall(index,call);let captured=dispatches.get(index);if(!captured){if(!action.captureToolDispatch||call.eventSeq===undefined)throw TypeError('Original tool dispatch producer required');captured=action.captureToolDispatch(call.callId,{kind:'prior',seq:call.eventSeq,expectedType:'tool/call'});dispatches.set(index,captured)}const outcome=await captured.admit();if(outcome.kind==='committed')dispatchOutcomes.set(index,outcome);return outcome},
  readCall(index:number){if(this!==source)throw TypeError('Original batch receiver required');const witness=member(index,owned[index]!),event=readManagedActionMembers(domain,action,witness.capture,witness.outcome)[0];if(event?.type!=='tool/call')throw TypeError('Original tool call required');return event},
  readDispatch(index:number){if(this!==source)throw TypeError('Original batch receiver required');const capture=dispatches.get(index),outcome=dispatchOutcomes.get(index);if(!capture||!outcome)throw TypeError('Original tool dispatch ACK required');const event=readManagedActionMembers(domain,action,capture,outcome)[0],call=source.readCall(index);if(event?.type!=='tool/dispatch'||event.callId!==call.callId||event.eventSeq!==call.seq)throw TypeError('Original tool dispatch member required');return event},
  attach(index:number,prepared:PreparedCall,settlement:SettlementFacts<FactOutcome>){if(this!==source)throw TypeError('Original batch receiver required');member(index,owned[index]!);invocation.attach(batch,index,prepared,settlement)},
  synthetic(index:number,settlement:SettlementFacts<FactOutcome>){if(this!==source)throw TypeError('Original batch receiver required');const call=owned[index]!,witness=member(index,call);return {domain,source:settlement,callId:call.callId,name:call.name,...witness}},
  postTool(payload:object){if(this!==source)throw TypeError('Original batch receiver required');return hooks.emit('agent/post-tool',{...payload,domain},surface)},
  release(){if(this!==source)throw TypeError('Original batch receiver required');invocation.releaseBatch(batch);drainRecords=undefined;dispatches.clear();dispatchOutcomes.clear();ordinals.clear();calls=[];witnesses=[];owned=[];snapshots=[]},
 })
 originals.add(source);calls.forEach((call,index)=>member(index,call));return source
}
