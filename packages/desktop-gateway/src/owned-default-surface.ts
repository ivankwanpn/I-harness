import type { ToolSchema } from '@i-harness/llm-seam'
import type { ExecutionObservation } from '@i-harness/core-session/internal/execution'
import { approxTokens } from '../../compaction/src/index.ts'
import { DEFAULT_AGENT_PRESET, parsePreset } from '../../preset/src/index.ts'
import type { ManagedRegistryConstruction, OwnedDefaultSurface } from '../../session-executor/src/managed-assembly.ts'
export type { OwnedDefaultSurface } from '../../session-executor/src/managed-assembly.ts'
import { createOwnedMetadataContext } from '../../session-executor/src/lifecycle/owned-metadata-context.ts'
import { mountOwnedPlan } from './owned-plan.ts'
import { createDesktopOwnedGoalTools } from './workflow.ts'

/** Compose only after all configured native, child, plugin and Code owners are
 * mounted on original.tools. Required callbacks remain live owner reads. */
export async function createOwnedDefaultSurface(original:ManagedRegistryConstruction, options:{
 initialPlanMode?:boolean
 preset?: Parameters<typeof parsePreset>[0]
 policyPrompt(observation:ExecutionObservation):string
 shellPrompt(observation:ExecutionObservation):string
 projectPrompt(observation:ExecutionObservation):string
 hookPrompt():string; recoveryPrompt():string
 schemas():ToolSchema[]
 prepareInput(text:string):Promise<string>; reconcileAuthority():Promise<void>; prepareModelSurface?(signal:AbortSignal):Promise<void>
 goalChanged():void
 overheadTokens?:number
}):Promise<OwnedDefaultSurface> {
 original.assertCurrent()
 const metadata=createOwnedMetadataContext(original.execution)
 original.retain(()=>metadata.close())
 if(original.tools.get('todo_write'))throw Error('duplicate tool registration: todo_write')
 original.tools.register(metadata.todoTool)
 for(const tool of createDesktopOwnedGoalTools(metadata.goalPort,options.goalChanged)) { if(original.tools.get(tool.name))throw Error(`duplicate tool registration: ${tool.name}`); original.tools.register(tool) }
 const plan=await mountOwnedPlan(original,options.initialPlanMode)
 original.assertCurrent()
 const base=options.preset===undefined?DEFAULT_AGENT_PRESET.systemPrompt:parsePreset(options.preset).systemPrompt
 const readProjection=<T>(read:(observation:ExecutionObservation)=>T):T=>{
  original.assertLifetimeCurrent()
  const observation=original.execution.observe()
  observation.assertCurrent()
  const value=read(observation)
  observation.assertCurrent()
  original.assertLifetimeCurrent()
  return value
 }
 const prompt=(observation:ExecutionObservation)=>{
  const parts=[base,options.policyPrompt(observation),plan.prompt(observation),options.shellPrompt(observation)]
  const text=metadata.prompt(parts.filter(Boolean).join('\n\n'),observation)
  const rest=[options.projectPrompt(observation),options.hookPrompt(),options.recoveryPrompt()].filter(Boolean)
  return rest.length ? text+'\n\n'+rest.join('\n\n') : text
 }
 const systemPrompt=()=>readProjection(prompt)
 const modelToolSchemas=()=>readProjection(()=>options.schemas())
 const modelSurface=()=>readProjection(observation=>({systemPrompt:prompt(observation),baseInstructions:base,tools:options.schemas()}))
 const modelOverheadTokens=()=>{
  if(options.overheadTokens!==undefined)return options.overheadTokens
  const {systemPrompt,tools}=modelSurface()
  return approxTokens(systemPrompt)+approxTokens(JSON.stringify(tools))
 }
 const prepareSurface=options.prepareModelSurface
 return Object.freeze({systemPrompt,modelToolSchemas,modelSurface,modelOverheadTokens,async prepareInput(text:string){original.assertCurrent();const result=await options.prepareInput(text);original.assertCurrent();return result},async reconcileAuthority(){original.assertCurrent();await options.reconcileAuthority();original.assertCurrent()},...prepareSurface?{async prepareModelSurface(signal:AbortSignal){original.assertCurrent();if(options.prepareModelSurface!==prepareSurface)throw Error('Original model surface preparation changed');await prepareSurface(signal);original.assertCurrent();if(options.prepareModelSurface!==prepareSurface)throw Error('Original model surface preparation changed')}}:{}})
}
