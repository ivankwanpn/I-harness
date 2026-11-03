import type {OriginalManagedTeamBirthAuthority} from '../../core-tools/src/team-caller.ts'
import type {OriginalTeamProvisioning} from '@i-harness/core-session/internal/execution'
import type {ChildBootstrapCaptureRequest} from './coordinator/child-bootstrap-intent.ts'
import type {BootstrapProjectIntent} from './coordinator/bootstrap-intent.ts'

export interface OriginalTeamTargetDiscovery {
 readonly ready:Promise<void>
 readonly result:Readonly<{kind:'absent'|'unavailable'|'conflict'}>|Readonly<{kind:'reserved'|'materialized';request:ChildBootstrapCaptureRequest}>
 close():Promise<void>
}
export interface TeamTargetExpectation {caller:OriginalManagedTeamBirthAuthority;provisioning:OriginalTeamProvisioning;project:BootstrapProjectIntent;metadata:ChildBootstrapCaptureRequest['core']['metadata'];roleName:string;roleDigest:string;toolNames:readonly string[];model:ChildBootstrapCaptureRequest['core']['execution']['model'];delegationDepth:number;timeoutMs:number;maxAttempts?:number}
const owners=new WeakMap<object,(input:TeamTargetExpectation)=>OriginalTeamTargetDiscovery>()
type BackendPort={discover(id:string,owner:import('./coordinator/fact-types.ts').HeldFactOwner):ReturnType<NonNullable<import('./coordinator/bootstrap-route.ts').BootstrapRouteBackend['discoverTeamChild']>>;settle(id:string,owner:import('./coordinator/fact-types.ts').HeldFactOwner):Promise<void>}
const backends=new WeakMap<object,BackendPort>()
export function associateOriginalTeamTargetBackend(backend:object,port:BackendPort){if(backends.has(backend))throw TypeError('Original Team target backend already associated');backends.set(backend,port)}
export function originalTeamTargetBackend(backend:object){return backends.get(backend)}
type BindingBackend={open(scope:import('./coordinator/team-birth-scope.ts').HeldTeamBirthScope):import('./coordinator/task-document-types.ts').TaskDocumentBackendSession & {stageInitialize(bytes:Uint8Array):import('./coordinator/task-document-types.ts').TaskDocumentWrite}}
const bindingBackends=new WeakMap<object,BindingBackend>()
export function associateOriginalTeamBindingBackend(backend:object,port:BindingBackend){if(bindingBackends.has(backend))throw TypeError('Original Team binding backend already associated');bindingBackends.set(backend,port)}
export function originalTeamBindingBackend(backend:object){return bindingBackends.get(backend)}
export function associateTeamTargetDiscovery(coordinator:object,capture:(input:TeamTargetExpectation)=>OriginalTeamTargetDiscovery){if(owners.has(coordinator))throw TypeError('Original Team target owner already associated');owners.set(coordinator,capture)}
export function captureOriginalTeamTarget(coordinator:object,input:TeamTargetExpectation){const capture=owners.get(coordinator);if(!capture)throw TypeError('Original Team target owner required');return capture(input)}
export interface OriginalTeamBindingAttempt {commit():Promise<void>;reconcile():Promise<void>;closeForHandoff():Promise<void>;assertHandoff():void;close():Promise<void>}
type BindingInput={authority:OriginalManagedTeamBirthAuthority;provisioning:OriginalTeamProvisioning;binding:import('./coordinator/team-birth-binding.ts').TeamBirthBinding;payload:import('./coordinator/bootstrap-types.ts').BootstrapRequest}
const bindingOwners=new WeakMap<object,(input:BindingInput)=>OriginalTeamBindingAttempt>()
export function associateOriginalTeamBindingOwner(coordinator:object,capture:(input:BindingInput)=>OriginalTeamBindingAttempt){if(bindingOwners.has(coordinator))throw TypeError('Original Team binding owner already associated');bindingOwners.set(coordinator,capture)}
export function captureOriginalTeamBinding(coordinator:object,input:BindingInput){const capture=bindingOwners.get(coordinator);if(!capture)throw TypeError('Original Team binding owner required');return capture(input)}
export interface OriginalTeamColdBinding {readonly ready:Promise<void>;inspect():Readonly<{kind:'no-binding'|'unavailable'|'conflict'}>|Readonly<{kind:'confirmed';binding:import('./coordinator/team-birth-binding.ts').TeamBirthBinding}>;close():Promise<void>}
type ColdInput={domain:import('@i-harness/core-session/internal/execution').ManagedExecutionDomain;owner:import('@i-harness/core-session/internal/execution').OriginalTeamProvisioningOwner;parent:import('@i-harness/core-session/internal/execution').OriginalManagedTeamParent;teamId:string;memberId:string}
const coldOwners=new WeakMap<object,(input:ColdInput)=>OriginalTeamColdBinding>()
const issuedColdBindings=new WeakMap<OriginalTeamColdBinding,{coordinator:object;domain:ColdInput['domain'];owner:ColdInput['owner'];parent:ColdInput['parent']}>()
export function associateOriginalTeamColdBindingOwner(coordinator:object,capture:(input:ColdInput)=>OriginalTeamColdBinding){if(coldOwners.has(coordinator))throw TypeError('Original Team cold owner already associated');coldOwners.set(coordinator,capture)}
export function captureOriginalTeamColdBinding(coordinator:object,input:ColdInput){const capture=coldOwners.get(coordinator);if(!capture)throw TypeError('Original Team cold owner required');const captured={domain:input.domain,owner:input.owner,parent:input.parent,teamId:input.teamId,memberId:input.memberId},binding=capture(captured);issuedColdBindings.set(binding,{coordinator,domain:captured.domain,owner:captured.owner,parent:captured.parent});return binding}
export function assertOriginalTeamColdBindingParent(coordinator:object,binding:OriginalTeamColdBinding,domain:ColdInput['domain'],owner:ColdInput['owner'],parent:ColdInput['parent']){const original=issuedColdBindings.get(binding);if(!original||original.coordinator!==coordinator||original.domain!==domain||original.owner!==owner||original.parent!==parent)throw TypeError('Original Team cold parent required');const result=binding.inspect();if(result.kind!=='confirmed')throw TypeError('Confirmed Team cold binding required');return result.binding}
const coldTargets=new WeakMap<object,(binding:OriginalTeamColdBinding)=>OriginalTeamTargetDiscovery>()
const issuedColdTargets=new WeakMap<OriginalTeamTargetDiscovery,{coordinator:object;binding:OriginalTeamColdBinding}>()
export function associateOriginalTeamColdTarget(coordinator:object,capture:(binding:OriginalTeamColdBinding)=>OriginalTeamTargetDiscovery){if(coldTargets.has(coordinator))throw TypeError('Original Team cold target already associated');coldTargets.set(coordinator,capture)}
export function captureOriginalTeamColdTarget(coordinator:object,binding:OriginalTeamColdBinding){const capture=coldTargets.get(coordinator);if(!capture||issuedColdBindings.get(binding)?.coordinator!==coordinator)throw TypeError('Original Team cold target owner required');const target=capture(binding);issuedColdTargets.set(target,{coordinator,binding});return target}
export function assertOriginalTeamColdTarget(coordinator:object,binding:OriginalTeamColdBinding,target:OriginalTeamTargetDiscovery){const original=issuedColdTargets.get(target);if(!original||original.coordinator!==coordinator||original.binding!==binding)throw TypeError('Original Team cold target required');const source=binding.inspect(),found=target.result;if(source.kind!=='confirmed'||found.kind!=='absent'&&found.kind!=='reserved'&&found.kind!=='materialized')throw TypeError('Original Team cold target unavailable');return {binding:source.binding,target:found}}
export function inspectOriginalTeamColdTarget(binding:OriginalTeamColdBinding,target:OriginalTeamTargetDiscovery){const original=issuedColdTargets.get(target);if(!original||original.binding!==binding)throw TypeError('Original Team cold target required');return assertOriginalTeamColdTarget(original.coordinator,binding,target)}
type ColdResume=(binding:OriginalTeamColdBinding,target:OriginalTeamTargetDiscovery,guards:import('./coordinator/bootstrap-types.ts').BootstrapGuards,payload:import('./coordinator/bootstrap-types.ts').BootstrapRequest)=>Promise<import('./coordinator/bootstrap-types.ts').BootstrapOutcome>
const coldResumes=new WeakMap<object,ColdResume>()
export function associateOriginalTeamColdResume(coordinator:object,resume:ColdResume){if(coldResumes.has(coordinator))throw TypeError('Original Team cold resume already associated');coldResumes.set(coordinator,resume)}
export function resumeOriginalTeamColdBirth(coordinator:object,binding:OriginalTeamColdBinding,target:OriginalTeamTargetDiscovery,guards:import('./coordinator/bootstrap-types.ts').BootstrapGuards,payload:import('./coordinator/bootstrap-types.ts').BootstrapRequest){assertOriginalTeamColdTarget(coordinator,binding,target);const resume=coldResumes.get(coordinator);if(!resume)throw TypeError('Original Team cold resume required');return resume(binding,target,guards,payload)}
