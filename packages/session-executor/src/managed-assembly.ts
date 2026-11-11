import {createContext,captureExecutionHookChannel,type PluginContext} from '@i-harness/core-plugin'
import {createManagedAgent,createManagedSessionExecutor,type ManagedAgentHost} from '@i-harness/core-agent'
import {createManagedAgentModelOriginOwner} from '@i-harness/core-agent/model-origin'
import {createToolRegistryWithModelOrigin} from '@i-harness/core-tools/model-origin'
import type {Tool,ToolResultRetention} from '@i-harness/core-tools'
import type {ModelClient} from '@i-harness/llm-seam'
import {isManagedExecutionAttachment,type ManagedExecutionAttachment} from '../../session-persistence/src/execution-internal.ts'
import {receivedExecutionInputsFor} from './lifecycle/execution-inputs.ts'
import {createExecutionGenerationLifecycle} from './lifecycle/generation-actions.ts'
import {createExecutionSteerPreparationFactory} from './lifecycle/steer-preparation.ts'
import {createExecutionRuntimeContext} from './lifecycle/execution-runtime-context.ts'
import {createMainInstructionManager,isOriginalAcceptedInstructionOrigin,retainOriginalInstructionCell} from './context/instructions/manager.ts'
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

export interface OwnedInstructionBinding {
 readonly environment:import('./context/instructions/contracts.ts').InstructionEnvironment
 readonly cwd:string
 authority():import('@i-harness/sandbox').AuthorityState
 available():boolean
}

/** Internal explicit-tool construction. The public default assembly keeps its
 * complete compatibility contract until its feature adapters are composed. */
export interface ManagedExecutionRuntimeOptions extends Pick<ManagedAgentHost,'modelActionTimeoutMs'|'modelActionMaxAttempts'|'reasoningEffort'|'maxParallelToolCalls'|'budgetBinding'|'contextMetadata'|'telemetry'> {
 execution:ManagedExecutionAttachment
 resultRetention?:ToolResultRetention
 workspace?:string
 instructionBinding?:OwnedInstructionBinding
 originalFilesystem?:boolean
 requireFilesystemPolicy?:boolean
 filesystemPolicy?:import('./execution-runtime.ts').OriginalFilesystemPolicy
 originalSchedule?:boolean
 originalApproval?:boolean
 approvalMode?:import('@i-harness/guard-approval').ApprovalConfig['mode']
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
 defaultSurface?:OwnedDefaultSurface
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
export interface ManagedRegistryConstruction {
 readonly ctx:PluginContext
 readonly tools:ReturnType<typeof createToolRegistryWithModelOrigin>['registry']
 readonly domain:ReturnType<typeof createManagedAgentModelOriginOwner>['domain']
 readonly execution:ManagedExecutionAttachment
 readonly instructions?:Readonly<{manager:ReturnType<typeof createMainInstructionManager>;runtime:ReturnType<typeof createExecutionRuntimeContext>;environment:OwnedInstructionBinding['environment'];cwd:string;authority:OwnedInstructionBinding['authority'];available:OwnedInstructionBinding['available']}>
 assertCurrent():void
 /** Existing construction lifetime only; grants no fresh execution admission. */
 assertLifetimeCurrent():void
 retain(cleanup:()=>void|Promise<void>):void
}
export interface OwnedDefaultSurface {
 systemPrompt():string
 modelToolSchemas():import('@i-harness/llm-seam').ToolSchema[]
 modelOverheadTokens():number
 prepareInput(text:string):Promise<string>
 reconcileAuthority():Promise<void>
 prepareModelSurface?(signal:AbortSignal):Promise<void>
}
export type ManagedRegistryFactory=(original:ManagedRegistryConstruction)=>void|OwnedDefaultSurface|Promise<void|OwnedDefaultSurface>
type ResolvedManagedModel=Pick<ManagedExecutionRuntimeOptions,'model'|'contextWindow'|'maxOutputTokens'|'reasoningEffort'|'budgetBinding'|'contextMetadata'>
function prepare(options:Omit<ManagedExecutionRuntimeOptions,keyof ResolvedManagedModel>,deferFilesystem=false){
 const {execution}=options
 if(!isManagedExecutionAttachment(execution))throw TypeError('Original execution attachment required')
 const ctx=options.context??createContext(),origin=createManagedAgentModelOriginOwner(ctx,execution)
 let requestContext=options.requestContext
 let manager:ReturnType<typeof createMainInstructionManager>|undefined
 let instructionRuntime:ReturnType<typeof createExecutionRuntimeContext>|undefined
 let instructionBinding:OwnedInstructionBinding|undefined
 if((options.workspace!==undefined||options.instructionBinding)&&requestContext===undefined){
  if(!options.retainConstructionCleanup)throw TypeError('Original instruction cleanup retention required')
  const supplied=options.instructionBinding
  if(supplied&&types.isProxy(supplied))throw TypeError('Original instruction binding required')
  const fields=supplied?Object.getOwnPropertyDescriptors(supplied):undefined
  if(fields&&(Reflect.ownKeys(fields).some(key=>!['environment','cwd','authority','available'].includes(key as string))||!['environment','cwd','authority','available'].every(key=>fields[key]&&'value'in fields[key]!)))throw TypeError('Closed instruction binding required')
  if(fields&&(!fields.environment!.value||typeof fields.cwd!.value!=='string'||!fields.cwd!.value))throw TypeError('Original instruction binding required')
  const environment=fields?fields.environment!.value as OwnedInstructionBinding['environment']:createProjectInstructionEnvironment(),cwd=fields?fields.cwd!.value as string:options.workspace!
  const authorityMethod=fields?.authority?.value,availableMethod=fields?.available?.value
  if(!cwd||supplied&&(!environment||typeof authorityMethod!=='function'||types.isProxy(authorityMethod)||typeof availableMethod!=='function'||types.isProxy(availableMethod)))throw TypeError('Original instruction binding required')
  const check=()=>{if(supplied)for(const key of ['environment','cwd','authority','available'] as const)if(Object.getOwnPropertyDescriptor(supplied,key)?.value!==fields![key]!.value)throw Error('Original instruction binding changed')}
  const authority=supplied?()=>{check();return Reflect.apply(authorityMethod!,supplied,[]) as import('@i-harness/sandbox').AuthorityState}:()=>({kind:'unbound' as const,revision:'configured-workspace',workspaceRoot:cwd})
  let retired=false
  const cleanup=async()=>{retired=true;await manager?.close();await instructionRuntime?.close();if(!supplied)await environment.close()}
  options.retainConstructionCleanup(cleanup)
  instructionBinding={environment,cwd,authority,available:()=>{if(retired)return false;if(!supplied)return true;check();return Reflect.apply(availableMethod!,supplied,[])===true}}
  instructionRuntime=createExecutionRuntimeContext(execution,origin.domain)
  manager=createMainInstructionManager({domain:origin.domain,environment,cwd,
   authority,available:instructionBinding.available,
   publish:(signal,retain)=>instructionRuntime!.render(signal,retain)})
  instructionRuntime.registerSection('instructions',()=>manager!.text())
  requestContext=manager
 }
 const pair=createToolRegistryWithModelOrigin(ctx,{resultRetention:options.resultRetention,executionOwner:{kind:'managed-execution',domain:origin.domain,context:ctx,sessionId:origin.domain.sessionId},...(manager?{instructionsRequired:true,instructionOriginVerifier:isOriginalAcceptedInstructionOrigin,instructionCellRetainer:retainOriginalInstructionCell}:{})},origin.verifier)
 const mountFilesystem=(rewind?:import('@i-harness/fs').RewindCapture)=>{if(!options.originalFilesystem||options.workspace===undefined||!manager)throw TypeError('Original filesystem instruction manager and workspace required');if(options.requireFilesystemPolicy&&!options.filesystemPolicy)throw TypeError('Original filesystem policy required');mountOwnedFilesystem({ctx,tools:pair.registry,workspace:options.workspace,domain:origin.domain,manager,...options.filesystemPolicy?{policy:options.filesystemPolicy}:{},...rewind?{rewind}:{}})}
 if(options.originalFilesystem&&!deferFilesystem)mountFilesystem()
 let startSchedule:(()=>Promise<void>)|undefined
 if(options.originalSchedule){if(!options.retainConstructionCleanup||!options.scheduleWake)throw TypeError('Original schedule retention and wake required');startSchedule=mountOwnedSchedule({execution,domain:origin.domain,ctx,tools:pair.registry,wake:options.scheduleWake,retain:options.retainConstructionCleanup})}
 for(const tool of options.tools)pair.registry.register(tool)
 if(options.originalFilesystem||options.originalSchedule||options.originalApproval){if(options.workspace===undefined)throw TypeError('Original policy workspace required');createExecutionApprovalPolicy(ctx,pair.registry,{workspace:options.workspace,workspaceRoots:()=>{const authority=instructionBinding?.authority();if(authority?.kind==='revoked'||authority?.kind==='unavailable')throw Error('Execution authority '+authority.kind+': '+authority.reason);return authority?.kind==='bound'?[...authority.roots]:[authority?.workspaceRoot??options.workspace!]},...(options.approvalMode!==undefined?{mode:options.approvalMode}:{})})}
 return {execution,ctx,origin,pair,requestContext,manager,instructionRuntime,instructionBinding,startSchedule,mountFilesystem}
}
function finish(options:ManagedExecutionRuntimeOptions,prepared:ReturnType<typeof prepare>,registerClose?:(close:()=>Promise<void>)=>void,onClose?:()=>void){
 const {execution,ctx,origin,pair,requestContext,startSchedule}=prepared
 let model=options.model,reasoningEffort=options.reasoningEffort
 let selectedBinding:ResolvedManagedModel={model,contextWindow:options.contextWindow,maxOutputTokens:options.maxOutputTokens,reasoningEffort,budgetBinding:options.budgetBinding,contextMetadata:options.contextMetadata}
 let lane:ReturnType<typeof createManagedSessionExecutor>|undefined
 let closeFlight:Promise<void>|undefined,closed=false
 const close=()=>{onClose?.();if(closed)return Promise.resolve();if(closeFlight)return closeFlight;lane?.dispose();const flight=Promise.allSettled(lane?[lane.drain()]:[]).then(()=>{closed=true});closeFlight=flight;return flight}
 registerClose?.(close)
 const surface=options.defaultSurface
 const overhead=options.contextWindow===undefined||surface?.prepareModelSurface?undefined:surface?surface.modelOverheadTokens():approxTokens(typeof options.systemPrompt==='function'?options.systemPrompt():options.systemPrompt)+approxTokens(JSON.stringify(pair.registry.schemas()))
 const compact=composeCompactConfig(options.compact,options.contextWindow,overhead,diagnosticsFor('mount'))
 const inputs=receivedExecutionInputsFor(execution)
 const agent=createManagedAgent(ctx,{execution,domain:origin.domain,hooks:captureExecutionHookChannel(ctx),modelCallOrigin:origin.bind(pair.registry,pair.driver),tools:pair.registry,get model(){return model},systemPrompt:surface?()=>surface.systemPrompt():options.systemPrompt,...surface?{modelToolSchemas:()=>surface.modelToolSchemas(),modelOverheadTokens:()=>surface.modelOverheadTokens(),...surface.prepareModelSurface?{prepareModelSurface:(signal:AbortSignal)=>surface.prepareModelSurface!(signal)}:{}}:{},
  ...(options.contextWindow!==undefined?{budget:{contextWindow:options.contextWindow,overheadTokens:overhead}}:{}),...(compact?{compact}:{}),summaryFactory,...(options.autoCompactionEnabled!==undefined?{autoCompactionEnabled:options.autoCompactionEnabled}:{}),maxOutputTokens:options.maxOutputTokens,requestContext,
  modelActionTimeoutMs:options.modelActionTimeoutMs,modelActionMaxAttempts:options.modelActionMaxAttempts,get reasoningEffort(){return reasoningEffort},maxParallelToolCalls:options.maxParallelToolCalls,budgetBinding:options.budgetBinding,contextMetadata:options.contextMetadata,telemetry:options.telemetry,modelBindingIdentity:()=>model,
  stepInputs:{claimAtStepBoundary:(facts,prepare,claim)=>inputs.inbox.claimAtStepBoundary(facts,prepare,claim)},
  generationFactory:(action,dependencies)=>{
   if(options.passiveGeneration&&!dependencies)throw TypeError('Original generation drain required for passive observation')
   return createExecutionGenerationLifecycle(execution,origin.domain.sessionId,action,undefined,dependencies&&options.passiveGeneration?{...dependencies,passiveGeneration:options.passiveGeneration}:dependencies)
  },
  inputPreparationFactory:createExecutionSteerPreparationFactory(execution,inputs.inbox,surface?async text=>{await surface.reconcileAuthority();return surface.prepareInput(text)}:options.prepareInput)})
 lane=createManagedSessionExecutor({execution,agent})
 const originalLane=lane
 const runtime=Object.freeze({instructionDiagnostics:prepared.manager?.diagnostics,startSchedule,prepareInput:surface?async(text:string)=>{await surface.reconcileAuthority();return surface.prepareInput(text)}:options.prepareInput,reconcileAuthority:surface?()=>surface.reconcileAuthority():undefined,execution,domain:origin.domain,ctx,tools:pair.registry,agent,lane:originalLane,inbox:inputs.inbox,
  selectedModelBinding(){if(this!==runtime||closed||closeFlight)throw TypeError('Original open managed runtime required');origin.domain.assertCurrent();const budgetBinding=typeof selectedBinding.budgetBinding==='function'?selectedBinding.budgetBinding():selectedBinding.budgetBinding,contextMetadata=typeof selectedBinding.contextMetadata==='function'?selectedBinding.contextMetadata():selectedBinding.contextMetadata;if(closed||closeFlight)throw TypeError('Original open managed runtime required');origin.domain.assertCurrent();return {...selectedBinding,budgetBinding,contextMetadata}},
  setModelBinding(binding:ManagedExecutionModelBinding,compactRequest?:CompactionRequest){
   if(this!==runtime||closed||closeFlight)throw TypeError('Original open managed runtime required')
   origin.domain.assertCurrent()
   if(originalLane.isRunning())throw Error('session is busy')
   if(!binding||types.isProxy(binding)||Object.getPrototypeOf(binding)!==Object.prototype&&Object.getPrototypeOf(binding)!==null)throw TypeError('Original model binding data required')
   const fields=Object.getOwnPropertyDescriptors(binding)
   if(!fields.model||Reflect.ownKeys(fields).some(name=>!('value' in fields[name as keyof typeof fields]!)))throw TypeError('Accessor model binding data unsupported')
   const nextModel=fields.model.value as ModelClient,nextEffort=fields.reasoningEffort?.value as ManagedExecutionModelBinding['reasoningEffort']
   const window=fields.contextWindow?.value as number|undefined,output=fields.maxOutputTokens?.value as number|undefined
   const budgetBinding=captureBindingData(fields.budgetBinding?.value as ManagedExecutionModelBinding['budgetBinding'])
   const contextMetadata=captureBindingData(fields.contextMetadata?.value as ManagedExecutionModelBinding['contextMetadata'])
   const compactData=captureBindingData(compactRequest,true)
   const overhead=surface?.prepareModelSurface?undefined:surface?surface.modelOverheadTokens():approxTokens(typeof options.systemPrompt==='function'?options.systemPrompt():options.systemPrompt)+approxTokens(JSON.stringify(pair.registry.schemas()))
   const update={budgetBinding,contextMetadata,...(window===undefined?{}:{budget:{contextWindow:window,...overhead===undefined?{}:{overheadTokens:overhead}},...(compactData===undefined?{}:{compact:{...compactData,contextWindow:window,...compactData.overheadTokens!==undefined?{overheadTokens:compactData.overheadTokens}:overhead!==undefined?{overheadTokens:overhead}:{}}})}),...(output===undefined?{}:{maxOutputTokens:output})}
   if(closed||closeFlight)throw TypeError('Original open managed runtime required')
   if(originalLane.isRunning())throw Error('session is busy')
   origin.domain.assertCurrent()
   agent.updateContext!(update)
   model=nextModel;reasoningEffort=nextEffort;selectedBinding={model:nextModel,reasoningEffort:nextEffort,contextWindow:window,maxOutputTokens:output,budgetBinding,contextMetadata}
  },
  close(){if(this!==runtime)return Promise.reject(TypeError('Original managed runtime required'));return close()}})
 return runtime
}

export function createManagedExecutionRuntime(options:ManagedExecutionRuntimeOptions){return finish(options,prepare(options))}
export async function createManagedExecutionRuntimeWithRegistry(options:Omit<ManagedExecutionRuntimeOptions,keyof ResolvedManagedModel>&{
 configureRegistry:ManagedRegistryFactory
 prepareFilesystem?(original:ManagedRegistryConstruction):Promise<import('@i-harness/fs').RewindCapture|undefined>
 resolveModel():ResolvedManagedModel|Promise<ResolvedManagedModel>
 assertConstructionCurrent():void
 retainConstructionCleanup(cleanup:()=>Promise<void>):void
}):Promise<ReturnType<typeof createManagedExecutionRuntime>>{
 let retired=false,retaining=true
 options.assertConstructionCurrent()
 const prepared=prepare(options,!!options.prepareFilesystem)
 const assertLifetimeCurrent=()=>{if(retired)throw Error('Original construction retired');options.assertConstructionCurrent()}
 const assertCurrent=()=>{assertLifetimeCurrent();prepared.origin.domain.assertCurrent()}
 options.retainConstructionCleanup(async()=>{retired=true})
 const original:ManagedRegistryConstruction={ctx:prepared.ctx,tools:prepared.pair.registry,domain:prepared.origin.domain,execution:prepared.execution,
  ...(prepared.manager&&prepared.instructionRuntime&&prepared.instructionBinding?{instructions:{manager:prepared.manager,runtime:prepared.instructionRuntime,environment:prepared.instructionBinding.environment,cwd:prepared.instructionBinding.cwd,authority:prepared.instructionBinding.authority,available:prepared.instructionBinding.available}}:{}),assertCurrent,assertLifetimeCurrent,
  retain(cleanup){if(!retaining)throw Error('Original construction retention expired');assertCurrent();if(typeof cleanup!=='function')throw TypeError('Original mount cleanup required');options.retainConstructionCleanup(async()=>{await cleanup()})}}
 let defaultSurface:void|OwnedDefaultSurface
 try{assertCurrent();if(options.prepareFilesystem){if(!options.originalFilesystem)throw TypeError('Original filesystem required for rewind');const rewind=await options.prepareFilesystem(original);assertCurrent();prepared.mountFilesystem(rewind);assertCurrent()}defaultSurface=await options.configureRegistry(original)}finally{retaining=false}
 if(defaultSurface){
  const originalSurface=defaultSurface,names=['systemPrompt','modelToolSchemas','modelOverheadTokens','prepareInput','reconcileAuthority'] as const
  if(types.isProxy(originalSurface))throw TypeError('Original default surface required')
  const methods=names.map(name=>Object.getOwnPropertyDescriptor(originalSurface,name)),prepareSurface=Object.getOwnPropertyDescriptor(originalSurface,'prepareModelSurface')
  if(prepareSurface&&(!('value'in prepareSurface)||typeof prepareSurface.value!=='function'||types.isProxy(prepareSurface.value)))throw TypeError('Original model surface preparation required')
  if(methods.some(field=>!field||!('value' in field)||typeof field.value!=='function'||types.isProxy(field.value)))throw TypeError('Original default surface methods required')
  const check=()=>{assertCurrent();for(let i=0;i<names.length;i++)if(Object.getOwnPropertyDescriptor(originalSurface,names[i]!)?.value!==methods[i]!.value)throw Error('Original default surface changed');const now=Object.getOwnPropertyDescriptor(originalSurface,'prepareModelSurface');if(Boolean(now)!==Boolean(prepareSurface)||now&&(!('value'in now)||now.value!==prepareSurface?.value))throw Error('Original model surface preparation changed')}
  const call=(index:number,...args:unknown[])=>{check();return Reflect.apply(methods[index]!.value,originalSurface,args)}
  defaultSurface=Object.freeze({systemPrompt:()=>call(0) as string,modelToolSchemas:()=>call(1) as import('@i-harness/llm-seam').ToolSchema[],modelOverheadTokens:()=>call(2) as number,async prepareInput(text:string){const value=await call(3,text);check();return value as string},async reconcileAuthority(){await call(4);check()},...prepareSurface?{async prepareModelSurface(signal:AbortSignal){check();await Reflect.apply(prepareSurface.value,originalSurface,[signal]);check()}}:{}})
 }
 assertCurrent();captureExecutionHookChannel(prepared.ctx).capture()
 const resolved=await options.resolveModel()
 assertCurrent();captureExecutionHookChannel(prepared.ctx).capture()
 return finish({...options,...resolved,...defaultSurface?{defaultSurface}:{}},prepared,options.retainConstructionCleanup,()=>{retired=true})
}
