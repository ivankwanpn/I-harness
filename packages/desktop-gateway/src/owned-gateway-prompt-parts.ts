import {renderPolicyContext} from '../../sandbox-policy/src/index.ts'
import {agentShellPrompt,type ResolvedAgentShell} from '@i-harness/shell'
import type {AuthorityState,SandboxMode} from '@i-harness/sandbox'
import type {SessionProjectContext} from '@i-harness/session-executor'
import type {ManagedRegistryConstruction} from '../../session-executor/src/managed-assembly.ts'
import { isOriginalExecutionObservation, type ExecutionObservation } from '@i-harness/core-session/internal/execution'

/** Live host policy inputs read the original managed projection and current
 * project authority; no observed text is treated as execution permission. */
export function createOwnedGatewayPromptParts(original:ManagedRegistryConstruction,options:{
 workspace:string;rewindEnabled:boolean;mode(observation:ExecutionObservation):SandboxMode;authority():AuthorityState
 project():SessionProjectContext|undefined;shell():ResolvedAgentShell
}) {
 const current=(observed?:ExecutionObservation)=>{
  original.assertLifetimeCurrent()
  const observation=observed??original.execution.observe()
  if(!isOriginalExecutionObservation(observation)||observation.identity!==original.execution.identity)throw TypeError('Original prompt observation required')
  observation.assertCurrent()
  return observation
 }
 const finish=(observation:ReturnType<typeof current>)=>{
  observation.assertCurrent()
  original.assertLifetimeCurrent()
 }
 return Object.freeze({
  policy(observed?:ExecutionObservation){const observation=current(observed),authority=options.authority();if(authority.kind==='revoked'||authority.kind==='unavailable')throw Error('Execution authority '+authority.kind+': '+authority.reason);const mode=options.mode(observation);const root=authority.kind==='bound'?authority.primaryRoot:authority.workspaceRoot,roots=authority.kind==='bound'?[...authority.roots]:[authority.workspaceRoot];finish(observation);return renderPolicyContext({mode,workspaceRoot:root,workspaceRoots:roots})},
  shell(observed?:ExecutionObservation){const observation=current(observed);let text:string;try{text=agentShellPrompt(options.shell())}catch{text='The selected Agent shell is unavailable. Ask the user to repair its setting before shell execution.'}finish(observation);return text},
  project(observed?:ExecutionObservation){const observation=current(observed),project=options.project();finish(observation);if(!project)return '';const workspace=options.workspace;return `Current project: ${JSON.stringify({id:project.id,name:project.name,roots:project.roots,primaryRoot:project.primaryRoot})}.\nThe session's default working directory remains ${JSON.stringify(workspace)}. Use absolute paths to access the other project folders. Read and follow the applicable AGENTS.md instructions in each target folder before modifying it.${project.roots.includes(workspace)?'':' The default working directory is no longer a project member; use absolute paths under the listed project folders for modifications.'}${options.rewindEnabled?' File rewind records only the default working directory; modifications in other project folders are outside its restore coverage.':''}`},
 })
}
