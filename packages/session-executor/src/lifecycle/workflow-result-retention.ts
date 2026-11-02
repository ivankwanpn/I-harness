import {createResultCapture} from '@i-harness/output-retention'
import {validWorkflowRunResult,type ProducerFactOutcome,type SettlementFacts} from '@i-harness/core-session'
import {isManagedExecutionSource,type ManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
import type {ContextCapture,ContextOutputService,ResultArtifactScope} from '@i-harness/context-output'
import {isOriginalWorkflowCompletion,type OwnedWorkflowRunHandle,type WorkflowLoopCompletion} from '../../../workflow/src/runner.ts'

/** Original retained workflow run and held completion source own this artifact. */
export function createWorkflowResultRetention(options:{service:ContextOutputService;sourceFor(sessionId:string):Promise<ContextCapture['source']>;domain:ManagedExecutionDomain}){
 const {service,domain}=options,sourceFor=options.sourceFor.bind(options),captures=new WeakSet<object>()
 return function capture(run:OwnedWorkflowRunHandle,completion:WorkflowLoopCompletion,source:SettlementFacts<ProducerFactOutcome>,callId:string){
  if(!isOriginalWorkflowCompletion(run,completion)||!isManagedExecutionSource(domain,source)||completion.cleanup!=='clean'||completion.dispatch!=='dispatched'||!['completed','error'].includes(completion.status)||!validWorkflowRunResult(completion.result)||completion.result.invocationId!==run.invocationId||typeof callId!=='string'||!callId)throw TypeError('Original clean Workflow completion required')
  source.assertHeld();if(captures.has(run))throw Error('Original Workflow result already captured');captures.add(run);let active=true,scope:ResultArtifactScope|undefined
  const current=()=>{if(!isOriginalWorkflowCompletion(run,completion)||!isManagedExecutionSource(domain,source))throw TypeError('Original Workflow retention retired');source.assertHeld()}
  const outcome=completion.status==='completed'?'succeeded' as const:'failed' as const,descriptor=sourceFor(domain.sessionId)
  void descriptor.catch(()=>{})
  const original=createResultCapture(completion.result,{dispatch:'dispatched',outcome},{forceArtifact:true,completeness:completion.resultCompleteness,async openArtifact(){current();const selected=await descriptor;current();if(!selected?.sourceId)throw Object.assign(Error('Original Workflow result source unavailable'),{code:'ARTIFACT_OWNER_UNSUPPORTED'});scope??=service.registerResultScope({operationId:run.invocationId,sessionId:domain.sessionId,callId,source:selected},()=>{try{if(!active)return false;current();return true}catch{return false}});return service.beginResult(scope,'json-utf8-v1')}})
  let result:Awaited<ReturnType<typeof original.settle>>|undefined,flight:Promise<Awaited<ReturnType<typeof original.settle>>>|undefined
  return Object.freeze({settle(){current();if(result)return Promise.resolve(result);if(flight)return flight;const pending=(async()=>{current();const value=await original.settle();current();if(value.kind!=='ready')return value;if(value.envelope.retention.kind==='artifact'){if(!scope)throw Error('Original Workflow result scope unavailable');try{await service.confirmResultOwner(scope,value.envelope.retention.ref)}catch{return {kind:'recovery-required' as const}}current()}active=false;return result=value})();flight=pending;void pending.finally(()=>{if(flight===pending)flight=undefined}).catch(()=>{});return pending}})
 }
}
