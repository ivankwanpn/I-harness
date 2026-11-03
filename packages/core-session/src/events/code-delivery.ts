import { conversationId, conversationSeq } from './conversation.ts'
import { isStrictFactData } from '../managed/capture.ts'
import { validManagedArtifactRef } from '../results/validate.ts'
import { validCodeOutputRecord, type CodeOutputHeader, type CodeOutputFooter } from '../results/code-output.ts'
import type { ManagedArtifactRef, ResultOutcome, ResultRetention } from '../results/types.ts'

export interface CodeDeliverySourceEvent { type:'agent/delivery-source';version:1;kind:'code';sourceNamespace:'code';recipientSessionId:string;generationId:string;sourceId:string;callSeq:number;cellId:string;delivery:'tool';seq?:number }
export interface CodeDeliveryHandoffEvent { type:'agent/delivery-handoff';version:1;kind:'code';sourceSeq:number;seq?:number }
export interface CodeDeliveryKey { kind:'code';sourceNamespace:'code';recipientSessionId:string;sourceId:string;resultRevision:string }
type End={type:'code/end';version:1;sourceSeq:number;cellId:string;seq?:number}
export type CodeTerminalEvent=End & ({execution:{dispatch:'dispatched';outcome:ResultOutcome}} & ({result:{kind:'artifact';ref:ManagedArtifactRef};output:{header:CodeOutputHeader;footer:CodeOutputFooter;unavailableTextCount:number}} | {result:Extract<ResultRetention,{kind:'unavailable'}>} ) | {execution:{dispatch:'not-dispatched';outcome:'unknown'};reason:'launch-refused'} | {execution:{dispatch:'unknown';outcome:'unknown'};reason:'launch-unknown'})
export type CodeDeliveryEvent=CodeDeliverySourceEvent|CodeDeliveryHandoffEvent|CodeTerminalEvent
const closed=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Reflect.ownKeys(v).every(k=>typeof k==='string'&&keys.includes(k)&&Object.getOwnPropertyDescriptor(v,k)?.enumerable&&Object.getOwnPropertyDescriptor(v,k)?.value!==undefined)
export function validCodeDeliveryEvent(value:unknown):value is CodeDeliveryEvent {
 if(!isStrictFactData(value)||!value||typeof value!=='object')return false
 const e=value as CodeDeliveryEvent
 if(e.version!==1||e.seq!==undefined&&!conversationSeq(e.seq))return false
 if(e.type==='agent/delivery-source')return closed(e,['type','version','kind','sourceNamespace','recipientSessionId','generationId','sourceId','callSeq','cellId','delivery','seq'])&&e.kind==='code'&&e.sourceNamespace==='code'&&[e.recipientSessionId,e.generationId,e.sourceId,e.cellId].every(conversationId)&&conversationSeq(e.callSeq)&&e.delivery==='tool'
 if(e.type==='agent/delivery-handoff')return closed(e,['type','version','kind','sourceSeq','seq'])&&e.kind==='code'&&conversationSeq(e.sourceSeq)
 if(e.type!=='code/end'||!conversationSeq(e.sourceSeq)||!conversationId(e.cellId)||!closed(e.execution,['dispatch','outcome']))return false
 if(e.execution.dispatch!=='dispatched')return closed(e,['type','version','sourceSeq','cellId','execution','reason','seq'])&&e.execution.outcome==='unknown'&&'reason'in e&&(e.execution.dispatch==='not-dispatched'&&e.reason==='launch-refused'||e.execution.dispatch==='unknown'&&e.reason==='launch-unknown')
 if(!['succeeded','failed','canceled','unknown'].includes(e.execution.outcome)||!('result'in e))return false
 const result=e.result
 if(result?.kind==='unavailable')return closed(e,['type','version','sourceSeq','cellId','execution','result','seq'])&&closed(result,['kind','reason','observedEncodedBytes'])&&['quota','encoding','storage-refused','unsupported-owner','capture-canceled'].includes(result.reason)&&(result.observedEncodedBytes===undefined||conversationSeq(result.observedEncodedBytes))
 if(result?.kind!=='artifact'||!closed(e,['type','version','sourceSeq','cellId','execution','result','output','seq'])||!closed(result,['kind','ref'])||!validManagedArtifactRef(result.ref)||result.ref.codec!=='code-output-manifest-v1'||!('output'in e)||!closed(e.output,['header','footer','unavailableTextCount']))return false
 const {header,footer,unavailableTextCount}=e.output
 return validCodeOutputRecord(header)&&header.kind==='code-output'&&validCodeOutputRecord(footer)&&footer.kind==='seal'&&header.cellId===e.cellId&&conversationSeq(unavailableTextCount)&&unavailableTextCount<=footer.count&&footer.terminal.receipt.owner.sessionId===header.sessionId&&(!footer.store||footer.store.receipt.owner.sessionId===header.sessionId&&footer.store.seq<footer.terminal.seq)&&(e.seq===undefined||footer.terminal.seq<e.seq)
}
export function eligibleCodeTerminal(event:CodeTerminalEvent):boolean {
 if(!validCodeDeliveryEvent(event)||event.execution.dispatch!=='dispatched'||!('output'in event)||event.result.kind!=='artifact')return false
 const {footer,unavailableTextCount}=event.output
 return (event.execution.outcome==='succeeded'&&footer.status==='completed'||event.execution.outcome==='failed'&&footer.status==='failed')&&!footer.truncated&&footer.omitted===0&&unavailableTextCount===0&&event.result.ref.completeness==='complete'
}
export function codeTerminalRef(event:CodeTerminalEvent):ManagedArtifactRef|undefined{return 'result'in event&&event.result.kind==='artifact'?event.result.ref:undefined}
