import { randomUUID, createHash } from 'node:crypto'
import { CODE_OUTPUT_DIGEST_DOMAIN, encodeCodeOutputRecord, canonicalJsonData, isNondurableSession, isOwnedSettlementSource, type CodeOutputDescriptor, type CodeOutputFooter, type FactOwner, type CodeOutputMember, type ManagedArtifactRef } from '@i-harness/core-session'
import { inspectCodeOutputManifest, inspectCodeOutputManifestReceipt } from '../../output-retention/src/result/code-output-manifest.ts'
import { readCodeManifestConfirmationHistory } from '../../context-output/src/service.ts'
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
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T
export type CompletionEvidence = DeepReadonly<{header:ReturnType<typeof headerFor>;footer:CodeOutputFooter;unavailableTextCount:number;ref:ManagedArtifactRef;source:{sourceId:string}}>
const headerFor=(sessionId:string,cellId:string,sourceId:string)=>({version:1 as const,kind:'code-output' as const,sessionId,cellId,sourceId})
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
export function createFinalCodeOutputs(owner: FactOwner, factory: CodeFinalOutputFactory | undefined, drive:()=>Promise<void>, onAcknowledged?:(id:string)=>void) {
  type Slot = { lifetime?:ReturnType<typeof createFinalOutputLifetime<FinalCodeOutputPortResult,CodeFinalOutputPort>>; port?:CodeFinalOutputPort; runtime:OriginalCellFinalization; count:number; unavailable:number; digest:ReturnType<typeof createHash>; full:ReturnType<typeof createHash>; bytes:number; header:ReturnType<typeof headerFor>; footer?:CodeOutputFooter; evidence?:CompletionEvidence; last?:WeakRef<object>; store:CodeOutputMember|null; failed?:true; cause?:unknown; sealed:boolean;sealedGate:ReturnType<typeof Promise.withResolvers<void>>;handle:{settle():Promise<FinalCodeOutputDisposition>} }
  type FinalCodeOutputPortResult = FinalCodeOutputDisposition
  const slots = new Map<string,Slot>()
  const listeners=new Set<(id:string,handle:Slot['handle'])=>void>()
  const registry = {
    bind(mount:object) { if(mounts.has(mount))throw new Error('Original Code mount already associated');mounts.set(mount, registry) },
    observe(listener:(id:string,handle:Slot['handle'])=>void){listeners.add(listener);return()=>{listeners.delete(listener)}},
    capture(id:string) { return slots.get(id)?.handle },
    captureCompletion(id:string) { const slot=slots.get(id);return slot && {settle:slot.handle.settle,evidence:()=>slot.evidence} },
    retains(id:string) { return slots.has(id) },
    reserve(cellId:string, sessionId:string|undefined, original:OriginalCellFinalization, runtime:OriginalCellFinalization, instruction:boolean) {
      if (!factory || !sessionId || instruction || isNondurableSession(owner.view) || owner.view.formatVersion!==14) return
      if(slots.has(cellId))throw new Error('Original Code output cell still owned')
      const sourceId = randomUUID()
      const header=headerFor(sessionId,cellId,sourceId),head=encodeCodeOutputRecord(header)
      const initialized=Promise.withResolvers<void>()
      const slot:Slot={runtime,count:0,unavailable:0,header,digest:createHash('sha256').update(CODE_OUTPUT_DIGEST_DOMAIN).update(head),full:createHash('sha256').update(head),bytes:head.length,store:null,sealed:false,sealedGate:Promise.withResolvers<void>(),handle:Object.freeze({async settle(){
        await initialized.promise
        if(!slot.sealed){const advancing=drive();void advancing.catch(()=>{});await Promise.race([advancing,slot.sealedGate.promise])}
        if(!slot.lifetime)throw slot.cause
        const out=await slot.lifetime.settle();if(slots.get(cellId)===slot){slots.delete(cellId);onAcknowledged?.(cellId)}return out
      }})}
      slots.set(cellId,slot) // Retain admission/init debt before calling factory.
      for(const listener of listeners){try{listener(cellId,slot.handle)}catch{/* Passive capture only. */}}
      try {
        slot.lifetime=createFinalOutputLifetime<FinalCodeOutputDisposition,CodeFinalOutputPort>(owner, original, assertHeld=>factory({cellId,sessionId,sourceId,assertHeld}),sessionId,(port,result)=>{
          const metadata=inspectCodeOutputManifest(port),receipt=inspectCodeOutputManifestReceipt(port)
          if(!metadata || !receipt) return
          const history=readCodeManifestConfirmationHistory(receipt),footer=slot.footer
          const same=(a:unknown,b:unknown)=>canonicalJsonData(a)===canonicalJsonData(b)
          if(result.kind!=='ready'||!footer||!same(metadata.header,header)||!same(metadata.footer,footer)||metadata.descriptorCount!==slot.count||metadata.unavailableTextCount!==slot.unavailable||metadata.encodedBytes!==slot.bytes||metadata.artifactDigest!==slot.full.copy().digest('hex')||!same(history.ref,result.ref)||history.operationId!==sourceId||history.sessionId!==sessionId||history.callId!==cellId||result.ref.encodedBytes!==slot.bytes||result.ref.contentDigest!==metadata.artifactDigest)throw Object.assign(new Error('Original Code manifest evidence mismatch'),{code:'FACT_RECOVERY_REQUIRED'})
          const copy=JSON.parse(JSON.stringify({header,footer,unavailableTextCount:slot.unavailable,ref:history.ref,source:history.source})) as CompletionEvidence
          const freeze=(value:unknown):void=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value)}}
          freeze(copy);slot.evidence=copy
        })
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
        const bytes=encodeCodeOutputRecord({kind:'output',ordinal:slot.count,member,item})
        await slot.port!.append(record,{kind:'output',member,item})
        if(slot.last?.deref()!==record){slot.digest.update(bytes);slot.full.update(bytes);slot.bytes+=bytes.length;slot.count++;if(item.kind==='text'&&item.retention.kind==='unavailable')slot.unavailable++;slot.last=new WeakRef(record)}
      } else if(event.type==='code/store') slot.store=member
      else if(event.type==='code/cell') {
        const stats=readOriginalOutputLifetime(slot.runtime)
        const seal={ terminal:member,status:stats.instructionReplan?'replanned' as const:stats.policyRefusal?'policy-refused' as const:event.state==='interrupted'?'interrupted' as const:event.state==='completed'?'completed' as const:event.state==='terminated'?'terminated' as const:'failed' as const,store:slot.store,
          accepted:stats.accepted,omitted:stats.accepted-slot.count,truncated:stats.truncated || stats.accepted!==slot.count }
        slot.port!.seal(seal)
        if(!slot.footer){slot.footer={kind:'seal',count:slot.count,digest:slot.digest.copy().digest('hex'),...seal};const bytes=encodeCodeOutputRecord(slot.footer);slot.full.update(bytes);slot.bytes+=bytes.length}
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
