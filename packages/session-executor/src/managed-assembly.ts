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

/** Internal explicit-tool construction. The public default assembly keeps its
 * complete compatibility contract until its feature adapters are composed. */
export interface ManagedExecutionRuntimeOptions extends Pick<ManagedAgentHost,'modelActionTimeoutMs'|'modelActionMaxAttempts'|'reasoningEffort'|'maxParallelToolCalls'|'budgetBinding'|'contextMetadata'|'telemetry'> {
 execution:ManagedExecutionAttachment
 /** Original constructor-created context; CORE authenticates its real hook scope. */
 context?:PluginContext
 model:ModelClient
 systemPrompt:string
 tools:readonly Tool[]
 contextWindow?:number
 maxOutputTokens?:number
 requestContext?:ManagedAgentHost['requestContext']
 passiveGeneration?:import('@i-harness/llm-seam/internal/passive-observation').OriginalPassiveObserver
}
export function createManagedExecutionRuntime(options:ManagedExecutionRuntimeOptions){
 const {execution}=options
 if(!isManagedExecutionAttachment(execution))throw TypeError('Original execution attachment required')
 const ctx=options.context??createContext(),origin=createManagedAgentModelOriginOwner(ctx,execution),model=options.model
 const pair=createToolRegistryWithModelOrigin(ctx,{executionOwner:{kind:'managed-execution',domain:origin.domain,context:ctx,sessionId:origin.domain.sessionId}},origin.verifier)
 for(const tool of options.tools)pair.registry.register(tool)
 const inputs=receivedExecutionInputsFor(execution)
 const agent=createManagedAgent(ctx,{execution,domain:origin.domain,hooks:captureExecutionHookChannel(ctx),modelCallOrigin:origin.bind(pair.registry,pair.driver),tools:pair.registry,model,systemPrompt:options.systemPrompt,
  ...(options.contextWindow!==undefined?{budget:{contextWindow:options.contextWindow}}:{}),maxOutputTokens:options.maxOutputTokens,requestContext:options.requestContext,
  modelActionTimeoutMs:options.modelActionTimeoutMs,modelActionMaxAttempts:options.modelActionMaxAttempts,reasoningEffort:options.reasoningEffort,maxParallelToolCalls:options.maxParallelToolCalls,budgetBinding:options.budgetBinding,contextMetadata:options.contextMetadata,telemetry:options.telemetry,modelBindingIdentity:()=>model,
  stepInputs:{claimAtStepBoundary:(facts,prepare,claim)=>inputs.inbox.claimAtStepBoundary(facts,prepare,claim)},
  generationFactory:(action,dependencies)=>{
   if(options.passiveGeneration&&!dependencies)throw TypeError('Original generation drain required for passive observation')
   return createExecutionGenerationLifecycle(execution,origin.domain.sessionId,action,undefined,dependencies&&options.passiveGeneration?{...dependencies,passiveGeneration:options.passiveGeneration}:dependencies)
  },
  inputPreparationFactory:createExecutionSteerPreparationFactory(execution,inputs.inbox)})
 const lane=createManagedSessionExecutor({execution,agent})
 let closeFlight:Promise<void>|undefined,closed=false
 const runtime=Object.freeze({execution,domain:origin.domain,ctx,tools:pair.registry,agent,lane,inbox:inputs.inbox,
  close(){if(this!==runtime)return Promise.reject(TypeError('Original managed runtime required'));if(closed)return Promise.resolve();if(closeFlight)return closeFlight;lane.dispose();const flight=Promise.allSettled([lane.drain()]).then(()=>{closed=true});closeFlight=flight;return flight}})
 return runtime
}
