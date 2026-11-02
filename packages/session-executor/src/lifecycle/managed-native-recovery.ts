import {renderContextRecovery,type ContextOutputService} from '@i-harness/context-output'
import {isManagedExecutionOwner} from '@i-harness/core-session/internal/execution'
import {isManagedExecutionAttachment,type ManagedExecutionAttachment} from '../../../session-persistence/src/execution-internal.ts'

/** Cached prompt data only; an original result reader still authorizes every read. */
export function createManagedNativeRecovery(execution:ManagedExecutionAttachment,output:ContextOutputService){
 if(!isManagedExecutionAttachment(execution)||!isManagedExecutionOwner(execution.identity,execution.owner))throw TypeError('Original managed execution required')
 const status=Object.getOwnPropertyDescriptor(output,'status');if(!status||!('value'in status)||typeof status.value!=='function')throw TypeError('Original output status required')
 const readEnabled=()=>{if(Object.getOwnPropertyDescriptor(output,'status')?.value!==status.value)throw TypeError('Original output status changed');return (Reflect.apply(status.value,output,[]) as ReturnType<ContextOutputService["status"]>).enabled===true}
 let retired=false,revision=0,cache:{observation:ReturnType<ManagedExecutionAttachment['observe']>;enabled:boolean;text:string}|undefined
 const active=new Set<Promise<void>>()
 const owner={
  refresh(signal?:AbortSignal){if(this!==owner)return Promise.reject(TypeError('Original recovery owner required'));if(retired)return Promise.reject(Error('Original recovery owner retired'));const turn=++revision
   const pending=(async()=>{signal?.throwIfAborted();const enabled=readEnabled(),observation=execution.observe(),refs=enabled?await observation.recentNativeRecoveryRefs():[];signal?.throwIfAborted();observation.assertCurrent();if(retired||turn!==revision||readEnabled()!==enabled)throw Object.assign(Error('Original recovery observation stale'),{code:'CONTEXT_INPUT_STALE'});const text=enabled?renderContextRecovery(refs,2048):'';observation.assertCurrent();cache={observation,enabled,text}})();active.add(pending);void pending.finally(()=>active.delete(pending)).catch(()=>{});return pending},
  render(){if(this!==owner||retired||!cache)throw Error('Original recovery owner unavailable');cache.observation.assertCurrent();if(readEnabled()!==cache.enabled)throw Object.assign(Error('Original recovery observation stale'),{code:'CONTEXT_INPUT_STALE'});return cache.text},
  async close(){if(this!==owner)throw TypeError('Original recovery owner required');retired=true;revision++;const pending=[...active];if(pending.length){const results=await Promise.allSettled(pending),failures=results.flatMap(value=>value.status==='rejected'?[value.reason]:[]);if(failures.length)throw new AggregateError(failures,'Original recovery read requires cleanup')}cache=undefined},
 }
 return Object.freeze(owner)
}
