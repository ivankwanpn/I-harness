import {createOriginalTeamRecoveryPort,type TeamMountHandle,type TeamDeps} from '../../agent-team/src/index.ts'
import {mountOwnedTeam} from '../../session-executor/src/owned-team.ts'
import type {ManagedRegistryConstruction,ManagedExecutionModelBinding} from '../../session-executor/src/managed-assembly.ts'
import type {RegisterSubagentResult,RegisterSubagentOptions,ParentInputAdmission} from '@i-harness/subagent'
import type {ExecService} from '@i-harness/exec'
import type {SessionCoordinator} from '@i-harness/session-persistence'

/** One genuine Team mount on the original Task registries and recipient. */
export async function mountOwnedGatewayTeam(original:ManagedRegistryConstruction,options:{
 task:RegisterSubagentResult; taskOptions:Omit<RegisterSubagentOptions,'managedParent'|'parentNotify'|'parentSession'|'factOwner'|'getParentModel'|'deferRestoredWork'>
 shell:ExecService; coordinator:SessionCoordinator; parentNotify:ParentInputAdmission; modelBinding():ManagedExecutionModelBinding
 retainTeamRecovery(handle:TeamMountHandle,port:ReturnType<typeof createOriginalTeamRecoveryPort>):void
}) {
 original.assertCurrent()
 const task=options.task,fresh=task.reserveManagedTeamChild,cold=task.reserveManagedColdTeamChild
 if(!fresh||!cold)throw Error('Original Team child owners unavailable')
 const table=task.table,jobs=task.jobs,roles=task.roles,agents=task.agents,followupActivation=task.followupActivation
 const methods=['retainResults','retainInitialSetup','ensureResident','followupGeneration','captureFollowupGeneration'] as const
 const captured=methods.map(name=>task[name])
 const check=()=>{original.assertCurrent();if(task.table!==table||task.jobs!==jobs||task.roles!==roles||task.agents!==agents||task.followupActivation!==followupActivation||task.reserveManagedTeamChild!==fresh||task.reserveManagedColdTeamChild!==cold||methods.some((name,index)=>task[name]!==captured[index]))throw Error('Original Task owner changed')}
 const source=options.taskOptions,fields=Object.getOwnPropertyDescriptors(source),keys=['createInstructionContext','generationFactoryFor','modelActionTimeoutMs','modelActionMaxAttempts','reportPolicy','codeMode','codeModeFactory','inheritedSystemContext','resolveModel','roleSelectionFor','allowSubagentModelSelection','autoCompactionEnabled','contextWindow','budgetBinding','contextMetadata','reasoningEffort','inheritedBindingForStep','results','summaryFactory','maxOutputTokens']
 const checkOptions=()=>{for(const key of keys){const before=fields[key],now=Object.getOwnPropertyDescriptor(source,key);if(Boolean(before)!==Boolean(now)||before&&now&&(before.value!==now.value||before.get!==now.get||before.set!==now.set))throw Error('Original Task options changed')}}
 const inherited:PropertyDescriptorMap={}
 for(const key of keys){const field=fields[key];if(!field)continue;const copy={...field};if(copy.get){const get=copy.get;copy.get=()=>Reflect.apply(get,source,[])}inherited[key]=copy}
 const subagents=Object.defineProperties({table,jobs,roles,agents,exec:options.shell,childSessions:{coordinator:options.coordinator,parentSessionId:original.domain.sessionId},
  reserveManagedTeamChild:(...args:Parameters<typeof fresh>)=>{check();return Reflect.apply(fresh,task,args)},reserveManagedColdTeamChild:(...args:Parameters<typeof cold>)=>{check();return Reflect.apply(cold,task,args)},
  retainResults:()=>{check();return Reflect.apply(captured[0]!,task,[])},retainInitialSetup:(...args:Parameters<RegisterSubagentResult['retainInitialSetup']>)=>{check();return Reflect.apply(captured[1]!,task,args)},ensureResident:(...args:Parameters<RegisterSubagentResult['ensureResident']>)=>{check();return Reflect.apply(captured[2]!,task,args)},followupGeneration:captured[3]?(...args:Parameters<NonNullable<RegisterSubagentResult['followupGeneration']>>)=>{check();checkOptions();return Reflect.apply(captured[3]!,task,args)}:undefined,followupActivation,captureFollowupGeneration:captured[4]?(...args:Parameters<NonNullable<RegisterSubagentResult['captureFollowupGeneration']>>)=>{check();checkOptions();return Reflect.apply(captured[4]!,task,args)}:undefined},inherited) as TeamDeps['subagents']
 const team={allowConcurrentTeams:true,preserveSubagentTools:true,parentNotify:options.parentNotify,subagents,get parentModel(){check();return options.modelBinding().model},retainMount(handle:TeamMountHandle){check();const port=createOriginalTeamRecoveryPort(original.domain,handle);options.retainTeamRecovery(handle,port)}}
 check();checkOptions()
 const handle=await mountOwnedTeam({ctx:original.ctx,tools:original.tools,domain:original.domain,retain:resource=>original.retain(()=>resource.close()),team})
 check();checkOptions();return handle
}
