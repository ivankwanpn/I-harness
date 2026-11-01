import { createHash } from 'node:crypto'
import { CODE_OUTPUT_DIGEST_DOMAIN, encodeCodeOutputRecord, type CodeOutputDescriptor, type CodeOutputFooter, type CodeOutputHeader, type ManagedArtifactRef } from '@i-harness/core-session'
import type { ResultArtifactSink } from '@i-harness/context-output'

export type CodeManifestDisposition = { kind: 'ready'; ref: ManagedArtifactRef } | { kind: 'unavailable'; reason: 'quota' | 'encoding' | 'storage-refused' | 'unsupported-owner' | 'capture-canceled' }
type ManifestInspection = Readonly<{ header: CodeOutputHeader; footer: CodeOutputFooter | undefined; descriptorCount: number; unavailableTextCount: number; encodedBytes: number; artifactDigest: string }>
const inspections = new WeakMap<object, () => ManifestInspection>()
/** Metadata only; this observation conveys no native authority. */
export function inspectCodeOutputManifest(port: object): ManifestInspection | undefined { return inspections.get(port)?.() }
function detached<T>(value: T): T {
  const copy = JSON.parse(JSON.stringify(value)) as T
  const freeze = (v: unknown): void => { if (v && typeof v === 'object') { for (const child of Object.values(v)) freeze(child); Object.freeze(v) } }
  freeze(copy); return copy
}
/** One original sink/frontier. No lifetime record collection or output bodies. */
export function createCodeOutputManifest(header: CodeOutputHeader, options: {
  open(): Promise<ResultArtifactSink>
  confirm(ref: ManagedArtifactRef): Promise<void>
  supported?():Promise<boolean>
}) {
  header = detached(header)
  const fullDigest = createHash('sha256')
  let encodedBytes = 0, acknowledgedCount = 0, unavailableTextCount = 0
  const open=options.open.bind(options),confirm=options.confirm.bind(options),supported=options.supported?.bind(options)
  const digest = createHash('sha256').update(CODE_OUTPUT_DIGEST_DOMAIN), head = encodeCodeOutputRecord(header)
  let sink: ResultArtifactSink | undefined, headerDone = false, count = 0, lastSeq = -1
  let methods:{write:ResultArtifactSink['write'];reconcileWrite:ResultArtifactSink['reconcileWrite'];finish:ResultArtifactSink['finish'];refuse:NonNullable<ResultArtifactSink['refuse']>}|undefined
  let pending: Buffer | undefined, writeIssued = false, lastRecord: WeakRef<object> | undefined, current: object | undefined
  let flight: Promise<void> | undefined, footer: CodeOutputFooter | undefined, footerBytes: Buffer | undefined, footerDone = false
  let result: CodeManifestDisposition | undefined, finishFlight: Promise<CodeManifestDisposition> | undefined, nativeFinished: ManagedArtifactRef | undefined
  let refusal: Extract<CodeManifestDisposition,{kind:'unavailable'}> | undefined
  let lastDescriptorDigest:string|undefined
  let currentDescriptorDigest:string|undefined
  const recovery = (cause?: unknown) => Object.assign(new Error('Original Code manifest requires recovery'), { code: 'FACT_RECOVERY_REQUIRED', cause })
  async function write(bytes: Buffer, hash: boolean) {
    sink ??= await open()
    if(!methods){
      for(const name of ['write','reconcileWrite','finish','refuse'])if(typeof Object.getOwnPropertyDescriptor(sink,name)?.value!=='function')throw Object.assign(new Error('Original sink refusal capability unsupported; acquired owner retained'),{code:'ARTIFACT_OWNER_UNSUPPORTED'})
      methods={write:sink.write.bind(sink),reconcileWrite:sink.reconcileWrite.bind(sink),finish:sink.finish.bind(sink),refuse:sink.refuse!.bind(sink)}
    }
    if (pending && !pending.equals(bytes)) throw new Error('Original Code manifest pending bytes changed')
    pending ??= bytes
    if (writeIssued) {
      if (await methods.reconcileWrite() !== 'ready') throw recovery()
    } else {
      writeIssued = true
      await methods.write(pending)
    }
    if (hash) digest.update(pending)
    fullDigest.update(pending); encodedBytes += pending.length
    pending = undefined; writeIssued = false
  }
  async function initialize() {
    if (!headerDone) {
      if(supported && !await supported()){refusal={kind:'unavailable',reason:'unsupported-owner'};return false}
      await write(head, true); headerDone = true
    }
    return true
  }
  async function closeRefused():Promise<CodeManifestDisposition> {
    if(!refusal)throw recovery()
    if(sink){
      const cancel=methods?.refuse
      if(!cancel)throw recovery()
      const closed=await cancel('encoding')
      if(closed.kind!=='refused')throw recovery(closed.kind==='recovery-required'?closed.cause:undefined)
    }
    pending=undefined;writeIssued=false;current=undefined;lastRecord=undefined
    return result=Object.freeze({...refusal})
  }
  const port = Object.freeze({
    append(record: object, descriptor: Omit<CodeOutputDescriptor,'ordinal'>): Promise<void> {
      if (current && current !== record) return Promise.reject(new Error('Original Code manifest record still pending'))
      if (lastRecord?.deref() === record) {
        if(refusal)return Promise.resolve()
        try {
          const retry=encodeCodeOutputRecord({...descriptor,ordinal:count-1})
          if(createHash('sha256').update(retry).digest('hex')!==lastDescriptorDigest)throw new Error('Original acknowledged Code descriptor changed')
          return Promise.resolve()
        }catch(cause){return Promise.reject(cause)}
      }
      if (footer) return Promise.reject(new Error('Code manifest already sealed'))
      if(!refusal && (descriptor.member.receipt.owner.sessionId!==header.sessionId||descriptor.member.seq<=lastSeq||!Number.isSafeInteger(count+1)))return Promise.reject(new Error('Foreign or replayed Code output member'))
      const unavailableText = descriptor.item.kind === 'text' && descriptor.item.retention.kind === 'unavailable'
      let encoded:Buffer|undefined,encodedDigest:string|undefined
      if(!refusal) {
        try {encoded=encodeCodeOutputRecord({...descriptor,ordinal:count});encodedDigest=createHash('sha256').update(encoded).digest('hex')}
        catch(cause){if(current)return Promise.reject(cause);current=record;refusal={kind:'unavailable',reason:'encoding'};return Promise.reject(recovery(cause))}
      }
      if(current && !refusal) {
        try {if(encodedDigest!==currentDescriptorDigest)throw new Error('Original pending Code descriptor changed')}
        catch(cause){return Promise.reject(cause)}
      }
      if (flight) return flight
      current = record
      currentDescriptorDigest=encodedDigest
      const work = Promise.resolve().then(async () => {
        if (refusal) { lastRecord = new WeakRef(record); current = undefined; return }
        if (descriptor.member.receipt.owner.sessionId !== header.sessionId || descriptor.member.seq <= lastSeq || !Number.isSafeInteger(count + 1)) throw new Error('Foreign or replayed Code output member')
        const bytes=encoded!
        try { if(await initialize())await write(bytes, true) }
        catch (cause) {
          if ((cause as {code?:string})?.code === 'ARTIFACT_QUOTA') refusal = { kind: 'unavailable', reason: 'quota' }
          else throw recovery(cause)
        }
        if (!refusal) { acknowledgedCount++; if (unavailableText) unavailableTextCount++ }
        count++; lastSeq = descriptor.member.seq;lastDescriptorDigest=createHash('sha256').update(bytes).digest('hex'); lastRecord = new WeakRef(record); current = undefined
      })
      flight = work; void work.then(() => { if (flight === work) flight = undefined }, () => { if (flight === work) flight = undefined })
      return work
    },
    seal(value: Omit<CodeOutputFooter,'kind'|'count'|'digest'>) {
      if(value.terminal.receipt.owner.sessionId!==header.sessionId||value.terminal.seq<=lastSeq||value.store&&(value.store.receipt.owner.sessionId!==header.sessionId||value.store.seq>=value.terminal.seq))throw new Error('Foreign Code output terminal/store member')
      const candidate: CodeOutputFooter = { kind:'seal', count, digest: digest.copy().digest('hex'), ...value }
      // Empty output must hash its real header, installed during finish below.
      if (footer && JSON.stringify({ ...footer, digest:'' }) !== JSON.stringify({ ...candidate, digest:'' })) throw new Error('Original Code terminal changed')
      if (!footer) footer = detached(candidate)
    },
    finish(): Promise<CodeManifestDisposition> {
      if (result) return Promise.resolve(result)
      if (finishFlight) return finishFlight
      const work = Promise.resolve().then(async (): Promise<CodeManifestDisposition> => {
        if (!footer || current || flight) throw recovery()
        if (refusal) {
          return closeRefused()
        }
        if (!footerDone) {
          if(!await initialize())return result=refusal!
          footer = detached({ ...footer, digest: digest.copy().digest('hex') })
          try {footerBytes ??= encodeCodeOutputRecord(footer)}catch{refusal={kind:'unavailable',reason:'encoding'};return closeRefused()}
          await write(footerBytes, false); footerDone = true
        }
        if (!nativeFinished) {
          const settled = await methods!.finish(['terminated','replanned','policy-refused','interrupted'].includes(footer.status)?'capture-canceled':footer.truncated || footer.omitted ? 'producer-incomplete' : 'complete')
          if (settled.kind === 'recovery-required') throw recovery()
          if (settled.kind === 'refused') return result = { kind:'unavailable', reason:settled.reason }
          nativeFinished = Object.freeze({...settled.ref})
        }
        await confirm(nativeFinished)
        return result = Object.freeze({ kind:'ready', ref:nativeFinished })
      })
      finishFlight = work
      void work.then(() => { if (finishFlight === work) finishFlight = undefined }, () => { if (finishFlight === work) finishFlight = undefined })
      return work
    },
  })
  inspections.set(port, () => Object.freeze({ header, footer, descriptorCount: acknowledgedCount, unavailableTextCount, encodedBytes, artifactDigest: fullDigest.copy().digest('hex') }))
  return port
}
