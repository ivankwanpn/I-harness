import {createPreparedRuntimeContext} from '@i-harness/runtime-context'
import {isManagedExecutionAttachment,type ManagedExecutionAttachment} from '../../../session-persistence/src/execution-internal.ts'
import {isManagedExecutionDomain,type ManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
import {createRuntimeContextSource} from './action-facts.ts'
/** Actual owner/source composition. Incoming observation data cannot enroll it. */
export function createExecutionRuntimeContext(execution:ManagedExecutionAttachment,domain:ManagedExecutionDomain){
 if(!isManagedExecutionAttachment(execution)||!isManagedExecutionDomain(domain)||execution.identity!==domain.identity||execution.owner!==domain.owner)throw TypeError('Original runtime execution domain required')
 const prepare=execution.prepare,assert=domain.assertCurrent,observe=execution.observe
 return createPreparedRuntimeContext({
  ownerSessionId:domain.sessionId,
  async prepare(signal){
   signal?.throwIfAborted()
   Reflect.apply(assert,domain,[])
   return Reflect.apply(prepare,execution,[])
  },
  assertCurrent(){
   // Existing publication revalidation reads the genuine committed owner.
   // Its captured archive still checks the selected prefix independently.
   const observation=Reflect.apply(observe,execution,[])
   observation.assertCurrent()
  },
 },createRuntimeContextSource(execution.owner))
}
