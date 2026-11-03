import type { BootstrapCallerMetadata, BootstrapGuards, BootstrapProjectIntent, ChildBootstrapCaptureRequest } from '@i-harness/session-persistence'

/** Constructor-supplied policy of the original host, never tool arguments. */
export interface TaskChildHostInput {
 readonly history?:import('./task-history.ts').OriginalTaskChildHistory
 readonly coordinator: import('@i-harness/session-persistence').SessionCoordinator
 readonly parentSessionId: string
 readonly signal?: AbortSignal
 assertSourceCut(): void
 assertCurrent(): void
 sourceAvailable(): boolean
 retire(cause: unknown): void
 retain(cleanup: {close(): Promise<void>}): void
}
export interface TaskChildHostPreparation {
 readonly project: BootstrapProjectIntent
 readonly metadata: BootstrapCallerMetadata
 beforeResultIssue?():Promise<void>
 prepare(request: ChildBootstrapCaptureRequest): {run<T>(work:(guards:BootstrapGuards)=>Promise<T>):Promise<T>;releaseSource?():Promise<void>;assertDependencyReceipt?(receipt:import('@i-harness/session-persistence').BootstrapReceipt,seed:import('@i-harness/session-persistence').CompiledSemanticSeed):void;close(): Promise<void>|void}
}
export type PrepareTaskChild = (input: TaskChildHostInput) => Promise<TaskChildHostPreparation>

import {assertOriginalManagedTeamBirth,type OriginalManagedTeamBirthAuthority} from '@i-harness/core-tools/internal/team-caller'
import {inspectOriginalTeamProvisioning,type OriginalTeamProvisioning} from '@i-harness/core-session/internal/execution'
import {canonicalJsonData} from '@i-harness/core-session'
import {assertOriginalTeamColdTarget,type OriginalTeamColdBinding,type OriginalTeamTargetDiscovery} from '../../../session-persistence/src/team-child-recovery-internal.ts'
const teamInputs=new WeakMap<TaskChildHostInput,{caller:OriginalManagedTeamBirthAuthority;provisioning:OriginalTeamProvisioning;requestBytes?:string}>()
/** Constructor-only association; the actual active caller and provisioning ACK own the host route. */
export function bindOriginalTeamChildHostInput(input:TaskChildHostInput,caller:OriginalManagedTeamBirthAuthority,provisioning:OriginalTeamProvisioning){assertOriginalManagedTeamBirth(caller,provisioning);if(teamInputs.has(input))throw TypeError('Original Team host input already bound');teamInputs.set(input,{caller,provisioning})}
export function bindOriginalTeamChildHostRequest(input:TaskChildHostInput,request:ChildBootstrapCaptureRequest){const original=teamInputs.get(input);if(!original||original.requestBytes)throw TypeError('Original Team host request unavailable');assertOriginalManagedTeamBirth(original.caller,original.provisioning);original.requestBytes=canonicalJsonData(request)}
export function assertOriginalTeamChildHostRequest(input:TaskChildHostInput,request:ChildBootstrapCaptureRequest){const original=teamInputs.get(input);if(!original?.requestBytes||canonicalJsonData(request)!==original.requestBytes)throw TypeError('Original Team host request required');assertOriginalManagedTeamBirth(original.caller,original.provisioning);const member=inspectOriginalTeamProvisioning(original.caller.context.domain,original.provisioning).event;if(request.core.caller.kind!=='team'||request.core.caller.teamId!==member.teamId||request.core.caller.memberId!==member.member.id||request.invocation.targetSessionId!==member.member.id||request.core.lineage.origin!=='team'||request.core.lineage.parentSession!==original.caller.identity.parentSessionId||input.parentSessionId!==original.caller.identity.parentSessionId)throw TypeError('Foreign original Team child request')}
const coldTeamInputs=new WeakMap<TaskChildHostInput,{binding:OriginalTeamColdBinding;target:OriginalTeamTargetDiscovery;requestBytes:string}>()
export function isOriginalColdTeamChildHostInput(input:TaskChildHostInput){return coldTeamInputs.has(input)}
export function bindOriginalColdTeamChildHostInput(input:TaskChildHostInput,binding:OriginalTeamColdBinding,target:OriginalTeamTargetDiscovery){const original=assertOriginalTeamColdTarget(input.coordinator,binding,target);if(coldTeamInputs.has(input)||input.parentSessionId!==original.binding.parentSessionId)throw TypeError('Original cold Team host required');coldTeamInputs.set(input,{binding,target,requestBytes:canonicalJsonData(original.binding.request)})}
export function assertOriginalColdTeamChildHostRequest(input:TaskChildHostInput,request:ChildBootstrapCaptureRequest){const original=coldTeamInputs.get(input);if(!original||canonicalJsonData(request)!==original.requestBytes)throw TypeError('Original cold Team host request required');const retained=assertOriginalTeamColdTarget(input.coordinator,original.binding,original.target);if(canonicalJsonData(retained.binding.request)!==original.requestBytes||'request'in retained.target&&canonicalJsonData(retained.target.request)!==original.requestBytes)throw TypeError('Original cold Team host request changed')}
