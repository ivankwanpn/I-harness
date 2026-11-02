import {createPreparedRuntimeContext} from '@i-harness/runtime-context'
import {isManagedExecutionAttachment,type ManagedExecutionAttachment} from '../../../session-persistence/src/execution-internal.ts'
import {isManagedExecutionDomain,type ManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
import {createRuntimeContextSource} from './action-facts.ts'
/** Actual owner/source composition. Incoming observation data cannot enroll it. */
export function createExecutionRuntimeContext(execution:ManagedExecutionAttachment,domain:ManagedExecutionDomain){
 if(!isManagedExecutionAttachment(execution)||!isManagedExecutionDomain(domain)||execution.identity!==domain.identity||execution.owner!==domain.owner)throw TypeError('Original runtime execution domain required')
 const prepare=execution.prepare,assert=domain.assertCurrent
 return createPreparedRuntimeContext({ownerSessionId:domain.sessionId,prepare:async signal=>{signal?.throwIfAborted();Reflect.apply(assert,domain,[]);return Reflect.apply(prepare,execution,[])},assertCurrent:()=>Reflect.apply(assert,domain,[])},createRuntimeContextSource(execution.owner))
}
