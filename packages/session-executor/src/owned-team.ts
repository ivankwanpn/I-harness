import type {PluginContext} from '@i-harness/core-plugin'
import type {ToolRegistry} from '@i-harness/core-tools'
import {captureManagedTeamParent,isManagedExecutionDomain,type ManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
import {mountAgentTeams,TeamMountFailure,TeamMountRecoveryRequired,type TeamDeps,type TeamConfig,type TeamMountHandle} from '@i-harness/agent-team'

/** Preserve the original receiver and defer live model/budget reads until use. */
function withOriginalGetters<T extends object,U extends object>(original:T,additions:U):T&U{
 const fields=Object.getOwnPropertyDescriptors(original)
 for(const field of Object.values(fields))if(field.get){const get=field.get;field.get=()=>Reflect.apply(get,original,[])}
 return Object.defineProperties({}, {...fields,...Object.getOwnPropertyDescriptors(additions)}) as T&U
}

export interface OwnedTeamOptions {
 readonly ctx:PluginContext
 readonly tools:ToolRegistry
 readonly domain:ManagedExecutionDomain
 readonly retain:(resource:{close():Promise<void>})=>void
 readonly team:Omit<TeamDeps,'parentSession'|'managedParent'|'factOwner'|'parentRegistry'>
 readonly config?:Partial<TeamConfig>
}
/** Call after original Task activation and model binding. Retain the mount via
 * team.retainMount before awaiting; a partial mount keeps its original parent. */
export async function mountOwnedTeam(options:OwnedTeamOptions):Promise<TeamMountHandle>{
 const {ctx,tools,domain}=options
 if(!isManagedExecutionDomain(domain,ctx))throw TypeError('Original Team context required')
 domain.assertCurrent()
 let parent:ReturnType<typeof captureManagedTeamParent>|undefined,retired=false
 const resource=Object.freeze({async close(){retired=true;await parent?.close()}})
 options.retain(resource)
 if(retired)throw Error('Original Team parent retention retired')
 let retained:TeamMountHandle|undefined
 try{
  parent=captureManagedTeamParent(domain)
  await parent.ready;parent.assertCurrent()
  const originalRetain=options.team.retainMount
  return await mountAgentTeams(ctx,tools,withOriginalGetters(options.team,{parentRegistry:tools,managedParent:{domain,parent},retainMount(handle:TeamMountHandle){retained=handle;if(originalRetain)Reflect.apply(originalRetain,options.team,[handle])}}),options.config)
 }catch(primary){
  if(primary instanceof TeamMountRecoveryRequired&&primary.handle===retained||primary instanceof TeamMountFailure&&primary.cleanup===retained)throw primary
  try{await resource.close()}catch(cleanup){throw new AggregateError([primary,cleanup],'Team mount and cleanup failed')}throw primary
 }
}
