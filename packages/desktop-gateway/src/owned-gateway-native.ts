import {assertManagedExecutionSession} from '@i-harness/core-session/internal/execution'
import { createAssemblyExecutionRuntime, type ExecutionRuntimeOptions } from '../../session-executor/src/execution-runtime.ts'
import { acquireAssemblyResultStore, type ResultStoreOptions } from '../../session-executor/src/lifecycle/result-store.ts'
import { isManagedExecutionAttachment, type ManagedExecutionAttachment } from '../../session-persistence/src/execution-internal.ts'
import type { AuthorityState, SandboxMode } from '@i-harness/sandbox'
import type {ResolvedAgentShell} from '@i-harness/shell'

type Retain=(cleanup:()=>void|Promise<void>)=>void
/** Bind native execution and output leases to the original session, project
 * authority, and live persisted sandbox policy. */
export function createOwnedGatewayNative(options:{
 authorityFor(id:string):Promise<()=>AuthorityState>
 mode():SandboxMode
 executionOptions():Pick<ExecutionRuntimeOptions,'windowsSandboxBackend'|'wslExecution'|'legacyPrivateTempRoot'>|Promise<Pick<ExecutionRuntimeOptions,'windowsSandboxBackend'|'wslExecution'|'legacyPrivateTempRoot'>>
 resolveShell(id:string,execution:Pick<ExecutionRuntimeOptions,'windowsSandboxBackend'|'wslExecution'|'legacyPrivateTempRoot'>):Promise<()=>ResolvedAgentShell>
 resultOptions(id:string):ResultStoreOptions
}) {
 const shells=new Map<string,()=>ResolvedAgentShell>(),runtimes=new Map<string,ReturnType<typeof createAssemblyExecutionRuntime>>()
 return {
  agentShellFor(id:string){const read=shells.get(id);if(!read)throw Error('Original session shell unavailable');return read()},
  async reconcile(id:string){const runtime=runtimes.get(id);if(!runtime)throw Error('Original native runtime unavailable');await runtime.reconcile();if(runtimes.get(id)!==runtime)throw Error('Original native runtime retired')},
  async acquireExecution(sessionId:string,retain:Retain,execution:ManagedExecutionAttachment) {
   if(!isManagedExecutionAttachment(execution))throw TypeError('Original execution attachment required')
   assertManagedExecutionSession(execution.identity,execution.owner,sessionId)
   const before=execution.observe();before.assertCurrent()
   const authority=await options.authorityFor(sessionId);before.assertCurrent()
   const executionOptions=await options.executionOptions();before.assertCurrent()
   const shell=await options.resolveShell(sessionId,executionOptions);before.assertCurrent()
   if(shells.has(sessionId))throw Error('Original session shell already acquired')
   let disposed=false
   const runtime=createAssemblyExecutionRuntime({owner:{sessionId},managedExecution:execution,authority,ownerAvailable:()=>!disposed,
    standing:()=>{const observation=execution.observe(),policy=observation.sandboxPolicy(),mode=policy?.mode??options.mode();observation.assertCurrent();return {mode,generation:JSON.stringify([mode,policy?.seq])}},...executionOptions})
   try {retain(async()=>{disposed=true;if(shells.get(sessionId)===shell)shells.delete(sessionId);if(runtimes.get(sessionId)===runtime)runtimes.delete(sessionId);await runtime.execution.dispose!()})} catch(error){try{await runtime.execution.dispose!()}catch(cleanup){throw new AggregateError([error,cleanup],'Native retention and cleanup failed')}throw error}
   shells.set(sessionId,shell);runtimes.set(sessionId,runtime)
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
   return Object.freeze({service:lease.service,sourceFor:lease.sourceFor})
  },
 }
}
