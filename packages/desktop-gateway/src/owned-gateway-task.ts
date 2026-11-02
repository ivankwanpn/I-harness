import {types} from 'node:util'
import { SHIPPING_REPORT_POLICY, type RegisterSubagentOptions } from '@i-harness/subagent'
import type { SessionCoordinator } from '@i-harness/session-persistence'
import type { ManagedRegistryConstruction } from '../../session-executor/src/managed-assembly.ts'
import { createChildInstructionHost } from '../../session-executor/src/context/instructions/child-host.ts'
import { createTaskResultRetention } from '../../session-executor/src/lifecycle/task-result-retention.ts'
import type { ExecService } from '@i-harness/exec'
import type { OwnedShellOutput } from '../../session-executor/src/owned-shell.ts'

type TaskOptions=Omit<RegisterSubagentOptions,'managedParent'|'parentNotify'|'parentSession'|'factOwner'|'getParentModel'|'deferRestoredWork'>
/** Original child instruction host and Task inputs; service retains and mounts
 * the one resulting registerSubagent owner on the original registry. */
export function createOwnedGatewayTaskOptions(options:{
 bindChildHost(id:string,host:ReturnType<typeof createChildInstructionHost>):void
 coordinator:SessionCoordinator
 prepareTaskChild:NonNullable<RegisterSubagentOptions['prepareTaskChild']>
 resolveModel:RegisterSubagentOptions['resolveModel']
 roleSelectionFor:NonNullable<RegisterSubagentOptions['roleSelectionFor']>
 allowSubagentModelSelection:NonNullable<RegisterSubagentOptions['allowSubagentModelSelection']>
 autoCompactionEnabled:NonNullable<RegisterSubagentOptions['autoCompactionEnabled']>
 childOptions:Pick<RegisterSubagentOptions,'generationFactoryFor'|'modelActionTimeoutMs'|'modelActionMaxAttempts'|'summaryFactory'|'inheritedBindingForStep'|'codeModeFactory'|'inheritedSystemContext'|'contextWindow'|'budgetBinding'|'contextMetadata'|'reasoningEffort'|'maxOutputTokens'>
}) {
 return async (original:ManagedRegistryConstruction,live:{shell?:ExecService;output?:OwnedShellOutput;codeConfig?:import('../../code-mode/src/index.ts').CodeModeConfig}):Promise<TaskOptions> => {
  original.assertCurrent()
  if(!original.instructions||!live.shell||!live.output?.sourceFor)throw Error('Original Task instruction, Shell and output owners required')
  const binding=original.instructions
  if(!binding.environment||typeof binding.cwd!=='string'||typeof binding.authority!=='function'||typeof binding.available!=='function')throw Error('Original configured instruction binding required')
  let retired=false
  const child=createChildInstructionHost({environment:binding.environment,cwd:binding.cwd,authority:binding.authority,available:()=>!retired&&binding.available(),root:{domain:original.domain,manager:binding.manager}})
  try{original.retain(async()=>{retired=true;await child.close()})}catch(error){await child.close();throw error}
  original.assertCurrent()
  options.bindChildHost(original.domain.sessionId,child)
  const configured={exec:live.shell,resolveModel:options.resolveModel,prepareTaskChild:options.prepareTaskChild,
   createInstructionContext:child.create,results:createTaskResultRetention(live.output.service,live.output.sourceFor,original.domain.sessionId),
   reportPolicy:SHIPPING_REPORT_POLICY,includeAgentShell:true,includeNativeContext:true,
   roleSelectionFor:options.roleSelectionFor,allowSubagentModelSelection:options.allowSubagentModelSelection,autoCompactionEnabled:options.autoCompactionEnabled,
   persist:{coordinator:options.coordinator,stateId:original.domain.sessionId,parentSessionId:original.domain.sessionId}}
  if(types.isProxy(options.childOptions)||![null,Object.prototype].includes(Object.getPrototypeOf(options.childOptions)))throw TypeError('Original child options required')
  const descriptors=Object.getOwnPropertyDescriptors(options.childOptions),allowed=new Set(['generationFactoryFor','modelActionTimeoutMs','modelActionMaxAttempts','summaryFactory','inheritedBindingForStep','codeModeFactory','inheritedSystemContext','contextWindow','budgetBinding','contextMetadata','reasoningEffort','maxOutputTokens'])
  if(Reflect.ownKeys(descriptors).some(key=>typeof key!=='string'||!allowed.has(key)))throw TypeError('Unknown child option')
  for(const field of Object.values(descriptors))if(field.get){const get=field.get;field.get=()=>Reflect.apply(get,options.childOptions,[])}
  if(live.codeConfig)Object.defineProperty(configured,'codeMode',{value:live.codeConfig,enumerable:true})
  return Object.defineProperties(configured,descriptors)
 }
}
