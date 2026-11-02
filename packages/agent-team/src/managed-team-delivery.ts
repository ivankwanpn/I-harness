import {isDeepStrictEqual} from 'node:util'
import {committedFactSeqs,type CapturedSettlementFact,type FactOutcome,type ManagedAction,type SessionEvent,type SettlementFacts} from '@i-harness/core-session'
import {reserveOriginalTeamDelivery,reserveOriginalTeamDeliveryFromArchive,assertOriginalTeamDeliveryReceipt,type ManagedExecutionDomain,type OriginalTeamProvisioningOwner} from '@i-harness/core-session/internal/execution'

type Inbox=Extract<SessionEvent,{type:'subagent/inbox'}>
type Lease=ReturnType<typeof reserveOriginalTeamDelivery>
type Disposition='pending'|'claimed'|'cancelled'|'suppressed'
type Record={event:Inbox;action?:ManagedAction<FactOutcome>;source?:SettlementFacts<FactOutcome>;capture?:CapturedSettlementFact<FactOutcome>;outcome?:FactOutcome;lease?:Lease;leaseReady?:boolean;disposition?:Disposition;settling?:Promise<void>;driving?:Promise<Disposition>;closing?:Promise<void>}

/** The mounted Team retains each original inbox source and evidence through the
 * recipient ACK. Replays join the same held record; archive replay uses the
 * original owner's bounded evidence rather than issuing another inbox fact. */
export function createManagedTeamLeadDeliveries(domain:ManagedExecutionDomain,owner:OriginalTeamProvisioningOwner,teamId:string,hasInbox:(id:string)=>boolean){
 const records=new Map<string,Record>()
 const settle=(record:Record):Promise<void>=>{
  if(record.outcome||!record.capture)return Promise.resolve()
  if(record.settling)return record.settling
  const flight=(async()=>{const outcome=await record.capture!.reconcile();committedFactSeqs(outcome);if(outcome.kind!=='committed')throw TypeError('Original Team inbox ACK required');record.outcome=outcome})()
  record.settling=flight;void flight.finally(()=>{if(record.settling===flight)record.settling=undefined}).catch(()=>{});return flight
 }
 const release=(record:Record):Promise<void>=>{
  if(record.closing)return record.closing
  const flight=(async()=>{if(record.lease){await record.lease.close();record.lease=undefined}if(record.source){await record.source.close();record.source=undefined}if(record.action){record.action.finish();record.action=undefined}records.delete(record.event.messageId)})()
  record.closing=flight;void flight.finally(()=>{if(record.closing===flight)record.closing=undefined}).catch(()=>{});return flight
 }
 const acquire=async(event:Inbox):Promise<Record>=>{
  const existing=records.get(event.messageId)
  if(existing){if(!isDeepStrictEqual(existing.event,event))throw TypeError('Original Team inbox tuple changed');return existing}
  const record:Record={event:structuredClone(event)};records.set(event.messageId,record)
  try{
   if(hasInbox(event.messageId)){record.lease=reserveOriginalTeamDeliveryFromArchive(owner,{teamId,messageId:event.messageId})}
   else{const action=domain.owner.beginAction() as ManagedAction<FactOutcome>;record.action=action;record.source=action.registerSettlementSource(()=>settle(record));record.capture=record.source.delivery.capture(record.event)}
   return record
  }catch(primary){try{await release(record)}catch(cleanup){throw new AggregateError([primary,cleanup],'Original Team delivery acquisition and cleanup failed')}throw primary}
 }
 return {
  async deliver(event:Inbox,admit:(evidence:ReturnType<Lease['evidence']>)=>Promise<unknown>){
   const record=await acquire(event);if(record.driving)return record.driving
   const flight=(async()=>{if(record.disposition){const disposition=record.disposition;await release(record);return disposition}if(!record.lease){await settle(record);record.lease=reserveOriginalTeamDelivery(owner,{teamId,messageId:event.messageId,action:record.action!,source:record.source!,capture:record.capture!,outcome:record.outcome!})}if(!record.leaseReady){try{await record.lease.ready}catch(error){if((error as {code?:string})?.code!=='TEAM_DELIVERY_PREFIX_ADVANCED')throw error;await record.lease.retryReady()}record.leaseReady=true}const evidence=record.lease.evidence(),receipt=await admit(evidence);const disposition=assertOriginalTeamDeliveryReceipt(evidence,receipt as Parameters<typeof assertOriginalTeamDeliveryReceipt>[1]);record.disposition=disposition;await release(record);return disposition})()
   record.driving=flight;void flight.finally(()=>{if(record.driving===flight)record.driving=undefined}).catch(()=>{});return flight
  },
  async abandon(id:string){const record=records.get(id);if(record){await record.driving?.catch(()=>{});await release(record)}},
  async close(){const failures:unknown[]=[];for(const record of records.values())try{await record.driving?.catch(()=>{});await release(record)}catch(error){failures.push(error)}if(failures.length)throw new AggregateError(failures,'Original Team delivery cleanup incomplete')},
 }
}
