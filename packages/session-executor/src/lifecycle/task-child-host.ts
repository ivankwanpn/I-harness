import {inspectTaskChildSource,inspectManagedTaskChildHistory,isManagedTaskChildHistory} from '@i-harness/subagent'
import type { PrepareTaskChild } from '@i-harness/subagent'
import type { SessionCoordinator,ExistingSessionBindingObservation,ChildBootstrapCaptureRequest,BootstrapGuards } from '@i-harness/session-persistence'
import {observationCleanupFor} from '@i-harness/session-persistence/internal/retained-inspection'

/** Explicit shipping CLI/SDK policy, restricted by the original binding owner. */
export function createUnmanagedTaskChildHost(options: {coordinator: SessionCoordinator; policy: 'unmanaged'}): PrepareTaskChild {
 const {coordinator,policy}=options
 if(policy!=='unmanaged'||!coordinator.withExistingSessionBindingObservation||!coordinator.withSessionBindingObservation)throw Error('Original unmanaged task host unavailable')
 const existing=coordinator.withExistingSessionBindingObservation.bind(coordinator),target=coordinator.withSessionBindingObservation.bind(coordinator)
 return async input=>{
  if(input.coordinator!==coordinator)throw Error('Foreign task host coordinator')
  input.assertCurrent()
  const checkHistory=()=>{if(input.history){const history=isManagedTaskChildHistory(input.history)?inspectManagedTaskChildHistory(input.history,input.parentSessionId):inspectTaskChildSource(input.history,input.parentSessionId);if(history.hasDependencies||history.hasLegacy||history.inheritedLegacyUnknown)throw Error('Unsupported unmanaged task semantic history dependencies')}}
  checkHistory()
  let debt:ReturnType<typeof observationCleanupFor>,scopeFailure:{cause:unknown}|undefined,running=false,scopeExit:Promise<void>|undefined
  input.retain({async close(){await scopeExit;if(debt){await debt.retry();debt=undefined}}})
  const ids:string[]=[],seen=new Set<string>();let id:string|undefined=input.parentSessionId
  while(id){if(seen.has(id)||seen.size>=64)throw Error('Unmanaged task lineage unavailable');seen.add(id);ids.push(id);const {meta}=await coordinator.profile(id);input.assertCurrent();if(meta.archived||meta.sessionId!==id)throw Error('Unmanaged task parent unavailable');id=['subagent','team'].includes(meta.origin??'')?meta.parentSession:undefined}
  const check=(observation:ExistingSessionBindingObservation)=>{input.assertCurrent();observation.assertCurrent();for(let index=0;index<ids.length;index++){const id=ids[index]!,meta=observation.metadata(id);if(meta.archived||meta.sessionId!==id||(['subagent','team'].includes(meta.origin??'')?meta.parentSession:undefined)!==ids[index+1]||observation.binding(id).kind!=='absent')throw Error('Unmanaged task host cannot qualify a project binding')}}
  const preflightExit=Promise.withResolvers<void>();scopeExit=preflightExit.promise
  try{await existing({sessionIds:ids,signal:input.signal},async observation=>{check(observation)})}catch(cause){debt=observationCleanupFor(coordinator,cause);scopeFailure={cause};throw cause}finally{preflightExit.resolve()}
  input.assertCurrent()
  checkHistory()
  return Object.freeze({project:Object.freeze({kind:'unmanaged' as const}),metadata:Object.freeze({}),async beforeResultIssue(){if(running)throw Error('Original task host scope unacknowledged');if(debt)throw scopeFailure?.cause},prepare(request:ChildBootstrapCaptureRequest){
   input.assertCurrent()
  checkHistory()
   if(request.core.caller.kind!=='task'||request.core.caller.parentSessionId!==input.parentSessionId)throw Error('Foreign unmanaged task request')
   if(request.requestIntent.project.kind!=='unmanaged')throw Error('Foreign unmanaged task request')
   let closed=false
   return {async run<T>(work:(guards:BootstrapGuards)=>Promise<T>):Promise<T>{
    if(closed)throw Error('Original task host retired')
    running=true
    const exit=Promise.withResolvers<void>();scopeExit=exit.promise
    try{return await target({existingSessionIds:ids,target:request.invocation,signal:input.signal},async observation=>{
     check(observation);if(observation.binding(request.invocation.targetSessionId).kind!=='absent')throw Error('Unmanaged task target has a project binding')
     const assertCurrent=()=>{if(closed)throw Error('Original task host retired');check(observation)}
     return work({signal:input.signal,assertCurrent,dependencies:{async confirm(){throw Error('Unexpected unmanaged task dependency')},async reconcile(){throw Error('Unexpected unmanaged task dependency')}}})
    })}catch(cause){debt=observationCleanupFor(coordinator,cause);scopeFailure={cause};throw cause}finally{running=false;exit.resolve()}
   },close(){closed=true}}
  }})
 }
}
