import {isManagedExecutionDomain,readManagedActionMembers,assertManagedActionCurrent,captureManagedTeamParent} from './execution-state.ts'
import {retainAcknowledgedExecutionMembers} from './execution-members.ts'
import type {ManagedExecutionDomain} from './execution-types.ts'
import type {ManagedAction} from './ports.ts'
import type {FactOutcome,SessionEventView} from './types.ts'
import {assertOriginalManagedTeamParent} from './execution-state.ts'
import type {OriginalManagedTeamParent} from './execution-types.ts'

type ProvisioningEvent=Extract<SessionEventView,{type:'team/member'}>
export interface OriginalTeamProvisioning {readonly kind:'original-team-provisioning';assertCurrent():void;close():Promise<void>}
export interface OriginalTeamProvisioningOwner {readonly kind:'original-team-provisioning-owner'}
export interface OriginalTeamProvisioningCandidate {readonly kind:'original-team-provisioning-candidate';abandon():void}
type Owner={domain:ManagedExecutionDomain;parent:OriginalManagedTeamParent}
const owners=new WeakMap<object,Owner>(),usedParents=new WeakSet<object>(),candidates=new WeakMap<object,{owner:OriginalTeamProvisioningOwner;action:ManagedAction<FactOutcome>;used:boolean}>()
const recoveryParents=new WeakMap<OriginalManagedTeamParent,OriginalTeamProvisioningOwner>()
export function createOriginalTeamProvisioningOwner(domain:ManagedExecutionDomain,parent:OriginalManagedTeamParent):OriginalTeamProvisioningOwner{assertOriginalManagedTeamParent(domain,parent);if(usedParents.has(parent))throw TypeError('Original Team provisioning owner already created');usedParents.add(parent);const token=Object.freeze({kind:'original-team-provisioning-owner' as const});owners.set(token,{domain,parent});return token}
export function assertOriginalTeamProvisioningOwner(domain:ManagedExecutionDomain,owner:OriginalTeamProvisioningOwner){const original=owners.get(owner);if(!original||original.domain!==domain)throw TypeError('Original Team provisioning owner required');assertOriginalManagedTeamParent(domain,original.parent)}
/** Each recovery member gets a fresh original prefix lease from this same mounted owner. */
export function reserveOriginalTeamRecoveryParent(owner:OriginalTeamProvisioningOwner):OriginalManagedTeamParent{const original=owners.get(owner);if(!original)throw TypeError('Original Team provisioning owner required');assertOriginalTeamProvisioningOwner(original.domain,owner);const parent=captureManagedTeamParent(original.domain);recoveryParents.set(parent,owner);return parent}
export function assertOriginalTeamRecoveryParent(owner:OriginalTeamProvisioningOwner,parent:OriginalManagedTeamParent):void{const original=owners.get(owner);if(!original||recoveryParents.get(parent)!==owner)throw TypeError('Original Team recovery parent required');assertOriginalTeamProvisioningOwner(original.domain,owner);assertOriginalManagedTeamParent(original.domain,parent)}
export function reserveOriginalTeamProvisioning(owner:OriginalTeamProvisioningOwner,action:ManagedAction<FactOutcome>):OriginalTeamProvisioningCandidate{const original=owners.get(owner);if(!original)throw TypeError('Original Team provisioning owner required');assertOriginalTeamProvisioningOwner(original.domain,owner);assertManagedActionCurrent(original.domain,action);if(!original.domain.owner.ownsAction(action))throw TypeError('Original Team provisioning action required');let candidate:OriginalTeamProvisioningCandidate;candidate=Object.freeze({kind:'original-team-provisioning-candidate' as const,abandon(){if(this!==candidate)throw TypeError('Original Team candidate required');const record=candidates.get(candidate);if(!record||record.used)throw TypeError('Original Team candidate unavailable');record.used=true}});candidates.set(candidate,{owner,action,used:false});return candidate}
export function assertOriginalTeamProvisioningCandidateOwner(owner:OriginalTeamProvisioningOwner,candidate:OriginalTeamProvisioningCandidate){const original=owners.get(owner),record=candidates.get(candidate);if(!original||!record||record.owner!==owner||record.used)throw TypeError('Original Team provisioning candidate required');assertOriginalTeamProvisioningOwner(original.domain,owner);assertManagedActionCurrent(original.domain,record.action)}
type Original={owner:OriginalTeamProvisioningOwner;candidate:OriginalTeamProvisioningCandidate;domain:ManagedExecutionDomain;action:ManagedAction<FactOutcome>;capture:object;outcome:FactOutcome;event:ProvisioningEvent;pin:ReturnType<typeof retainAcknowledgedExecutionMembers>;finish:()=>void;closed:boolean;closing?:Promise<void>}
const originals=new WeakMap<OriginalTeamProvisioning,Original>()
function read(domain:ManagedExecutionDomain,witness:OriginalTeamProvisioning):Original {
 const original=originals.get(witness);if(!original||original.closed||original.domain!==domain||!isManagedExecutionDomain(domain))throw TypeError('Original Team provisioning required')
 assertOriginalTeamProvisioningOwner(domain,original.owner)
 original.pin.assertCurrent();const members=readManagedActionMembers(domain,original.action,original.capture,original.outcome)
 if(members.length!==1||members[0]!==original.event)throw TypeError('Original Team provisioning changed')
 return original
}
/** Passive exact-ACK check for already-issued settlement after new work is fenced. */
export function assertOriginalTeamProvisioningHeld(owner:OriginalTeamProvisioningOwner,witness:OriginalTeamProvisioning){const authority=owners.get(owner),original=originals.get(witness);if(!authority||!original||original.closed||original.owner!==owner||original.domain!==authority.domain||!isManagedExecutionDomain(authority.domain))throw TypeError('Original held Team provisioning required');original.pin.assertCurrent();const members=readManagedActionMembers(authority.domain,original.action,original.capture,original.outcome);if(members.length!==1||members[0]!==original.event)throw TypeError('Original held Team provisioning changed');return original.candidate}
/** Transfer the exact acknowledged original provisioning action to the birth
 * owner; the witness owns its finish and retained member until close. */
export function createOriginalTeamProvisioning(owner:OriginalTeamProvisioningOwner,candidate:OriginalTeamProvisioningCandidate,capture:object,outcome:FactOutcome):OriginalTeamProvisioning {
 const authority=owners.get(owner),reservation=candidates.get(candidate);if(!authority||!reservation||reservation.owner!==owner||reservation.used)throw TypeError('Original Team provisioning candidate required');const {domain}=authority,action=reservation.action;assertOriginalTeamProvisioningOwner(domain,owner)
 const members=readManagedActionMembers(domain,action,capture,outcome),event=members[0]
 if(members.length!==1||event?.type!=='team/member'||event.member.phase!=='provisioning'||event.member.sessionId!==event.member.id||!event.teamId||!event.member.id||!event.member.name)throw TypeError('Original Team provisioning member required')
 const field=Object.getOwnPropertyDescriptor(action,'finish');if(!field||!('value'in field)||typeof field.value!=='function')throw TypeError('Original Team action finish required')
 const pin=retainAcknowledgedExecutionMembers(capture,outcome),finish=field.value.bind(action) as ()=>void;reservation.used=true
 let witness:OriginalTeamProvisioning
 witness=Object.freeze({kind:'original-team-provisioning',assertCurrent(){if(this!==witness)throw TypeError('Original Team provisioning receiver required');read(domain,witness)},close(){if(this!==witness)return Promise.reject(TypeError('Original Team provisioning receiver required'));const original=originals.get(witness);if(!original||original.closed)return Promise.resolve();if(original.closing)return original.closing;const flight=Promise.resolve().then(()=>{original.finish();original.pin.release();original.closed=true});original.closing=flight;void flight.finally(()=>{if(original.closing===flight)original.closing=undefined}).catch(()=>{});return flight}})
 originals.set(witness,{owner,candidate,domain,action,capture,outcome,event,pin,finish,closed:false});return witness
}
/** Inspection exposes only the original acknowledged capture and member. */
export function inspectOriginalTeamProvisioning(domain:ManagedExecutionDomain,witness:OriginalTeamProvisioning){const original=read(domain,witness);return Object.freeze({action:original.action,capture:original.capture,outcome:original.outcome,event:original.event})}
export function assertOriginalTeamProvisioningOwnerWitness(owner:OriginalTeamProvisioningOwner,witness:OriginalTeamProvisioning){const authority=owners.get(owner);if(!authority)throw TypeError('Original Team provisioning owner required');const original=read(authority.domain,witness);if(original.owner!==owner)throw TypeError('Foreign Team provisioning owner');return original.candidate}
