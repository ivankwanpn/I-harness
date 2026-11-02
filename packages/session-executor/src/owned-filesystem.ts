import {createFsTools} from '@i-harness/fs'
import {readToolInvocationDomain,type ToolRegistry} from '@i-harness/core-tools'
import type {PluginContext} from '@i-harness/core-plugin'
import type {ManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
import type {createMainInstructionManager} from './context/instructions/manager.ts'

/** Register the original filesystem bodies on the
 * same managed registry. Invocation identity here only selects instruction
 * observations after the body has already passed its own native gates. */
export function mountOwnedFilesystem(options:{ctx:PluginContext;tools:ToolRegistry;workspace:string;domain:ManagedExecutionDomain;manager?:ReturnType<typeof createMainInstructionManager>}) {
 for(const tool of createFsTools({workspace:options.workspace,readPolicy:{maxOutputBytes:64000},async observeInstructionTarget(target,exec){
  if(readToolInvocationDomain(exec)!==options.domain||!options.manager)return {status:'unavailable',reason:'mapping-unavailable'}
  return options.manager.observe(target)
 }}))options.tools.register(tool)
}
