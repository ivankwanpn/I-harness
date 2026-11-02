import {assertManagedExecutionSession} from '@i-harness/core-session/internal/execution'
import { createAssemblyExecutionRuntime, type ExecutionRuntimeOptions } from '../../session-executor/src/execution-runtime.ts'
import { acquireAssemblyResultStore, type ResultStoreOptions } from '../../session-executor/src/lifecycle/result-store.ts'
import { isManagedExecutionAttachment, type ManagedExecutionAttachment } from '../../session-persistence/src/execution-internal.ts'
import type { AuthorityState, SandboxMode } from '@i-harness/sandbox'

type Retain=(cleanup:()=>void|Promise<void>)=>void
/** Bind native execution and output leases to the original session, project
 * authority, and live persisted sandbox policy. */
export function createOwnedGatewayNative(options:{
 authorityFor(id:string):Promise<()=>AuthorityState>
 mode():SandboxMode
 executionOptions():Pick<ExecutionRuntimeOptions,'windowsSandboxBackend'|'wslExecution'|'legacyPrivateTempRoot'>|Promise<Pick<ExecutionRuntimeOptions,'windowsSandboxBackend'|'wslExecution'|'legacyPrivateTempRoot'>>
 resultOptions(id:string):ResultStoreOptions
}) {
 return {
  async acquireExecution(sessionId:string,retain:Retain,execution:ManagedExecutionAttachment) {
   if(!isManagedExecutionAttachment(execution))throw TypeError('Original execution attachment required')
   assertManagedExecutionSession(execution.identity,execution.owner,sessionId)
   const before=execution.observe();before.assertCurrent()
   const authority=await options.authorityFor(sessionId);before.assertCurrent()
   const executionOptions=await options.executionOptions();before.assertCurrent()
   let disposed=false
   const runtime=createAssemblyExecutionRuntime({owner:{sessionId},authority,ownerAvailable:()=>!disposed,
    standing:()=>{const observation=execution.observe(),policy=observation.sandboxPolicy(),mode=policy?.mode??options.mode();observation.assertCurrent();return {mode,generation:JSON.stringify([mode,policy?.seq])}},...executionOptions})
   try {retain(async()=>{disposed=true;await runtime.execution.dispose!()})} catch(error){try{await runtime.execution.dispose!()}catch(cleanup){throw new AggregateError([error,cleanup],'Native retention and cleanup failed')}throw error}
   before.assertCurrent()
   return runtime.execution
  },
  async acquireOutput(sessionId:string,retain:Retain) {
   let lease:Awaited<ReturnType<typeof acquireAssemblyResultStore>>|undefined
   let pending:ReturnType<typeof acquireAssemblyResultStore>|undefined
   retain(async()=>{if(!lease&&pending)try{lease=await pending}catch(error){await (error as {retryCleanup?:()=>Promise<void>})?.retryCleanup?.();return}await lease?.release()})
   const result=options.resultOptions(sessionId)
   if(result.sessionId!==sessionId || !result.coordinator)throw Error('Original result store session unavailable')
   pending=acquireAssemblyResultStore(result);lease=await pending
   if(!lease.service||!lease.sourceFor)throw Error('Original result store unavailable')
   return {service:lease.service,sourceFor:lease.sourceFor}
  },
 }
}
