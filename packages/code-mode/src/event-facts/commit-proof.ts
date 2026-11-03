import { isManagedExecutionSource, readManagedActionMembers, readManagedSourceAcknowledgedMembers, type ManagedExecutionDomain } from '@i-harness/core-session/internal/execution'
import type { CodeModeFactOwner } from '../facts.ts'
import { isManagedFactOwner, isManagedSettlementSource, settlementSourceSessionId, factPrefixDigest, type ProducerFactOutcome, type CapturedActionFact, type SettlementFacts, type FactOwner, type SessionView, type SessionEventView, type OwnerToken } from '@i-harness/core-session'
import type { Pending } from './state.ts'
type CanonicalCodeMember = Extract<SessionEventView,{type:'code/output'|'code/result'|'code/cell'|'code/store'}>
type Capture = {record:Pending;owner:CodeModeFactOwner;view?:SessionView;domain?:ManagedExecutionDomain;fact:CapturedActionFact<ProducerFactOutcome>;source:SettlementFacts<ProducerFactOutcome>;observe():Promise<ProducerFactOutcome>;expected:NonNullable<Pending['expectedMember']>;token:Readonly<OwnerToken>}
const captures = new WeakMap<object,Capture>()
const originals = new WeakMap<object, Readonly<{event:CanonicalCodeMember;outcome:Extract<ProducerFactOutcome,{kind:'committed'}>;fact:Capture['fact'];source:Capture['source']}>>()
function refuse():never {throw new Error('Original canonical Code member required')}
function assertCurrent(captured:Capture) {
  const {record,owner,view,fact,source,expected,token}=captured
  if(record.fact!==fact||record.source!==source||record.expectedMember!==expected||record.expectedOwner!==token)refuse()
  if(captured.domain){if(captured.domain.owner!==owner||captured.domain.sessionId!==token.sessionId||!isManagedExecutionSource(captured.domain,source))refuse()}else if(!view||(owner as FactOwner).view!==view||!isManagedFactOwner(view,owner as FactOwner)||!isManagedSettlementSource(view,source)||settlementSourceSessionId(view,source)!==token.sessionId)refuse()
}
/** Full-managed-owner adapter only. Private R6 mode needs its own genuine
 * capture-member port; never materialize a public history as a fallback. */
export function retainOriginalCodeCapture(record:Pending,owner:CodeModeFactOwner,domain?:ManagedExecutionDomain) {
  const existing=captures.get(record)
  if(existing){if(existing.owner!==owner||existing.domain!==domain||existing.fact!==record.fact||existing.source!==record.source)refuse();return}
  const {fact,source,expectedMember:expected,expectedOwner:token}=record,view=domain?undefined:(owner as FactOwner).view
  if(!fact||!source||!expected||!token)refuse()
  if(domain){if(domain.owner!==owner||domain.sessionId!==token.sessionId||!isManagedExecutionSource(domain,source))refuse()}else if(!view||!isManagedFactOwner(view,owner as FactOwner)||!isManagedSettlementSource(view,source)||settlementSourceSessionId(view,source)!==token.sessionId)refuse()
  captures.set(record,{record,owner,view,domain,fact,source,observe:fact.observe.bind(fact),expected,token})
}
/** Invoked by the real queue after its exact original captured fact returns.
 * Observe is retained before issuance; equality rejects a substituted reply.
 * Selection is one immutable member from that same original owner's view. */
export async function bindOriginalCodeCommit(record: Pending, outcome: ProducerFactOutcome) {
  const captured=captures.get(record)
  if(!captured)refuse()
  const {view,fact,source,expected,token}=captured
  assertCurrent(captured)
  if(await captured.observe()!==outcome)refuse()
  assertCurrent(captured)
  if(record.nativeOutcome!==outcome)refuse()
  if(outcome.kind!=='committed'||outcome.seqs.length!==1)refuse()
  const {receipt,seqs}=outcome,{key}=receipt,seq=seqs[0]!
  if(receipt.owner.sessionId!==token.sessionId||receipt.owner.incarnation!==token.incarnation||!Number.isSafeInteger(seq)||!Number.isSafeInteger(key.firstSeq)||!Number.isSafeInteger(key.count)||key.count<1||seq<key.firstSeq||seq>=key.firstSeq+key.count||receipt.lastSeq!==key.firstSeq+key.count-1||receipt.prefixDigest!==factPrefixDigest(key.previousPrefixDigest,key.batchDigest))refuse()
  const members=captured.domain?(record.action?readManagedActionMembers(captured.domain,record.action,fact,outcome):readManagedSourceAcknowledgedMembers(captured.domain,source,fact,outcome)):undefined
  const event=members?members[0]:view!.events[seq]
  if(members&&members.length!==1||!event||event.seq!==seq||event.type!==expected.type||!('cellId'in event)||event.cellId!==expected.cellId||!Object.isFrozen(event))refuse()
  const existing=originals.get(record)
  if(existing&&(existing.fact!==fact||existing.outcome!==outcome||existing.source!==source||existing.event!==event))refuse()
  originals.set(record,Object.freeze({event:event as CanonicalCodeMember,outcome,fact,source}))
}
export function originalCodeCommit(record: object) {
  const proof = originals.get(record)
  if (!proof) throw new Error('Original Code queue commit required')
  const captured=captures.get(record)
  if(!captured)refuse()
  assertCurrent(captured)
  if(captured.record.nativeOutcome!==proof.outcome)refuse()
  const members=captured.domain?(captured.record.action?readManagedActionMembers(captured.domain,captured.record.action,captured.fact,proof.outcome):readManagedSourceAcknowledgedMembers(captured.domain,captured.source,captured.fact,proof.outcome)):undefined
  if(members?members.length!==1||members[0]!==proof.event:captured.view!.events[proof.event.seq!]!==proof.event)refuse()
  return proof
}
