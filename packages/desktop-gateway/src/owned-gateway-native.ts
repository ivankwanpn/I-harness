import {assertManagedExecutionSession, isOriginalExecutionObservation, type ExecutionObservation} from '@i-harness/core-session/internal/execution'
import { committedFactSeqs } from '@i-harness/core-session'
import { createAssemblyExecutionRuntime, type ExecutionRuntimeOptions } from '../../session-executor/src/execution-runtime.ts'
import { acquireAssemblyResultStore, type ResultStoreOptions } from '../../session-executor/src/lifecycle/result-store.ts'
import { isManagedExecutionAttachment, type ManagedExecutionAttachment } from '../../session-persistence/src/execution-internal.ts'
import type { AuthorityState, SandboxMode } from '@i-harness/sandbox'
import type {ResolvedAgentShell} from '@i-harness/shell'

type Retain=(cleanup:()=>void|Promise<void>)=>void
function narrowerMode(host: SandboxMode, requested?: SandboxMode): SandboxMode {
 if (host === 'read-only' || requested === 'read-only') return 'read-only'
 if (host === 'workspace-write' || requested === 'workspace-write') return 'workspace-write'
 return host
}
/** Bind native execution and output leases to the original session, project
 * authority, and live persisted sandbox policy. */
export function createOwnedGatewayNative(options:{
 authorityFor(id:string):Promise<()=>AuthorityState>
 mode():SandboxMode
 modeRevision?():number
 executionOptions():Pick<ExecutionRuntimeOptions,'windowsSandboxBackend'|'wslExecution'|'legacyPrivateTempRoot'>|Promise<Pick<ExecutionRuntimeOptions,'windowsSandboxBackend'|'wslExecution'|'legacyPrivateTempRoot'>>
 resolveShell(id:string,execution:Pick<ExecutionRuntimeOptions,'windowsSandboxBackend'|'wslExecution'|'legacyPrivateTempRoot'>,authority:()=>AuthorityState):Promise<()=>ResolvedAgentShell>
 resultOptions(id:string):ResultStoreOptions
}) {
 type Owner = {
  shell: () => ResolvedAgentShell
  runtime: ReturnType<typeof createAssemblyExecutionRuntime>
  standing(observation?: ExecutionObservation): { mode: SandboxMode; generation: string }
  updateRecordedMode(): Promise<void>
 }
 const owners = new Map<string, Owner>()
 return {
  agentShellFor(id:string){const owner=owners.get(id);if(!owner)throw Error('Original session shell unavailable');return owner.shell()},
  modeFor(id:string, observation:ExecutionObservation){const owner=owners.get(id);if(!owner)throw Error('Original native policy unavailable');return owner.standing(observation).mode},
  async reconcile(id:string){const owner=owners.get(id);if(!owner)throw Error('Original native runtime unavailable');await owner.runtime.reconcile();if(owners.get(id)!==owner)throw Error('Original native runtime retired')},
  async reconcileAll(){
   const failures = []
   const targets = [...owners]
   const results = await Promise.allSettled(targets.map(async ([id, owner]) => {
    await owner.runtime.reconcile()
    if (owners.get(id) === owner) await owner.updateRecordedMode()
   }))
   for (const [index, result] of results.entries()) {
    const [id, owner] = targets[index]!
    if (result.status === 'rejected' && owners.get(id) === owner) failures.push(result.reason)
   }
   if (failures.length) throw new AggregateError(failures, 'Native policy reconciliation incomplete')
  },
  async acquireExecution(sessionId:string,retain:Retain,execution:ManagedExecutionAttachment) {
   if(!isManagedExecutionAttachment(execution))throw TypeError('Original execution attachment required')
   assertManagedExecutionSession(execution.identity,execution.owner,sessionId)
   const before=execution.observe();before.assertCurrent()
   const authority=await options.authorityFor(sessionId);before.assertCurrent()
   const executionOptions=await options.executionOptions();before.assertCurrent()
   const shell=await options.resolveShell(sessionId,executionOptions,authority);before.assertCurrent()
   if(owners.has(sessionId))throw Error('Original session shell already acquired')
   let disposed=false
   const floor = before.eventCount
   const delegated = before.header?.origin === 'subagent' || before.header?.origin === 'team'
   const delegatedCeiling = delegated ? before.sandboxPolicy()?.mode : undefined
   const standing = (observation = execution.observe()) => {
    if (disposed || !isOriginalExecutionObservation(observation) || observation.identity !== execution.identity) throw Error('Original native policy unavailable')
    const policy = observation.sandboxPolicy(floor)
    const mode = narrowerMode(narrowerMode(options.mode(), delegatedCeiling), policy?.mode)
    observation.assertCurrent()
    return { mode, generation: JSON.stringify([options.modeRevision?.() ?? 0, mode, policy?.seq]) }
   }
   const runtime=createAssemblyExecutionRuntime({owner:{sessionId},managedExecution:execution,authority,ownerAvailable:()=>!disposed, standing,...executionOptions})
   const owner = { shell, runtime, standing, async updateRecordedMode() {
    // A host change can cap a delegated session, but only its original owner
    // can update the session's independent restriction.
    if (delegated) return
    const next = options.mode()
    const recorded = execution.observe().sandboxPolicy(floor)
    if (!recorded || recorded.mode === next) return
    const action = execution.owner.beginAction()
    try { committedFactSeqs(await action.facts.metadata.admit({ type: 'sandbox/mode', mode: next })) }
    finally { action.finish() }
   } }
   try {retain(async()=>{disposed=true;if(owners.get(sessionId)===owner)owners.delete(sessionId);await runtime.execution.dispose!()})} catch(error){try{await runtime.execution.dispose!()}catch(cleanup){throw new AggregateError([error,cleanup],'Native retention and cleanup failed')}throw error}
   owners.set(sessionId,owner)
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
   return Object.freeze({
    service: lease.service, sourceFor: lease.sourceFor, withLegacyReadObservation: lease.withLegacyReadObservation,
   })
  },
 }
}
