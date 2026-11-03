import {renderPolicyContext} from '../../sandbox-policy/src/index.ts'
import {agentShellPrompt,type ResolvedAgentShell} from '@i-harness/shell'
import type {AuthorityState,SandboxMode} from '@i-harness/sandbox'
import type {SessionProjectContext} from '@i-harness/session-executor'
import type {ManagedRegistryConstruction} from '../../session-executor/src/managed-assembly.ts'

/** Live host policy inputs read the original managed projection and current
 * project authority; no observed text is treated as execution permission. */
export function createOwnedGatewayPromptParts(original:ManagedRegistryConstruction,options:{
 workspace:string;rewindEnabled:boolean;mode():SandboxMode;authority():AuthorityState
 project():SessionProjectContext|undefined;shell():ResolvedAgentShell
}) {
 const current=()=>{original.assertCurrent();const observation=original.execution.observe();observation.assertCurrent();return observation}
 return Object.freeze({
  policy(){const observation=current(),authority=options.authority();if(authority.kind==='revoked'||authority.kind==='unavailable')throw Error('Execution authority '+authority.kind+': '+authority.reason);const mode=observation.sandboxPolicy()?.mode??options.mode();const root=authority.kind==='bound'?authority.primaryRoot:authority.workspaceRoot,roots=authority.kind==='bound'?[...authority.roots]:[authority.workspaceRoot];observation.assertCurrent();return renderPolicyContext({mode,workspaceRoot:root,workspaceRoots:roots})},
  shell(){const observation=current();let text:string;try{text=agentShellPrompt(options.shell())}catch{text='The selected Agent shell is unavailable. Ask the user to repair its setting before shell execution.'}observation.assertCurrent();return text},
  project(){const observation=current(),project=options.project();observation.assertCurrent();if(!project)return '';const workspace=options.workspace;return `Current project: ${JSON.stringify({id:project.id,name:project.name,roots:project.roots,primaryRoot:project.primaryRoot})}.\nThe session's default working directory remains ${JSON.stringify(workspace)}. Use absolute paths to access the other project folders. Read and follow the applicable AGENTS.md instructions in each target folder before modifying it.${project.roots.includes(workspace)?'':' The default working directory is no longer a project member; use absolute paths under the listed project folders for modifications.'}${options.rewindEnabled?' File rewind records only the default working directory; modifications in other project folders are outside its restore coverage.':''}`},
 })
}
