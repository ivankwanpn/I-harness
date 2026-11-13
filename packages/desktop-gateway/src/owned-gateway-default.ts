import {onExecutionEvent} from '@i-harness/core-plugin'
import {committedFactSeqs} from '@i-harness/core-session'
import {SKILL_MENTION_PLUGIN} from '../../skills/src/index.ts'
import {createStaleSubagentsSection} from '@i-harness/subagent'
import {actionFeedbackFacts} from '../../session-executor/src/lifecycle/action-facts.ts'
import type { ManagedRegistryConstruction } from '../../session-executor/src/managed-assembly.ts'
import { mountOwnedHostExtensions } from './owned-host-extensions.ts'
import { createOwnedDefaultSurface, type OwnedDefaultSurface } from './owned-default-surface.ts'
import type { createOwnedApprovalBindings } from './owned-approval-bindings.ts'
import { mountOwnedGatewayLeaves } from './owned-gateway-leaves.ts'
import type {createOwnedGatewaySelectionOwner} from './owned-gateway-selection-owner.ts'
import {createManagedNativeRecovery} from '../../session-executor/src/lifecycle/managed-native-recovery.ts'
import type {ContextOutputService} from '@i-harness/context-output'
import type {RegisterSubagentResult} from '@i-harness/subagent'
import type {createOwnedIndexJobBindings} from './owned-index-jobs.ts'

/** Called only by the future configured private-host selector after its native,
 * child and Code owners are attached to this same original registry. */
export async function composeOwnedGatewayDefault(original:ManagedRegistryConstruction, options:{
 extensions: Omit<Parameters<typeof mountOwnedHostExtensions>[1],'bindIdentity'|'inputs'|'directMcp'>
 surface: Omit<Parameters<typeof createOwnedDefaultSurface>[1],'prepareInput'|'hookPrompt'|'recoveryPrompt'|'prepareModelSurface'>
 leaves: Parameters<typeof mountOwnedGatewayLeaves>[1]
 task:RegisterSubagentResult
 indexJobs:ReturnType<typeof createOwnedIndexJobBindings>
 subagentStaleAfterMs:number
 output:ContextOutputService
 bindHookContext(read:()=>string):void
 selection:ReturnType<typeof createOwnedGatewaySelectionOwner>
 bindings: ReturnType<typeof createOwnedApprovalBindings>
}):Promise<OwnedDefaultSurface> {
 if(options.task.roles!==options.extensions.roles)throw TypeError('Original shared Task roles required')
 options.indexJobs.mount(original,options.task)
 const recovery=createManagedNativeRecovery(original.execution,options.output);original.retain(()=>recovery.close())
 const selected=options.selection.current(original.domain.sessionId);selected.assertCurrent()
 mountOwnedGatewayLeaves(original,options.leaves)
 let surface:OwnedDefaultSurface|undefined
 const extensions=await mountOwnedHostExtensions(original,{...options.extensions,inputs:selected.inputs,directMcp:selected.directMcp,
  policy:()=>{const current=options.selection.current(original.domain.sessionId);return {...options.extensions.policy(),hookConfigs:current.inputs.hookConfigs,pluginAuthority:current.inputs}},
  bindIdentity(owner,identity){const unbind=options.bindings.bind(owner,identity);try{original.retain(unbind)}catch(error){unbind();throw error}},
 })
 selected.assertCurrent();original.assertCurrent();options.selection.bind(original,extensions.mount)
 if(!original.instructions)throw Error('Original runtime context required')
 const skills=extensions.catalog.skillsSection,stale=createStaleSubagentsSection({table:options.task.table,thresholdMs:options.subagentStaleAfterMs})
 let offSkills:(()=>void)|undefined,offSubagents:(()=>void)|undefined
 original.retain(()=>offSkills?.());offSkills=original.instructions.runtime.registerSection('skills',skills)
 original.retain(()=>offSubagents?.());offSubagents=original.instructions.runtime.registerSection('subagents',stale)
 let lastMentionTask:string|undefined
 onExecutionEvent(original.ctx,'agent/pre-step',async payload=>{const task=(payload as {task?:unknown}).task;if(typeof task!=='string'||task===lastMentionTask)return;const names=extensions.catalog.mentionedSkills(task);if(!names.length)return;committedFactSeqs(await actionFeedbackFacts(original.execution.owner,(payload as {signal?:AbortSignal}).signal).feedback({type:'user/message',text:'[skill mention] Load the '+names.map(name=>JSON.stringify(name)).join(', ')+' skill(s) with skill_get before proceeding.',source:{kind:'plugin',plugin:SKILL_MENTION_PLUGIN},internal:true}));lastMentionTask=task})
 const hookContext=()=>extensions.mount.hookContext();options.bindHookContext(hookContext)
 surface=await createOwnedDefaultSurface(original,{...options.surface,
  prepareInput:text=>extensions.mount.expand(text),hookPrompt:()=>extensions.mount.hookContext(),
  // Overhead counting asks for the prompt before the model surface refresh; a
  // cached recovery text from an earlier request is then expired. Recovery is an
  // advisory section, so omit it rather than failing the request.
  recoveryPrompt:()=>{try{return recovery.render()}catch(error){if(/observation (expired|stale)/i.test(String((error as Error)?.message??'')))return '';throw error}},
  prepareModelSurface:signal=>recovery.refresh(signal),
 })
 original.assertCurrent()
 return surface
}
