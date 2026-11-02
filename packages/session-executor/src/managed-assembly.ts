import {createContext,captureExecutionHookChannel,type PluginContext} from '@i-harness/core-plugin'
import {createManagedAgent,createManagedSessionExecutor,type ManagedAgentHost} from '@i-harness/core-agent'
import {createManagedAgentModelOriginOwner} from '@i-harness/core-agent/model-origin'
import {createToolRegistryWithModelOrigin} from '@i-harness/core-tools/model-origin'
import type {Tool} from '@i-harness/core-tools'
import type {ModelClient} from '@i-harness/llm-seam'
import {isManagedExecutionAttachment,type ManagedExecutionAttachment} from '../../session-persistence/src/execution-internal.ts'
import {receivedExecutionInputsFor} from './lifecycle/execution-inputs.ts'
import {createExecutionGenerationLifecycle} from './lifecycle/generation-actions.ts'
import {createExecutionSteerPreparationFactory} from './lifecycle/steer-preparation.ts'
import {createExecutionRuntimeContext} from './lifecycle/execution-runtime-context.ts'
import {createMainInstructionManager} from './context/instructions/manager.ts'
import {createProjectInstructionEnvironment} from './context/instructions/index.ts'
import {mountOwnedFilesystem} from './owned-filesystem.ts'
import {mountOwnedSchedule} from './owned-schedule.ts'
import {createExecutionApprovalPolicy} from '@i-harness/guard-approval'
import {composeCompactConfig,summaryFactory} from './context-composition.ts'
import {diagnosticsFor} from '@i-harness/diagnostics'
import {approxTokens,type CompactionRequest} from '@i-harness/compaction'
import {types} from 'node:util'

/** Capture closed host binding data without invoking caller getters. The
 * documented compact model slots retain their original client identity. */
function captureBindingData<T>(input:T,preserveSummaryModel=false):T {
 const seen=new WeakMap<object,unknown>()
 const copy=(value:unknown,path:string[]=[]):unknown=>{
  if(preserveSummaryModel&&path.at(-1)==='summarizationModel'&&(path.length===1||path.length===3&&path[0]==='modelPolicies'))return value
  if(!value||typeof value!=='object')return value
  if(types.isProxy(value))throw TypeError('Proxy model binding data unsupported')
  const array=Array.isArray(value),prototype=Object.getPrototypeOf(value)
  if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)throw TypeError('Nonplain model binding data unsupported')
  const prior=seen.get(value);if(prior)return prior
  const descriptors=Object.getOwnPropertyDescriptors(value)
  if(Reflect.ownKeys(descriptors).some(name=>typeof name!=='string'||!('value' in descriptors[name as keyof typeof descriptors]!)))throw TypeError('Accessor model binding data unsupported')
  const out:Array<unknown>|Record<string,unknown>=array?new Array((value as unknown[]).length):{}
  seen.set(value,out)
  for(const [name,descriptor] of Object.entries(descriptors)){if(name==='length'&&array||!descriptor.enumerable)continue;Object.defineProperty(out,name,{value:copy(descriptor.value,[...path,name]),enumerable:true,writable:true,configurable:true})}
  return out
 }
 return copy(input) as T
}

/** Internal explicit-tool construction. The public default assembly keeps its
 * complete compatibility contract until its feature adapters are composed. */
export interface ManagedExecutionRuntimeOptions extends Pick<ManagedAgentHost,'modelActionTimeoutMs'|'modelActionMaxAttempts'|'reasoningEffort'|'maxParallelToolCalls'|'budgetBinding'|'contextMetadata'|'telemetry'> {
 execution:ManagedExecutionAttachment
 workspace?:string
 originalFilesystem?:boolean
 originalSchedule?:boolean
 scheduleWake?:(inputId:string,text:string)=>void
 prepareInput?:(text:string)=>Promise<string>
 retainConstructionCleanup?:(cleanup:()=>Promise<void>)=>void
 /** Original constructor-created context; CORE authenticates its real hook scope. */
 context?:PluginContext
 model:ModelClient
 systemPrompt:ManagedAgentHost['systemPrompt']
 tools:readonly Tool[]
 contextWindow?:number
 compact?:CompactionRequest
 autoCompactionEnabled?:ManagedAgentHost['autoCompactionEnabled']
 maxOutputTokens?:number
 requestContext?:ManagedAgentHost['requestContext']
 passiveGeneration?:import('@i-harness/llm-seam/internal/passive-observation').OriginalPassiveObserver
}
export interface ManagedExecutionModelBinding {
 model:ModelClient
 contextWindow?:number
 maxOutputTokens?:number
 reasoningEffort?:ManagedAgentHost['reasoningEffort']
 budgetBinding?:import('@i-harness/llm-seam').ModelBudgetBinding
 contextMetadata?:import('@i-harness/core-session').ContextBindingMetadata
}
export function createManagedExecutionRuntime(options:ManagedExecutionRuntimeOptions){
 const {execution}=options
 if(!isManagedExecutionAttachment(execution))throw TypeError('Original execution attachment required')
 const ctx=options.context??createContext(),origin=createManagedAgentModelOriginOwner(ctx,execution)
 let model=options.model,reasoningEffort=options.reasoningEffort
 let requestContext=options.requestContext
 let manager:ReturnType<typeof createMainInstructionManager>|undefined
 if(options.workspace!==undefined&&requestContext===undefined){
  if(!options.retainConstructionCleanup)throw TypeError('Original instruction cleanup retention required')
  const environment=createProjectInstructionEnvironment()
  let runtime:ReturnType<typeof createExecutionRuntimeContext>|undefined

  let retired=false
  const cleanup=async()=>{retired=true;await manager?.close();await runtime?.close();await environment.close()}
  options.retainConstructionCleanup(cleanup)
  runtime=createExecutionRuntimeContext(execution,origin.domain)
  manager=createMainInstructionManager({domain:origin.domain,environment,cwd:options.workspace,
   authority:()=>({kind:'unbound',revision:'configured-workspace',workspaceRoot:options.workspace!}),available:()=>!retired,
   publish:(signal,retain)=>runtime!.render(signal,retain)})
  runtime.registerSection('instructions',()=>manager!.text())
  requestContext=manager
 }
 const pair=createToolRegistryWithModelOrigin(ctx,{executionOwner:{kind:'managed-execution',domain:origin.domain,context:ctx,sessionId:origin.domain.sessionId}},origin.verifier)
 if(options.originalFilesystem){if(options.workspace===undefined||!manager)throw TypeError('Original filesystem instruction manager and workspace required');mountOwnedFilesystem({ctx,tools:pair.registry,workspace:options.workspace,domain:origin.domain,manager})}
 let startSchedule:(()=>Promise<void>)|undefined
 if(options.originalSchedule){if(!options.retainConstructionCleanup||!options.scheduleWake)throw TypeError('Original schedule retention and wake required');startSchedule=mountOwnedSchedule({execution,domain:origin.domain,ctx,tools:pair.registry,wake:options.scheduleWake,retain:options.retainConstructionCleanup})}
 for(const tool of options.tools)pair.registry.register(tool)
 if(options.originalFilesystem||options.originalSchedule){if(options.workspace===undefined)throw TypeError('Original policy workspace required');createExecutionApprovalPolicy(ctx,pair.registry,{workspace:options.workspace,workspaceRoots:()=>[options.workspace!]})}
 const overhead=options.contextWindow===undefined?undefined:approxTokens(typeof options.systemPrompt==='function'?options.systemPrompt():options.systemPrompt)+approxTokens(JSON.stringify(pair.registry.schemas()))
 const compact=composeCompactConfig(options.compact,options.contextWindow,overhead,diagnosticsFor('mount'))
 const inputs=receivedExecutionInputsFor(execution)
 const agent=createManagedAgent(ctx,{execution,domain:origin.domain,hooks:captureExecutionHookChannel(ctx),modelCallOrigin:origin.bind(pair.registry,pair.driver),tools:pair.registry,get model(){return model},systemPrompt:options.systemPrompt,
  ...(options.contextWindow!==undefined?{budget:{contextWindow:options.contextWindow,overheadTokens:overhead}}:{}),...(compact?{compact}:{}),summaryFactory,...(options.autoCompactionEnabled!==undefined?{autoCompactionEnabled:options.autoCompactionEnabled}:{}),maxOutputTokens:options.maxOutputTokens,requestContext,
  modelActionTimeoutMs:options.modelActionTimeoutMs,modelActionMaxAttempts:options.modelActionMaxAttempts,get reasoningEffort(){return reasoningEffort},maxParallelToolCalls:options.maxParallelToolCalls,budgetBinding:options.budgetBinding,contextMetadata:options.contextMetadata,telemetry:options.telemetry,modelBindingIdentity:()=>model,
  stepInputs:{claimAtStepBoundary:(facts,prepare,claim)=>inputs.inbox.claimAtStepBoundary(facts,prepare,claim)},
  generationFactory:(action,dependencies)=>{
   if(options.passiveGeneration&&!dependencies)throw TypeError('Original generation drain required for passive observation')
   return createExecutionGenerationLifecycle(execution,origin.domain.sessionId,action,undefined,dependencies&&options.passiveGeneration?{...dependencies,passiveGeneration:options.passiveGeneration}:dependencies)
  },
  inputPreparationFactory:createExecutionSteerPreparationFactory(execution,inputs.inbox,options.prepareInput)})
 const lane=createManagedSessionExecutor({execution,agent})
 let closeFlight:Promise<void>|undefined,closed=false
 const runtime=Object.freeze({startSchedule,execution,domain:origin.domain,ctx,tools:pair.registry,agent,lane,inbox:inputs.inbox,
  setModelBinding(binding:ManagedExecutionModelBinding,compactRequest?:CompactionRequest){
   if(this!==runtime||closed||closeFlight)throw TypeError('Original open managed runtime required')
   origin.domain.assertCurrent()
   if(lane.isRunning())throw Error('session is busy')
   if(!binding||types.isProxy(binding)||Object.getPrototypeOf(binding)!==Object.prototype&&Object.getPrototypeOf(binding)!==null)throw TypeError('Original model binding data required')
   const fields=Object.getOwnPropertyDescriptors(binding)
   if(!fields.model||Reflect.ownKeys(fields).some(name=>!('value' in fields[name as keyof typeof fields]!)))throw TypeError('Accessor model binding data unsupported')
   const nextModel=fields.model.value as ModelClient,nextEffort=fields.reasoningEffort?.value as ManagedExecutionModelBinding['reasoningEffort']
   const window=fields.contextWindow?.value as number|undefined,output=fields.maxOutputTokens?.value as number|undefined
   const budgetBinding=captureBindingData(fields.budgetBinding?.value as ManagedExecutionModelBinding['budgetBinding'])
   const contextMetadata=captureBindingData(fields.contextMetadata?.value as ManagedExecutionModelBinding['contextMetadata'])
   const compactData=captureBindingData(compactRequest,true)
   const overhead=approxTokens(typeof options.systemPrompt==='function'?options.systemPrompt():options.systemPrompt)+approxTokens(JSON.stringify(pair.registry.schemas()))
   const update={budgetBinding,contextMetadata,...(window===undefined?{}:{budget:{contextWindow:window,overheadTokens:overhead},...(compactData===undefined?{}:{compact:{...compactData,contextWindow:window,overheadTokens:compactData.overheadTokens??overhead}})}),...(output===undefined?{}:{maxOutputTokens:output})}
   if(closed||closeFlight)throw TypeError('Original open managed runtime required')
   if(lane.isRunning())throw Error('session is busy')
   origin.domain.assertCurrent()
   agent.updateContext!(update)
   model=nextModel;reasoningEffort=nextEffort
  },
  close(){if(this!==runtime)return Promise.reject(TypeError('Original managed runtime required'));if(closed)return Promise.resolve();if(closeFlight)return closeFlight;lane.dispose();const flight=Promise.allSettled([lane.drain()]).then(()=>{closed=true});closeFlight=flight;return flight}})
 return runtime
}
