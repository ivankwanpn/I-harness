import {canonicalJsonData} from '@i-harness/core-session'
import {assertOriginalManagedTeamParent,assertOriginalTeamRecoveryParent,type OriginalTeamProvisioningOwner} from '@i-harness/core-session/internal/execution'
import {captureTeamBirthBinding,teamBirthBindingKey} from './team-birth-binding.ts'
import {issueHeldTeamBirthScope} from './team-birth-scope.ts'
import {originalTeamBindingBackend,type OriginalTeamColdBinding} from '../team-child-recovery-internal.ts'
import type {ManagedExecutionDomain,OriginalManagedTeamParent} from '@i-harness/core-session/internal/execution'
import type {Ownership,OwnershipCleanup} from './ownership.ts'
import type {PersistenceBackend} from './types.ts'
import type {createBindingObservations} from './binding-observation.ts'

const originals=new WeakMap<OriginalTeamColdBinding,PersistenceBackend>()
export function inspectOriginalTeamColdBinding(backend:PersistenceBackend,observation:OriginalTeamColdBinding){if(originals.get(observation)!==backend)throw TypeError('Original Team cold binding required');const result=observation.inspect();if(result.kind!=='confirmed')throw TypeError('Confirmed Team binding required');return result.binding}

/** Original coordinator observation; a missing binding alone never proves a missing child. */
export function createTeamColdBindingOwner(backend:PersistenceBackend,ownership:Ownership,observations:ReturnType<typeof createBindingObservations>,captureParent:(owner:ManagedExecutionDomain['owner'])=>{id:string;assertCurrent():void}){
 const port=originalTeamBindingBackend(backend),active=new Set<OriginalTeamColdBinding>();let retired=false
 function capture(input:{domain:ManagedExecutionDomain;owner:OriginalTeamProvisioningOwner;parent:OriginalManagedTeamParent;teamId:string;memberId:string}):OriginalTeamColdBinding{
  if(retired||!port)throw TypeError('Original Team cold binding unavailable')
  const {domain,owner,parent,teamId,memberId}=input;assertOriginalManagedTeamParent(domain,parent);assertOriginalTeamRecoveryParent(owner,parent)
  const mounted=captureParent(domain.owner);if(mounted.id!==domain.sessionId)throw TypeError('Original Team coordinator parent required');mounted.assertCurrent()
  const members=parent.ledger.filter(event=>event.type==='team/member'&&event.teamId===teamId&&event.member.id===memberId),member=members.at(-1)
  if(!member||member.type!=='team/member'||member.member.phase!=='provisioning'||member.member.sessionId!==memberId)throw TypeError('Original Team provisioning required')
  const key=teamBirthBindingKey(domain.sessionId,memberId),acquisitions:OwnershipCleanup[]=[];let revoked=false,closed=false,closing:Promise<void>|undefined,pin:Awaited<ReturnType<Ownership['pinOwnership']>>|undefined,documentPin:Awaited<ReturnType<Ownership['pinDocumentOwnership']>>|undefined,lease:Awaited<ReturnType<Ownership['acquireDocumentLease']>>|undefined,session:ReturnType<NonNullable<typeof port>['open']>|undefined,result:ReturnType<OriginalTeamColdBinding['inspect']>|undefined
  const current=()=>{if(retired||revoked||closed)throw TypeError('Original Team cold binding retired');assertOriginalManagedTeamParent(domain,parent);assertOriginalTeamRecoveryParent(owner,parent);parent.assertInitialPrefix();mounted.assertCurrent();pin?.assertHeld();documentPin?.assertHeld();if(lease&&!lease.held)throw Error('Original Team binding lease lost')}
  const cleanup=()=>{if(closing)return closing;const pending=(async()=>{await ready.catch(()=>{});await session?.settleResources();for(const acquisition of acquisitions){await acquisition.close();acquisition.assertSettled()}registration.unregister();closed=true;active.delete(observation)})();closing=pending;void pending.finally(()=>{if(closing===pending)closing=undefined}).catch(()=>{});return pending}
  const registration=observations.registerTeamColdObservation(domain.sessionId,key,{revoke(){revoked=true},close(){revoked=true;return cleanup()},retryClose(){revoked=true;return cleanup()}})
  const ready=Promise.resolve().then(async()=>{await registration.join();current();pin=await ownership.pinOwnershipRetained(domain.sessionId,item=>acquisitions.push(item));current();await ownership.artifacts?.prepareDocument(key);current();documentPin=await ownership.pinDocumentOwnershipRetained(key,item=>acquisitions.push(item));current();lease=await ownership.acquireDocumentLease(key,item=>acquisitions.push(item));current();const scope=issueHeldTeamBirthScope(ownership,domain.sessionId,memberId,pin,{assertActive:current,captureIssued(){throw TypeError('Cold Team binding cannot issue')},assertOriginal:current});session=port.open(scope);const read=await session.observe();current();if(read.kind==='absent'){result=Object.freeze({kind:'no-binding'});return}let binding:ReturnType<typeof captureTeamBirthBinding>;try{binding=captureTeamBirthBinding(read.value)}catch{result=Object.freeze({kind:'conflict'});return}if(binding.parentSessionId!==domain.sessionId||canonicalJsonData(binding.provisioning)!==canonicalJsonData(member)){result=Object.freeze({kind:'conflict'});return}const confirmed=await session.confirm(read.witness);current();if(confirmed.kind==='confirmed'&&!confirmed.cleanupPending){registration.allowTeamObservation();result=Object.freeze({kind:'confirmed',binding})}else result=Object.freeze({kind:confirmed.kind==='conflict'?'conflict':'unavailable'})})
  const observation:OriginalTeamColdBinding=Object.freeze({ready,inspect(){if(this!==observation||!result)throw TypeError('Original Team cold observation unavailable');current();return result},close(){if(this!==observation)return Promise.reject(TypeError('Original Team cold observation required'));if(closed)return Promise.resolve();revoked=true;return cleanup()}});originals.set(observation,backend);active.add(observation);void ready.catch(()=>{});return observation
 }
 return {capture,async close(){retired=true;const results=await Promise.allSettled([...active].map(item=>item.close())),errors=results.flatMap(item=>item.status==='rejected'?[item.reason]:[]);if(errors.length)throw new AggregateError(errors,'Original Team cold observations require cleanup')}}
}
