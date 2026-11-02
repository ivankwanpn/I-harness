import type {SessionServiceOptions} from '../service.ts'
import {types} from 'node:util'

/** Complete means the original full assembly must receive the supplied option.
 * Forward covers the original shared service or explicit-tools private builder.
 * This exhaustive table intentionally makes a newly added option a type error. */
export const executionOptionMode = Object.freeze({
 prepareTaskChild:'complete',prepareExecDelivery:'complete',passiveGeneration:'forward',residentActivation:'complete',retainConstructionCleanup:'complete',
 instructionEnvironment:'complete',instructionSettingsPath:'complete',prepareHumanInput:'complete',
 modelActionTimeoutMs:'forward',modelActionMaxAttempts:'forward',videoAudioAnalyzer:'complete',codeMode:'complete',codeModeFactory:'complete',
 sessionId:'forward',workspace:'forward',projectContext:'complete',executionAuthority:'complete',executionCallerAvailable:'complete',
 windowsSandboxBackend:'complete',wslExecution:'complete',webSearchMode:'complete',webCacheRoot:'complete',legacyPrivateTempRoot:'complete',
 modelPolicy:'policy',model:'forward',modelLabel:'complete',mockScript:'complete',mockCycles:'complete',
 approveAll:'complete',approvalMode:'complete',sandbox:'complete',allowRuntimeSandboxChanges:'complete',shellTimeoutMs:'complete',shellBackgroundAfterMs:'complete',shellRetention:'complete',retry:'complete',
 maxParallelToolCalls:'forward',mcp:'complete',pluginMcp:'complete',pluginAgents:'complete',pluginAgentsEphemeral:'complete',lsp:'complete',skills:'complete',team:'complete',concurrentSessionTeams:'complete',agentShell:'complete',
 additionalSystemPrompt:'complete',hookContext:'complete',sessionQuery:'complete',additionalTools:'complete',
 contextOutput:'complete',contextOutputSettingsPath:'complete',contextOutputSourceFor:'complete',contextOutputLegacyReadObservation:'complete',
 compact:'complete',autoCompactionEnabled:'complete',rewindStoreRoot:'complete',preset:'complete',planMode:'complete',guardian:'complete',
 session:'complete',detachedSession:'complete',detachedPolicySession:'complete',policyDocument:'complete',policySession:'complete',
 coordinator:'forward',restoredState:'complete',telemetry:'forward',jobStatusEvents:'complete',contextWindow:'forward',budgetBinding:'forward',contextMetadata:'forward',maxOutputTokens:'forward',parentNotify:'complete',reasoningEffort:'forward',
 resolveRoleModel:'complete',roleSelectionFor:'complete',allowSubagentModelSelection:'complete',subagentStaleAfterMs:'complete',
 managedRuntime:'forward',resultReadScopeFor:'forward',modelMetadataFor:'forward',sessionOperation:'forward',projectContextFor:'complete',executionAuthorityFor:'complete',windowsSandboxBackendFor:'complete',wslExecutionFor:'complete',webSearchModeFor:'complete',
 transformPrompt:'complete',afterSuccessfulSubmit:'complete',extensionsFor:'complete',beforeDispose:'forward',loadMeta:'forward',modelBuilder:'forward',modelBindingFor:'forward',sessionFor:'complete',contextWindowFor:'forward',reasoningEffortFor:'forward',
} satisfies Record<keyof SessionServiceOptions,'forward'|'complete'|'policy'>)

export function supportsManagedServiceOptions(options:SessionServiceOptions):boolean{
 if(types.isProxy(options))return false
 const prototype=Object.getPrototypeOf(options)
 if(prototype!==null&&prototype!==Object.prototype)return false
 const requested=Object.getOwnPropertyDescriptor(options,'managedRuntime')
 if(!requested||!('value'in requested)||!requested.value)return false
 for(const key of Reflect.ownKeys(options)){
  const field=Object.getOwnPropertyDescriptor(options,key)
  // Do not invoke an unknown option getter to decide whether to acquire privately.
  if(typeof key!=='string'||!field||!('value'in field))return false
  if(field.value===undefined)continue
  const mode=Object.getOwnPropertyDescriptor(executionOptionMode,key)?.value
  if(mode==='complete'||mode===undefined||mode==='policy'&&field.value!=='required')return false
 }
 return true
}
