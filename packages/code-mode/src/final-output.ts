import { randomUUID } from 'node:crypto'
import { isNondurableSession, isOwnedSettlementSource, type CodeOutputDescriptor, type CodeOutputFooter, type FactOwner, type CodeOutputMember, type ManagedArtifactRef } from '@i-harness/core-session'
import { originalCodeCommit } from './event-facts/commit-proof.ts'
import { createFinalOutputLifetime } from './final-output-lifetime.ts'
import { readOriginalOutputLifetime, type OriginalCellFinalization } from './finalization.ts'
export type FinalCodeOutputDisposition = { kind:'ready'; ref:ManagedArtifactRef } | { kind:'unavailable'; reason:'quota'|'encoding'|'storage-refused'|'unsupported-owner'|'capture-canceled' }
export interface CodeFinalOutputPort {
  append(record: object, descriptor: Omit<CodeOutputDescriptor,'ordinal'>): Promise<void>
  seal(footer: Omit<CodeOutputFooter,'kind'|'count'|'digest'>): void
  finish(): Promise<FinalCodeOutputDisposition>
}
export type CodeFinalOutputFactory = (input: { cellId:string;sessionId:string;sourceId:string;assertHeld():void }) => CodeFinalOutputPort
const mounts = new WeakMap<object, ReturnType<typeof createFinalCodeOutputs>>()
export function captureOriginalCodeFinalOutput(mount: object, cellId: string) {
  const original = mounts.get(mount)?.capture(cellId)
  if (!original) throw Object.assign(new Error('Original Code final output unavailable'), { reason:'unsupported-owner' })
  return original
}
export function observeOriginalCodeFinalOutputs(mount:object, listener:(id:string,handle:{settle():Promise<FinalCodeOutputDisposition>})=>void) {
  const registry=mounts.get(mount)
  if(!registry)throw new Error('Original Code mount required')
  return registry.observe(listener)
}
/** Existing mount owns the actual independent sources and pending frontiers. */
export function createFinalCodeOutputs(owner: FactOwner, factory: CodeFinalOutputFactory | undefined, drive:()=>Promise<void>) {
  type Slot = { lifetime?:ReturnType<typeof createFinalOutputLifetime<FinalCodeOutputPortResult,CodeFinalOutputPort>>; port?:CodeFinalOutputPort; runtime:OriginalCellFinalization; count:number; store:CodeOutputMember|null; failed?:true; cause?:unknown; sealed:boolean;sealedGate:ReturnType<typeof Promise.withResolvers<void>>;handle:{settle():Promise<FinalCodeOutputDisposition>} }
  type FinalCodeOutputPortResult = FinalCodeOutputDisposition
  const slots = new Map<string,Slot>()
  const listeners=new Set<(id:string,handle:Slot['handle'])=>void>()
  const registry = {
    bind(mount:object) { if(mounts.has(mount))throw new Error('Original Code mount already associated');mounts.set(mount, registry) },
    observe(listener:(id:string,handle:Slot['handle'])=>void){listeners.add(listener);return()=>{listeners.delete(listener)}},
    capture(id:string) { return slots.get(id)?.handle },
    reserve(cellId:string, sessionId:string|undefined, original:OriginalCellFinalization, runtime:OriginalCellFinalization, instruction:boolean) {
      if (!factory || !sessionId || instruction || isNondurableSession(owner.view) || owner.view.formatVersion!==14) return
      if(slots.has(cellId))throw new Error('Original Code output cell still owned')
      const sourceId = randomUUID()
      const initialized=Promise.withResolvers<void>()
      const slot:Slot={runtime,count:0,store:null,sealed:false,sealedGate:Promise.withResolvers<void>(),handle:Object.freeze({async settle(){
        await initialized.promise
        if(!slot.sealed){const advancing=drive();void advancing.catch(()=>{});await Promise.race([advancing,slot.sealedGate.promise])}
        if(!slot.lifetime)throw slot.cause
        const out=await slot.lifetime.settle();if(slots.get(cellId)===slot)slots.delete(cellId);return out
      }})}
      slots.set(cellId,slot) // Retain admission/init debt before calling factory.
      for(const listener of listeners){try{listener(cellId,slot.handle)}catch{/* Passive capture only. */}}
      try {
        slot.lifetime=createFinalOutputLifetime<FinalCodeOutputDisposition,CodeFinalOutputPort>(owner, original, assertHeld=>factory({cellId,sessionId,sourceId,assertHeld}),sessionId)
        slot.port=slot.lifetime.operation
      }catch(cause){slot.failed=true;slot.cause=cause;throw cause}finally{initialized.resolve()}
    },
    async commit(record:object) {
      const proof = originalCodeCommit(record), event = proof.event
      if (!('cellId' in event)) return
      const slot = slots.get(event.cellId)
      if (!slot) return
      if(!isOwnedSettlementSource(owner.view,proof.source))throw new Error('Foreign Code queue source')
      if(slot.failed) {if(event.type==='code/cell'){slot.sealed=true;slot.sealedGate.resolve();return}throw slot.cause}
      proof.source.assertHeld()
      if (proof.outcome.kind !== 'committed' || proof.outcome.seqs.length !== 1) throw new Error('Original durable Code member required')
      const member:CodeOutputMember = { seq:proof.outcome.seqs[0]!, receipt:proof.outcome.receipt }
      if(event.type==='code/output') {
        const media = event.content && typeof event.content === 'object' ? Object.getOwnPropertyDescriptor(event.content,'type')?.value : undefined
        const item:CodeOutputDescriptor['item'] = media === 'image' || media === 'audio'
          ? {kind:media,read:'current-fact-required'}
          : {kind:'text',retention:event.envelope?.retention.kind==='artifact' && ['json-utf8-v1','text-utf8-v1'].includes(event.envelope.retention.ref.codec) ? event.envelope.retention : event.envelope?.retention.kind==='unavailable' ? event.envelope.retention : {kind:'unavailable',reason:'unsupported-owner'}}
        await slot.port!.append(record,{kind:'output',member,item})
        slot.count++
      } else if(event.type==='code/store') slot.store=member
      else if(event.type==='code/cell') {
        const stats=readOriginalOutputLifetime(slot.runtime)
        slot.port!.seal({ terminal:member,status:stats.instructionReplan?'replanned':stats.policyRefusal?'policy-refused':event.state==='interrupted'?'interrupted':event.state==='completed'?'completed':event.state==='terminated'?'terminated':'failed',store:slot.store,
          accepted:stats.accepted,omitted:stats.accepted-slot.count,truncated:stats.truncated || stats.accepted!==slot.count })
        slot.sealed=true;slot.sealedGate.resolve()
        // Start owner closure, but NEVER await it from this queue phase.
        void registry.capture(event.cellId)!.settle().catch(()=>{})
      }
    },
    async drain() {
      const results=await Promise.allSettled([...slots.keys()].map(id=>registry.capture(id)!.settle()))
      const failed=results.filter((r):r is PromiseRejectedResult=>r.status==='rejected')
      if(failed.length)throw Object.assign(new AggregateError(failed.map(r=>r.reason),'Original Code final output incomplete'),{code:'FACT_RECOVERY_REQUIRED'})
    },
  }
  return registry
}
