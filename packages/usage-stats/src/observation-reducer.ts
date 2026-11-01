import { decodeUsageObservation, encodeUsageObservation } from './observation-codec.js'
import { validateUsageRecord } from './aggregate.js'
import type { UsageFactObservation, UsageLiveObservation, UsageObservationV1 } from './observation-types.js'
import type { UsageRecord } from './types.js'

type Fact<T extends UsageFactObservation['type']> = Extract<UsageFactObservation,{type:T}>
type Live<T extends UsageLiveObservation['type']> = Extract<UsageLiveObservation,{type:T}>
type Row = UsageObservationV1
export interface ObservationAction {
 ownerSessionId:string; actionId:string; startedAt:number; purpose:Fact<'action-open'>['purpose'];
 origin:Fact<'action-open'>['origin']; executionDomain:'physical'|'local-test'|null;
 disposition:Fact<'action-close'>['disposition'] | null; durable:boolean
}
export interface ObservationSend {
 ownerSessionId:string; actionId:string; attemptId:string; sendId:string; handoffAt:number;
 lane:Fact<'attempt-reserve'>['lane']; rebind:number; durable:boolean;
 disposition:Fact<'attempt-settle'>['disposition'] | null;
 inputTokens?:number; outputTokens?:number; cacheReadTokens?:number; cacheCreationTokens?:number;
 inputTokenSemantics?:'includes-cache'|'excludes-cache';
 providerId?:string; modelId?:string; workspace?:string; projectId?:string; billing?:'api'|'subscription'|'unknown';
 totalInputTokens:number|null; uncachedInputTokens:number|null; totalTokens:number|null;
 coverage:'complete'|'incomplete'|'unavailable';
 /** No price authority is bound by this inactive projection. Subscription is never API cost. */
 estimatedCostUsd:null; costCoverage:'subscription-no-api-cost'|'unavailable'
}
export interface ObservationProjection {
 actions:ObservationAction[]; sends:ObservationSend[]; warnings:string[];
 totals:{logicalActions:number;transportHandoffs:number;localInvocations:number;unknownReservations:number;knownUnsentCandidates:number;unknownUsage:number;unattributedInvocations:number;legacyInvocations:number;measuredSends:number;unavailableSends:number;
 measuredInputSubtotal:number|null;measuredOutputSubtotal:number|null;measuredTokenSubtotal:number|null;cacheHitRate:number|null};
}
const tuple=(...parts:(string|number)[])=>JSON.stringify(parts)
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b)
const counters=['inputTokens','outputTokens','cacheReadTokens','cacheCreationTokens','inputTokenSemantics'] as const
const attribution=['providerId','modelId','workspace','projectId','billing'] as const
const isFact=(row:Row):row is Extract<Row,{source:'journal-fact'|'memory-committed'}>=>row.source!=='live-owner'

/** Pure inactive projection. Reduce the complete observation population BEFORE applying
 * [start,end): actions use action.startedAt, sends use original handoff observedAt,
 * local invocations and unknown reservation candidates use their original observation time.
 * Legacy rows are counted separately and never folded into measured send subtotals. */
export function reduceUsageObservations(input:readonly unknown[],query:{start:number;end:number},legacy:readonly UsageRecord[]=[]):ObservationProjection {
 if(!Number.isSafeInteger(query.start)||!Number.isSafeInteger(query.end)||query.start<0||query.end<=query.start)throw new TypeError('Invalid observation range')
 const warnings=new Set<string>(), byId=new Map<string,{row:Row;bytes:string}>(), conflicts=new Set<string>()
 let inputIncomplete=false
 const warn=(message:string)=>{warnings.add(message)}
 const inRange=(time:number)=>time>=query.start&&time<query.end
 // A conflicting immutable ID invalidates all its variants, independent of arrival order.
 for(const value of input){try{const bytes=encodeUsageObservation(value),row=decodeUsageObservation(bytes),old=byId.get(row.observationId)
  if(old&&old.bytes!==bytes){inputIncomplete=true;conflicts.add(row.observationId);warn('Conflicting observation ID: '+row.observationId)}else if(!old)byId.set(row.observationId,{row,bytes})
 }catch{inputIncomplete=true;warn('Invalid observation skipped; coverage is incomplete')}}
 const rows=[...byId.values()].filter(x=>!conflicts.has(x.row.observationId)).map(x=>x.row)
 const groups=new Map<string,Row[]>()
 let unattributedInvocations=0,unknownUsage=0
 for(const row of rows){const o=row.observation;if(o.type==='unattributed-invocation'){if(inRange(row.observedAt))unattributedInvocations++;continue}
  const key=tuple(o.ownerSessionId,o.actionId),group=groups.get(key)??[];group.push(row);groups.set(key,group)}
 const actions:ObservationAction[]=[],sends:ObservationSend[]=[]
 let localInvocations=0,unknownReservations=0,knownUnsentCandidates=0
 const sendAssociations=new Map<string,Set<string>>()
 for(const row of rows){const h=row.observation;if(h.type!=='handoff')continue;const key=tuple(h.ownerSessionId,h.sendId),set=sendAssociations.get(key)??new Set<string>();set.add(tuple(h.actionId,h.attemptId,h.rebind,h.incarnation));sendAssociations.set(key,set)}
 // Stable entity ordering also stabilizes diagnostics and projected rows.
 for(const [actionKey,group] of [...groups].sort(([a],[b])=>a.localeCompare(b))){
  const facts=group.filter(isFact).sort((a,b)=>a.observation.factSeq-b.observation.factSeq||a.observationId.localeCompare(b.observationId))
  const factCoordinates=new Map<number,string>();let corrupt=false
  for(const row of facts){const bytes=encodeUsageObservation({...row,observationId:'coordinate',observedAt:0});const prior=factCoordinates.get(row.observation.factSeq);if(prior&&prior!==bytes)corrupt=true;factCoordinates.set(row.observation.factSeq,bytes)}
  const uniqueFacts=facts.filter((row,index)=>facts.findIndex(x=>x.observation.factSeq===row.observation.factSeq)===index)
  function one<T extends UsageFactObservation['type']>(type:T):{row:Row;value:Fact<T>}|undefined{
   const found=uniqueFacts.filter(row=>row.observation.type===type);if(found.length>1){corrupt=true;warn('Conflicting action phase: '+actionKey)}
   const row=found[0];return row?{row,value:row.observation as Fact<T>}:undefined
  }
  const opened=one('action-open'),bound=one('action-bind'),closed=one('action-close')
  if((opened&&bound&&bound.value.factSeq<=opened.value.factSeq)||(closed&&opened&&closed.value.factSeq<=opened.value.factSeq)||(closed&&bound&&closed.value.factSeq<=bound.value.factSeq))corrupt=true
  const validAction=!!opened&&!corrupt
  if(corrupt)warn('Conflicting fact coordinates or action phases: '+actionKey)
  if(validAction&&inRange(opened!.value.startedAt)){const o=opened!.value;actions.push({ownerSessionId:o.ownerSessionId,actionId:o.actionId,startedAt:o.startedAt,purpose:o.purpose,origin:o.origin,executionDomain:bound?.value.executionDomain??null,disposition:closed?.value.disposition??null,durable:uniqueFacts.every(row=>row.source==='journal-fact')})}
  const physical=validAction&&!!bound&&bound.value.executionDomain==='physical'
  const reservations=uniqueFacts.filter(row=>row.observation.type==='attempt-reserve')
  const ordinals=new Set<number>(),attemptIds=new Set<string>(),badAttempts=new Set<string>()
  for(const row of reservations){const r=row.observation as Fact<'attempt-reserve'>;if(ordinals.has(r.ordinal)||attemptIds.has(r.attemptId)){badAttempts.add(r.attemptId);for(const old of reservations){const v=old.observation as Fact<'attempt-reserve'>;if(v.ordinal===r.ordinal)badAttempts.add(v.attemptId)}}ordinals.add(r.ordinal);attemptIds.add(r.attemptId)}
  const matchedSnapshots=new Set<string>()
  const projectedAttempts=new Set<string>()
  for(const row of reservations){const reserve=row.observation as Fact<'attempt-reserve'>,attemptKey=tuple(actionKey,reserve.attemptId)
   if(projectedAttempts.has(reserve.attemptId))continue
   projectedAttempts.add(reserve.attemptId)
   let candidate={semanticId:reserve.semanticId,payloadId:reserve.payloadId,payloadKind:reserve.payloadKind,incarnation:reserve.incarnation},rebind=0,lastSeq=reserve.factSeq
   let valid=physical&&!badAttempts.has(reserve.attemptId)&&reserve.factSeq>bound!.value.factSeq&&(!closed||reserve.factSeq<closed.value.factSeq)
   const rebound=uniqueFacts.filter(x=>x.observation.type==='attempt-rebind'&&x.observation.attemptId===reserve.attemptId)
   const candidates=new Map<number,typeof candidate>([[0,candidate]])
   for(const item of rebound){const r=item.observation as Fact<'attempt-rebind'>;if(r.rebind!==rebind+1||r.factSeq<=lastSeq||[...candidates.values()].some(c=>c.incarnation===r.incarnation)||closed&&r.factSeq>=closed.value.factSeq)valid=false;rebind=r.rebind;lastSeq=r.factSeq;candidate={semanticId:r.semanticId,payloadId:r.payloadId,payloadKind:r.payloadKind,incarnation:r.incarnation};candidates.set(rebind,candidate)}
   const handoffs=group.filter(x=>x.observation.type==='handoff'&&x.observation.attemptId===reserve.attemptId)
   // Exactly one transport entry per reservation; retries require another reservation.
   const uniqueHandoffs=handoffs.filter((x,index)=>handoffs.findIndex(y=>same(y.observation,x.observation)&&y.observedAt===x.observedAt)===index)
   const settlements=uniqueFacts.filter(x=>x.observation.type==='attempt-settle'&&x.observation.attemptId===reserve.attemptId)
   const settled=settlements.at(-1)?.observation as Fact<'attempt-settle'>|undefined
   if(settlements.length>1||settled&&settled.factSeq<=lastSeq)valid=false
   if(!uniqueHandoffs.length){if(inRange(row.observedAt)){if(valid&&settled?.disposition==='unsent')knownUnsentCandidates++;else unknownReservations++}continue}
   if(uniqueHandoffs.length!==1)valid=false
   const hrow=uniqueHandoffs[0]!,h=hrow.observation as Live<'handoff'>,expected=candidates.get(h.rebind)
   if(h.rebind!==rebind||!expected||h.semanticId!==expected.semanticId||h.payloadId!==expected.payloadId||h.payloadKind!==expected.payloadKind||h.incarnation!==expected.incarnation||settled?.disposition==='unsent'||settled?.sendId!==undefined&&settled.sendId!==h.sendId)valid=false
   const sendKey=tuple(reserve.ownerSessionId,h.sendId);if(sendAssociations.get(sendKey)?.size!==1)valid=false
   if(!valid){warn('Incomplete or conflicting handoff association: '+attemptKey);if(inRange(row.observedAt))unknownReservations++;continue}
   const send:ObservationSend={ownerSessionId:reserve.ownerSessionId,actionId:reserve.actionId,attemptId:reserve.attemptId,sendId:h.sendId,handoffAt:hrow.observedAt,lane:reserve.lane,rebind:h.rebind,durable:uniqueFacts.every(row=>row.source==='journal-fact'),disposition:settled?.disposition??null,totalInputTokens:null,uncachedInputTokens:null,totalTokens:null,coverage:'unavailable',estimatedCostUsd:null,costCoverage:'unavailable'}
   const snapshots=group.filter(x=>x.observation.type==='usage-snapshot'&&x.observation.attemptId===reserve.attemptId&&x.observation.sendId===h.sendId).sort((a,b)=>(a.observation as Live<'usage-snapshot'>).snapshotOrdinal-(b.observation as Live<'usage-snapshot'>).snapshotOrdinal||a.observationId.localeCompare(b.observationId))
   const snapshotGroups=new Map<number,Row[]>();for(const snapshot of snapshots){matchedSnapshots.add(snapshot.observationId);const ordinal=(snapshot.observation as Live<'usage-snapshot'>).snapshotOrdinal;const list=snapshotGroups.get(ordinal)??[];list.push(snapshot);snapshotGroups.set(ordinal,list)}
   let incomplete=inputIncomplete,seen=false,terminal:Live<'usage-snapshot'>['terminalCoverage']='unknown'
   for(const list of snapshotGroups.values()){
    const s=list[0]!.observation as Live<'usage-snapshot'>
    if(list.some(x=>!same(x.observation,s))||s.validity!=='valid'){incomplete=true;warn('Invalid or conflicting usage update: '+attemptKey);continue}
    if(seen&&(attribution.some(key=>send[key]!==s[key])||s.inputTokenSemantics!==undefined&&send.inputTokenSemantics!==undefined&&s.inputTokenSemantics!==send.inputTokenSemantics)){incomplete=true;warn('Usage attribution or token semantics changed: '+attemptKey);continue}
    const next={...send};for(const key of counters)if(s[key]!==undefined)Object.assign(next,{[key]:s[key]})
    if(next.inputTokenSemantics==='includes-cache'&&next.inputTokens!==undefined&&((next.cacheReadTokens??0)+(next.cacheCreationTokens??0)>next.inputTokens)){incomplete=true;warn('Inconsistent cumulative cache update: '+attemptKey);continue}
    Object.assign(send,next);for(const key of attribution)if(s[key]!==undefined)Object.assign(send,{[key]:s[key]});seen=true;terminal=s.terminalCoverage
   }
   const input=send.inputTokens,read=send.cacheReadTokens,creation=send.cacheCreationTokens
   const safe=(value:number|undefined)=>value!==undefined&&Number.isSafeInteger(value)?value:null
   send.totalInputTokens=send.inputTokenSemantics==='includes-cache'?safe(input):send.inputTokenSemantics==='excludes-cache'&&input!==undefined&&read!==undefined&&creation!==undefined?safe(input+read+creation):null
   send.uncachedInputTokens=send.inputTokenSemantics==='excludes-cache'?safe(input):input!==undefined&&read!==undefined&&creation!==undefined&&send.inputTokenSemantics==='includes-cache'?safe(input-read-creation):null
   send.totalTokens=send.totalInputTokens!==null&&send.outputTokens!==undefined?safe(send.totalInputTokens+send.outputTokens):null
   if((send.totalInputTokens===null&&input!==undefined&&read!==undefined&&creation!==undefined&&send.inputTokenSemantics!==undefined)||(send.totalTokens===null&&send.totalInputTokens!==null&&send.outputTokens!==undefined)){incomplete=true;warn('Usage total is incomplete or outside safe numeric range: '+attemptKey)}
   send.coverage=!seen?'unavailable':incomplete||terminal!=='complete'||send.totalTokens===null?'incomplete':'complete'
   send.costCoverage=send.billing==='subscription'?'subscription-no-api-cost':'unavailable'
   if(inRange(send.handoffAt))sends.push(send)
  }
  for(const row of group){const o=row.observation;if(o.type==='usage-snapshot'&&!matchedSnapshots.has(row.observationId)&&inRange(row.observedAt)){unknownUsage++;warn('Usage has no complete physical association: '+actionKey)}if(o.type==='handoff'&&!attemptIds.has(o.attemptId)&&inRange(row.observedAt)){unknownReservations++;warn('Handoff has no reservation: '+actionKey)}}
  const locals=uniqueFacts.filter(x=>x.observation.type==='local-invocation')
  for(const row of locals){const local=row.observation as Fact<'local-invocation'>;const collisions=locals.filter(x=>{const v=x.observation as Fact<'local-invocation'>;return v.localInvocationId===local.localInvocationId||v.ordinal===local.ordinal});if(validAction&&bound&&bound.value.executionDomain==='local-test'&&local.factSeq>bound.value.factSeq&&(!closed||local.factSeq<closed.value.factSeq)&&collisions.length===1){if(inRange(row.observedAt))localInvocations++}else warn('Incomplete or conflicting local invocation: '+actionKey)}
 }
 const legacyIds=new Map<string,string>(),legacyConflicts=new Set<string>()
 for(const value of legacy){try{const r=validateUsageRecord(value),bytes=JSON.stringify(r),old=legacyIds.get(r.id);if(old&&old!==bytes){legacyConflicts.add(r.id);warn('Conflicting legacy ID: '+r.id)}else legacyIds.set(r.id,bytes)}catch{warn('Invalid legacy record skipped')}}
 const subtotal=(key:'totalInputTokens'|'outputTokens'|'totalTokens')=>{let total=0,measured=false;for(const send of sends){const value=send[key];if(value!==undefined&&value!==null){total+=value;measured=true;if(!Number.isSafeInteger(total)){warn('Measured subtotal overflow');return null}}}return measured?total:null}
 const inputSubtotal=subtotal('totalInputTokens'),outputSubtotal=subtotal('outputTokens'),tokenSubtotal=subtotal('totalTokens')
 let cacheNumerator=0,cacheDenominator=0
 for(const send of sends)if(send.totalInputTokens!==null&&send.cacheReadTokens!==undefined&&send.cacheCreationTokens!==undefined){cacheNumerator+=send.cacheReadTokens;cacheDenominator+=send.totalInputTokens}
 const cacheHitRate=Number.isSafeInteger(cacheNumerator)&&Number.isSafeInteger(cacheDenominator)&&cacheDenominator>0?cacheNumerator/cacheDenominator:null
 return {actions,sends,warnings:[...warnings].sort(),totals:{logicalActions:actions.length,transportHandoffs:sends.length,localInvocations,unknownReservations,knownUnsentCandidates,unknownUsage,unattributedInvocations,legacyInvocations:[...legacyIds].filter(([id,bytes])=>!legacyConflicts.has(id)&&inRange((JSON.parse(bytes) as UsageRecord).startedAt)).length,measuredSends:sends.filter(s=>s.totalTokens!==null).length,unavailableSends:sends.filter(s=>s.coverage!=='complete').length,measuredInputSubtotal:inputSubtotal,measuredOutputSubtotal:outputSubtotal,measuredTokenSubtotal:tokenSubtotal,cacheHitRate}}
}
