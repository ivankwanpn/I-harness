import { freezeJsonData, type HeldInheritedResultMetadata } from '@i-harness/core-session'
import { captureObservation } from './observed-read.ts'
import { readSelectedPlan, selectedRow, walkSelectedPages } from './selected-readonly-plan.ts'
import type { ContextStore } from '../store.ts'
import type { LegacyReadObservation } from './fork-types.ts'

type WithRead=<T>(work:(store:ContextStore)=>Promise<T>)=>Promise<T>
/** Constructed only by the original service; short gate uses settle before each yield. */
export async function createSelectedMetadata(input:LegacyReadObservation,withRead:WithRead,settle:(store:ContextStore)=>Promise<void>,assertService:()=>void,onClosed:()=>void) {
 const observation=captureObservation(input),guard=()=>{assertService();observation.assertCurrent()}
 guard();let originalStore:ContextStore|undefined,plan:Awaited<ReturnType<typeof readSelectedPlan>>|undefined
 if(observation.bootstrap){await withRead(async store=>{guard();originalStore=store;plan=await readSelectedPlan(store,observation,guard);for await(const row of walkSelectedPages(store,plan.directory,plan.root,guard))await selectedRow(store,plan.root,row,observation.sourceId,guard);guard()})}
 let revoked=false,closed=false,iterator:AsyncGenerator<import('./fork-types.ts').LegacyRow>|undefined,flight:Promise<unknown>|undefined,returnFlight:Promise<void>|undefined,closeFlight:Promise<void>|undefined,iteratorClosed=false
 const finishIterator=()=>{if(iteratorClosed)return Promise.resolve();if(returnFlight)return returnFlight;const task=(async()=>{if(flight)await flight.catch(()=>{});if(iterator)await iterator.return(undefined);iteratorClosed=true})();returnFlight=task;void task.finally(()=>{if(returnFlight===task)returnFlight=undefined}).catch(()=>{});return task}
 const current=()=>{if(revoked||closed)throw Error('Selected metadata reader revoked');guard()}
 const reader:HeldInheritedResultMetadata=Object.freeze({assertCurrent:current,legacy(){
  current();if(iterator)throw Error('Selected metadata iterator already entered')
  if(plan)iterator=walkSelectedPages(originalStore!,plan.directory,plan.root,current)
  let ended=false
  return {[Symbol.asyncIterator](){return this},async next(){
   current();if(ended)return {done:true as const,value:undefined};if(flight)throw Error('Concurrent selected metadata iteration')
   const task=(async()=>{
    if(!plan){ended=true;return {done:true as const,value:undefined}}
    return withRead(async store=>{current();if(store!==originalStore)throw Error('Original metadata store changed');const now=await readSelectedPlan(store,observation,current);if(JSON.stringify(now.root)!==JSON.stringify(plan!.root))throw Error('Original metadata plan changed');for await(const proof of walkSelectedPages(store,now.directory,now.root,current))await selectedRow(store,now.root,proof,observation.sourceId,current);const row=await iterator!.next();current();if(row.done){ended=true;return {done:true as const,value:undefined}};const value=await selectedRow(store,plan!.root,row.value,observation.sourceId,current);current();return {done:false as const,value:freezeJsonData(value)}})
   })();flight=task
   try{return await task}catch(error){revoked=true;throw error}finally{if(flight===task)flight=undefined}
  },async return(){ended=true;await finishIterator();return {done:true as const,value:undefined}}}
 }})
 return Object.freeze({reader,assertCurrent:current,revoke(){revoked=true},close(){if(closed)return Promise.resolve();if(closeFlight)return closeFlight;revoked=true;const task=(async()=>{await finishIterator();if(originalStore)await settle(originalStore);closed=true;onClosed()})();closeFlight=task;void task.finally(()=>{if(closeFlight===task)closeFlight=undefined}).catch(()=>{});return task}})
}

