import {assertManagedExecutionSession, isOriginalExecutionObservation, type ExecutionObservation} from '@i-harness/core-session/internal/execution'
import { committedFactSeqs } from '@i-harness/core-session'
import { createAssemblyExecutionRuntime, type ExecutionRuntimeOptions } from '../../session-executor/src/execution-runtime.ts'
import { acquireAssemblyResultStore, type ResultStoreOptions } from '../../session-executor/src/lifecycle/result-store.ts'
import { isManagedExecutionAttachment, type ManagedExecutionAttachment } from '../../session-persistence/src/execution-internal.ts'
import type { SessionCoordinator } from '@i-harness/session-persistence'
import type { AuthorityState, SandboxMode } from '@i-harness/sandbox'
import type {ResolvedAgentShell} from '@i-harness/shell'
import { captureTaskChildSearch, type TaskChildSearchInput } from '@i-harness/session-executor/internal/task-child-search'

type Retain=(cleanup:()=>void|Promise<void>)=>void
type ExecutionConfiguration=Pick<ExecutionRuntimeOptions,'windowsSandboxBackend'|'wslExecution'|'legacyPrivateTempRoot'>
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
 executionOptions():ExecutionConfiguration|Promise<ExecutionConfiguration>
 resolveShell(id:string,execution:ExecutionConfiguration,authority:()=>AuthorityState):Promise<()=>ResolvedAgentShell>
 resultOptions(id:string):ResultStoreOptions
}) {
 type Owner = {
  shell: () => ResolvedAgentShell
  runtime: ReturnType<typeof createAssemblyExecutionRuntime>
  executionOptions: ExecutionConfiguration
  standing(observation?: ExecutionObservation): { mode: SandboxMode; generation: string }
  updateRecordedMode(): Promise<void>
 }
 const owners = new Map<string, Owner>()
 const childSearches = new Map<string, { parentSessionId: string; owner: ReturnType<ReturnType<typeof captureTaskChildSearch>['create']> }>()
 async function reconcileChildSearches(ids?: readonly string[]) {
  const targets = [...childSearches].filter(([id, search]) => !ids || ids.includes(id) || ids.includes(search.parentSessionId))
  const results = await Promise.allSettled(targets.map(([, search]) => search.owner.reconcile()))
  const failures = results.flatMap((result, index) => result.status === 'rejected' && childSearches.get(targets[index]![0]) === targets[index]![1] ? [result.reason] : [])
  if (failures.length) throw new AggregateError(failures, 'Task child search policy reconciliation incomplete')
 }
 return {
  reconcileChildSearches,
  agentShellFor(id:string){const owner=owners.get(id);if(!owner)throw Error('Original session shell unavailable');return owner.shell()},
  modeFor(id:string, observation:ExecutionObservation){const owner=owners.get(id);if(!owner)throw Error('Original native policy unavailable');return owner.standing(observation).mode},
  async reconcile(id:string){const owner=owners.get(id);if(!owner)throw Error('Original native runtime unavailable');await owner.runtime.reconcile();if(owners.get(id)!==owner)throw Error('Original native runtime retired')},
  async reconcileAll(){
   const failures = []
   const targets = [...owners]
   const childReconciliation = reconcileChildSearches().catch(error => { failures.push(error) })
   const results = await Promise.allSettled(targets.map(async ([id, owner]) => {
    await owner.runtime.reconcile()
    if (owners.get(id) === owner) await owner.updateRecordedMode()
   }))
   for (const [index, result] of results.entries()) {
    const [id, owner] = targets[index]!
    if (result.status === 'rejected' && owners.get(id) === owner) failures.push(result.reason)
   }
   await childReconciliation
   if (failures.length) throw new AggregateError(failures, 'Native policy reconciliation incomplete')
  },
  async mountTaskChildSearch(input: TaskChildSearchInput, scope: {
   coordinator: SessionCoordinator; workspace: string; authority(): Promise<() => AuthorityState>; assertParentCurrent(): void
  }) {
   if (!input.allowed('glob') && !input.allowed('grep')) return
   const parent = owners.get(input.parentSessionId)
   if (!parent) throw Error('Original Task parent native runtime unavailable')
   const child = captureTaskChildSearch(input, scope.coordinator)
   const assertParentCurrent = () => {
    if (owners.get(input.parentSessionId) !== parent) throw Error('Original Task parent native runtime retired')
    scope.assertParentCurrent()
   }
   assertParentCurrent()
   const authority = await scope.authority()
   assertParentCurrent()
   if (childSearches.has(input.sessionId)) throw Error('Original Task child search already mounted')
   const owner = child.create({ workspace: scope.workspace, authority, assertParentCurrent, execution: parent.executionOptions, standing() {
    assertParentCurrent()
    const parentStanding = parent.standing(), childPolicy = child.policy()
    const mode = narrowerMode(narrowerMode(options.mode(), parentStanding.mode), childPolicy?.mode)
    return { mode, generation: JSON.stringify([options.modeRevision?.() ?? 0, parentStanding.generation, mode, childPolicy?.seq]) }
   } })
   const entry = { parentSessionId: input.parentSessionId, owner }
   const close = async () => {
    await owner.close()
    if (childSearches.get(input.sessionId) === entry) childSearches.delete(input.sessionId)
   }
   childSearches.set(input.sessionId, entry)
   try { input.retainCleanup(close); owner.mount() }
   catch (cause) {
    try { await close() }
    catch (cleanup) { throw new AggregateError([cause, cleanup], 'Original Task child search cleanup incomplete') }
    throw cause
   }
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
   const owner = { shell, runtime, standing, executionOptions, async updateRecordedMode() {
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
