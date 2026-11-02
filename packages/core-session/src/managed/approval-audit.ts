import {assertOriginalManagedActionSource,readManagedActionMembers,readManagedSourceAcknowledgedMembers} from './execution-state.ts'
import type {ManagedExecutionDomain} from './execution-types.ts'
import {retainAcknowledgedExecutionMembers} from './execution-members.ts'
import type {ManagedAction} from './ports.ts'
import type {FactOutcome,SessionEventView} from './types.ts'

type Pin=ReturnType<typeof retainAcknowledgedExecutionMembers>
type Evidence={capture:object;outcome:FactOutcome;source?:object;pin:Pin;members:readonly SessionEventView[]}
type Record={domain:ManagedExecutionDomain;action:ManagedAction<FactOutcome>;source:object;actionId:string;open:Evidence;members:Evidence[];closed:boolean}
export interface OriginalManagedApprovalAudit {readonly kind:'original-managed-approval-audit'}
const records=new WeakMap<object,Record>()
function get(audit:OriginalManagedApprovalAudit):Record {const record=records.get(audit);if(!record||record.closed)throw TypeError('Original approval audit unavailable');return record}
function same(a:readonly SessionEventView[],b:readonly SessionEventView[]){return a.length===b.length&&a.every((value,index)=>value===b[index])}
/** Created only from the original acknowledged approval-open action capture. */
export function createOriginalManagedApprovalAudit(domain:ManagedExecutionDomain,action:ManagedAction<FactOutcome>,source:object,capture:object,outcome:FactOutcome):OriginalManagedApprovalAudit {
 assertOriginalManagedActionSource(domain,action,source)
 const members=readManagedActionMembers(domain,action,capture,outcome),event=members[0]
 if(members.length!==1||event?.type!=='context/action'||event.op!=='open'||event.purpose!=='approval'||event.ownerSessionId!==domain.sessionId)throw TypeError('Original approval open required')
 const pin=retainAcknowledgedExecutionMembers(capture,outcome),audit=Object.freeze({kind:'original-managed-approval-audit' as const})
 records.set(audit,{domain,action,source,actionId:event.actionId,open:{capture,outcome,pin,members},members:[],closed:false});return audit
}
function record(audit:OriginalManagedApprovalAudit,capture:object,outcome:FactOutcome,source?:object){
 const original=get(audit);assertOriginalManagedActionSource(original.domain,original.action,original.source)
 if(source!==undefined&&source!==original.source)throw TypeError('Original approval source required')
 const members=source===undefined?readManagedActionMembers(original.domain,original.action,capture,outcome):readManagedSourceAcknowledgedMembers(original.domain,source,capture,outcome)
 if(!members.length||members.some(event=>!((event.type==='context/action'&&(event.op==='bind'||event.op==='constrain'))||(event.type==='context/attempt'&&['reserve','rebind','settle'].includes(event.op)))||event.actionId!==original.actionId||event.ownerSessionId!==original.domain.sessionId))throw TypeError('Original approval audit member required')
 if(original.members.some(row=>row.capture===capture))throw TypeError('Original approval audit already recorded')
 const pin=retainAcknowledgedExecutionMembers(capture,outcome);original.members.push({capture,outcome,...source?{source}:{},pin,members})
}
export function recordOriginalManagedApprovalAction(audit:OriginalManagedApprovalAudit,capture:object,outcome:FactOutcome){record(audit,capture,outcome)}
export function recordOriginalManagedApprovalSource(audit:OriginalManagedApprovalAudit,source:object,capture:object,outcome:FactOutcome){record(audit,capture,outcome,source)}
/** Count is a boundary only: every permitted suffix member must be an exact
 * acknowledged original capture, rechecked under its retained source pin. */
export function assertOriginalManagedApprovalAudit(domain:ManagedExecutionDomain,action:ManagedAction<FactOutcome>,audit:OriginalManagedApprovalAudit,fromOrdinal:number,currentCount:number):void {
 const original=get(audit);if(original.domain!==domain||original.action!==action||!Number.isSafeInteger(fromOrdinal)||!Number.isSafeInteger(currentCount)||currentCount<fromOrdinal)throw TypeError('Original approval audit owner mismatch')
 assertOriginalManagedActionSource(domain,action,original.source)
 original.open.pin.assertCurrent();if(!same(readManagedActionMembers(domain,action,original.open.capture,original.open.outcome),original.open.members))throw TypeError('Original approval open changed')
 const suffix:SessionEventView[]=[]
 for(const entry of original.members){entry.pin.assertCurrent();const actual=entry.source?readManagedSourceAcknowledgedMembers(domain,entry.source,entry.capture,entry.outcome):readManagedActionMembers(domain,action,entry.capture,entry.outcome);if(!same(actual,entry.members))throw TypeError('Original approval audit changed');for(const event of actual)if(event.seq!==undefined&&event.seq>=fromOrdinal)suffix.push(event)}
 if(suffix.length!==currentCount-fromOrdinal||suffix.some((event,index)=>event.seq!==fromOrdinal+index))throw TypeError('Original reviewer context suffix changed')
}
export function closeOriginalManagedApprovalAudit(audit:OriginalManagedApprovalAudit):void {const original=records.get(audit);if(!original||original.closed)return;original.closed=true;for(const entry of original.members)entry.pin.release();original.open.pin.release()}
