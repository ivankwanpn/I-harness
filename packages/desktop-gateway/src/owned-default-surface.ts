import type { ToolSchema } from '@i-harness/llm-seam'
import { approxTokens } from '../../compaction/src/index.ts'
import { DEFAULT_AGENT_PRESET, parsePreset } from '../../preset/src/index.ts'
import type { ManagedRegistryConstruction } from '../../session-executor/src/managed-assembly.ts'
import { createOwnedMetadataContext } from '../../session-executor/src/lifecycle/owned-metadata-context.ts'
import { mountOwnedPlan } from './owned-plan.ts'
import { createDesktopOwnedGoalTools } from './workflow.ts'

export interface OwnedDefaultSurface {
 systemPrompt(): string
 modelToolSchemas(): ToolSchema[]
 modelOverheadTokens(): number
 prepareInput(text:string): Promise<string>
 reconcileAuthority(): Promise<void>
 prepareModelSurface?(signal:AbortSignal):Promise<void>
 activateAfterTaskReady?():Promise<void>
}
/** Compose only after all configured native, child, plugin and Code owners are
 * mounted on original.tools. Required callbacks remain live owner reads. */
export async function createOwnedDefaultSurface(original:ManagedRegistryConstruction, options:{
 initialPlanMode?:boolean
 preset?: Parameters<typeof parsePreset>[0]
 policyPrompt():string; shellPrompt():string; projectPrompt():string; hookPrompt():string; recoveryPrompt():string
 schemas():ToolSchema[]
 prepareInput(text:string):Promise<string>; reconcileAuthority():Promise<void>; prepareModelSurface?(signal:AbortSignal):Promise<void>; activateAfterTaskReady?():Promise<void>
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
 const systemPrompt=()=>{original.assertCurrent();const parts=[base,options.policyPrompt(),plan.prompt(),options.shellPrompt()];let text=parts.filter(Boolean).join('\n\n');text=metadata.prompt(text);const rest=[options.projectPrompt(),options.hookPrompt(),options.recoveryPrompt()].filter(Boolean);if(rest.length)text+='\n\n'+rest.join('\n\n');original.assertCurrent();return text}
 const modelToolSchemas=()=>{original.assertCurrent();return options.schemas()}
 const prepareSurface=options.prepareModelSurface,activateTask=options.activateAfterTaskReady
 return Object.freeze({systemPrompt,modelToolSchemas,modelOverheadTokens:()=>options.overheadTokens??approxTokens(systemPrompt())+approxTokens(JSON.stringify(modelToolSchemas())),async prepareInput(text:string){original.assertCurrent();const result=await options.prepareInput(text);original.assertCurrent();return result},async reconcileAuthority(){original.assertCurrent();await options.reconcileAuthority();original.assertCurrent()},...prepareSurface?{async prepareModelSurface(signal:AbortSignal){original.assertCurrent();if(options.prepareModelSurface!==prepareSurface)throw Error('Original model surface preparation changed');await prepareSurface(signal);original.assertCurrent();if(options.prepareModelSurface!==prepareSurface)throw Error('Original model surface preparation changed')}}:{},...activateTask?{async activateAfterTaskReady(){original.assertCurrent();if(options.activateAfterTaskReady!==activateTask)throw Error('Original staged Team activation changed');await activateTask();original.assertCurrent();if(options.activateAfterTaskReady!==activateTask)throw Error('Original staged Team activation changed')}}:{}})
}
