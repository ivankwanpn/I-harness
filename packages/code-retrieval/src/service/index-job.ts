import { randomUUID } from 'node:crypto'
import { chunks } from '../chunker.ts'
import { identity, sourceIds } from '../config.ts'
import { embed, modelIdentity, validVector, vectorKey } from '../embedding.ts'
import { hash, type Store, type StoredFile } from '../store.ts'
import type { CodeAccess, CodeRetrievalConfig, CodeRetrievalOptions, CodeRetrievalStatus } from '../types.ts'
import type { ConfigurationOwner } from './configuration.ts'
import { diagnostics, phase, type RetrievalTelemetry } from './status.ts'

type JobBinding=ReturnType<NonNullable<CodeRetrievalOptions['registerJob']>>
export type Indexing={jobId:string;sourceIds?:string[];progress:{files:number;bytes:number};startedAt:number;phaseStartedAt:number;diagnostics:NonNullable<CodeRetrievalStatus['indexDiagnostics']>;cancel():void;bindings:Map<string,JobBinding>}

type IndexInput={sourceIds?:string[];force?:boolean}
type IndexTelemetry=Pick<RetrievalTelemetry,'metrics'|'usage'|'error'|'setError'|'setSourceHealth'|'status'>

/** Original index operation, including synchronous publish/settlement/retirement. */
async function stageIndex(options:CodeRetrievalOptions,store:Store,telemetry:Omit<IndexTelemetry,'status'>,
  reservation:Indexing,captured:CodeRetrievalConfig,access:CodeAccess,input:IndexInput,scope:string[]|undefined,
  signal:AbortSignal,check:()=>void,attempt:{current():Indexing|undefined;finish(outcome:'completed'|'cancelled'|'failed',reason?:string):void;release():void}) {
  try {
    await store.open(captured.maxDiskBytes);check()
    const files:StoredFile[]=[],seen=new Set<string>(),reasons=new Set<string>(),vectors=new Map<string,number[]>()
    const preserved=store.outside(scope)
    if(preserved.files>captured.maxFiles||preserved.chunks>captured.maxChunks)throw new Error('Preserved sources exceed index quotas; run a full refresh')
    let totalBytes=0,totalChunks=preserved.chunks,dimensions=captured.embedding?.dimensions,stagedBytes=0
    const reserve=(bytes:number)=>{stagedBytes+=bytes;if(stagedBytes>captured.maxDiskBytes/2)throw new Error('Code Context staging quota exceeded')}
    const cacheVector=(key:string,vector:number[])=>{if(!vectors.has(key))reserve(Buffer.byteLength(JSON.stringify(vector))+key.length);vectors.set(key,vector)}
    const model=captured.mode==='hybrid'?modelIdentity(captured.embedding!):''
    const old=store.status()
    if(preserved.files&&old.model!==model)throw new Error('Embedding configuration changed; run a full refresh')
    if(preserved.files&&captured.mode==='hybrid') {
      const retainedDimensions=store.vectorDimensions()
      if(dimensions!==undefined&&retainedDimensions!==undefined&&dimensions!==retainedDimensions)throw new Error('Stored embedding dimensions changed; run a full refresh')
      dimensions??=retainedDimensions
    }
    if(preserved.files&&old.partial)for(const reason of old.reasons)reasons.add(reason)
    phase(reservation,'reading')
    const iterator=options.reader.snapshots({...access,signal},{sourceIds:reservation.sourceIds,config:captured})
    for await(const file of iterator) {
      check()
      identity(file.sourceId,'source ID');identity(file.path,'source path');identity(file.revision,'source revision')
      if(typeof file.text!=='string'||typeof file.complete!=='boolean')throw new Error('Invalid admitted snapshot')
      if(reservation.sourceIds&&!reservation.sourceIds.includes(file.sourceId))throw new Error('Reader returned an unrequested source')
      const key=JSON.stringify([file.sourceId,file.path]);if(seen.has(key))throw new Error('Duplicate source path');seen.add(key)
      if(files.length+preserved.files>=captured.maxFiles){reasons.add('max-files');break}
      const bytes=Buffer.byteLength(file.text)
      if(!file.complete){reasons.add('incomplete-source');continue}
      if(bytes>captured.maxFileBytes){reasons.add('max-file-bytes');continue}
      if(totalBytes+bytes>captured.maxInputBytes){reasons.add('max-input-bytes');break}
      totalBytes+=bytes
      const digest=hash(file.text),previous=input.force?undefined:store.file(file.sourceId,file.path)
      const generated=previous?.hash===digest&&previous.revision===file.revision&&(previous.chunks.at(-1)?.endOffset??0)===file.text.length?previous.chunks:chunks(file)
      const parts:StoredFile['chunks']=[]
      for(const chunk of generated) {
        check()
        if(totalChunks>=captured.maxChunks){reasons.add('max-chunks');break}
        parts.push(chunk);totalChunks++
      }
      const staged={sourceId:file.sourceId,path:file.path,revision:file.revision,hash:digest,chunks:parts}
      reserve(Buffer.byteLength(JSON.stringify(staged)))
      files.push(staged)
      if(attempt.current()?.jobId===reservation.jobId){reservation.progress={files:files.length,bytes:totalBytes};Object.assign(reservation.diagnostics,{files:files.length,bytes:totalBytes,chunks:totalChunks-preserved.chunks})}
      if(reasons.has('max-chunks'))break
    }
    check()
    const diagnostic=options.reader.status?.()
    if(diagnostic?.partial)reasons.add('source-reader-partial')
    for(const reason of diagnostic?.reasons??[])reasons.add(reason.slice(0,128))
    if(reasons.size>32){const limited=[...reasons].slice(0,31);reasons.clear();for(const reason of limited)reasons.add(reason);reasons.add('more-source-reasons')}
    if(captured.mode==='hybrid') {
      phase(reservation,'embedding')
      const missing=new Map<string,string>()
      for(const file of files)for(const chunk of file.chunks) {
        const key=vectorKey(model,chunk.text),cached=old.model===model?store.vector(key):undefined
        if(cached){const vector=validVector(cached,dimensions);dimensions??=vector.length;cacheVector(key,vector);telemetry.metrics.embeddingCacheHits++}
        else missing.set(key,chunk.text)
      }
      const pending=[...missing]
      for(let offset=0;offset<pending.length;offset+=16) {
        const batch=pending.slice(offset,offset+16)
        const result=await embed(batch.map(([,text])=>text),{...captured.embedding!,...(dimensions?{dimensions}:{})},options,signal,telemetry.usage)
        check()
        for(let i=0;i<batch.length;i++){const vector=validVector(result[i],dimensions);dimensions??=vector.length;cacheVector(batch[i][0],vector)}
      }
    }
    check()
    phase(reservation,'publishing')
    store.commit(files,scope,[...reasons],model,vectors,captured.maxDiskBytes,check)
    telemetry.setSourceHealth(undefined)
    attempt.finish('completed')
  } catch(failure) {
    if(signal.aborted&&signal.reason?.message!=='Code Context deadline exceeded')attempt.finish('cancelled','Code Context indexing cancelled')
    else {telemetry.setError(failure instanceof Error?failure.message:'Code Context indexing failed');attempt.finish('failed',telemetry.error)}
  } finally {attempt.release()}
}

/** Single reservation, job-handle and settled-attempt owner. */
export function createIndexJobs(options:CodeRetrievalOptions,store:Store,
  lifetime:Pick<ConfigurationOwner,'config'|'admit'|'operation'|'control'|'hasForeignOperation'>,telemetry:IndexTelemetry) {
  const jobs=new Map<string,Promise<CodeRetrievalStatus>>()
  let indexing:Indexing|undefined,lastJob:CodeRetrievalStatus['lastJob'],settledDiagnostics:CodeRetrievalStatus['indexDiagnostics']
  async function startIndex(access:CodeAccess,input:{sourceIds?:string[];force?:boolean}={}):Promise<{jobId:string}> {
    lifetime.admit(access);sourceIds(input.sourceIds)
    if(input.force!==undefined&&typeof input.force!=='boolean')throw new Error('Invalid force flag')
    if(input.force) {
      const requested={...input,sourceIds:input.sourceIds?[...input.sourceIds]:undefined}
      const reserved=indexing,available=options.reader.indexSourceIds?.()
      if(options.reader.authorizeIndex) {
        if(!available || reserved&&!reserved.sourceIds)throw new Error('Code Context source authorization is unavailable for a rebuild')
        // Force owns a global drain, including searches. Check all current
        // sources and the exact active job, not just the requested replacement
        // subset, before aborting anyone's work or binding a replacement.
        const affected=[...new Set([...available,...(requested.sourceIds??[]),...(reserved?.sourceIds??[])])]
        await lifetime.operation(access,async(signal,check)=>{await options.reader.authorizeIndex!({...access,signal},{sourceIds:affected});check()})
        lifetime.admit(access)
        if(indexing!==reserved)return startIndex(access,requested)
      } else if(lifetime.hasForeignOperation(access.sessionId) || reserved&&!reserved.bindings.has(access.sessionId))throw new Error('Code Context source authorization is unavailable for a shared rebuild')
      return lifetime.control(async()=>{
        // Drainage and synchronous reservation share this owner. Admission
        // remains closed until the replacement is tracked in indexing/active.
        // Do not await the job here: later cancel/clear/disable owners must be
        // able to abort and drain it.
        lifetime.admit(access,true)
        return reserveIndex(access,requested,available)
      })
    }
    if(indexing){
      const reserved=indexing
      if(!reserved.bindings.has(access.sessionId)) {
        if(!options.reader.authorizeIndex || !reserved.sourceIds)throw new Error('Code Context source authorization is unavailable for a shared job')
        await lifetime.operation(access,async(signal,check)=>{await options.reader.authorizeIndex!({...access,signal},{sourceIds:[...reserved.sourceIds!]});check()})
        lifetime.admit(access)
        // Authority awaited for this exact lifetime cannot authorize a later
        // replacement whose actual source scope may be different.
        if(indexing!==reserved)return startIndex(access,input)
      }
      bindJob(access,reserved);return {jobId:reserved.jobId}
    }
    return reserveIndex(access,input)
  }
  function bindJob(access:CodeAccess,job:Indexing) {
    if(!job.bindings.has(access.sessionId))job.bindings.set(access.sessionId,options.registerJob?.(access,{jobId:job.jobId,cancel:job.cancel}))
  }
  function reserveIndex(access:CodeAccess,input:{sourceIds?:string[];force?:boolean},admittedSources?:string[]) {
    const jobId=`code-context-${randomUUID()}`,captured=structuredClone(lifetime.config),scope=input.sourceIds?[...new Set(input.sourceIds)]:undefined
    const readScope=scope??admittedSources??options.reader.indexSourceIds?.()
    const startedAt=Date.now()
    const jobController=new AbortController(),reservation:Indexing={jobId,sourceIds:readScope?[...readScope]:undefined,progress:{files:0,bytes:0},startedAt,phaseStartedAt:startedAt,
      diagnostics:{jobId,phase:'opening',elapsedMs:0,phaseElapsedMs:0,files:0,bytes:0,chunks:0},cancel:()=>jobController.abort(new Error('Code Context indexing cancelled')),bindings:new Map()}
    bindJob(access,reservation)
    let result:NonNullable<CodeRetrievalStatus['lastJob']>
    const finish=(outcome:'completed'|'cancelled'|'failed',reason?:string)=>{
      result={jobId,outcome,generation:store.status().generation,...(reason?{reason}:{})}
      lastJob=result;settledDiagnostics=diagnostics(reservation)
    }
    indexing=reservation;telemetry.setError(undefined)
    // Return the moved async operation directly: no new await after commit.
    const work=lifetime.operation(access,(signal,check)=>stageIndex(options,store,telemetry,reservation,captured,access,input,scope,signal,check,
      {current:()=>indexing,finish,release:()=>{if(indexing?.jobId===jobId)indexing=undefined}}),jobController).catch(failure=>{
      if(indexing?.jobId===jobId)indexing=undefined
      if(failure?.message!=='Code Context deadline exceeded'&&(jobController.signal.aborted||access.signal?.aborted||failure?.message==='Code Context operation cancelled'))finish('cancelled','Code Context indexing cancelled')
      else {telemetry.setError(failure instanceof Error?failure.message:'Code Context indexing failed');finish('failed',telemetry.error)}
    }).then(()=>{
      const snapshot={...telemetry.status(),lastJob:{...result}},sharedStatus=result.outcome==='completed'?'completed':result.outcome==='cancelled'?'killed':'error'
      for(const binding of new Set(reservation.bindings.values())) {
        try {binding?.finish(sharedStatus,JSON.stringify(result))}
        catch(failure) {telemetry.setError(`Code Context job management failed: ${failure instanceof Error?failure.message:String(failure)}`);finish('failed',telemetry.error)}
      }
      return telemetry.error?{...telemetry.status(),lastJob:{...result}}:snapshot
    })
    jobs.set(jobId,work)
    // Bound completed handles; callers can always inspect current durable status.
    if(jobs.size>64)jobs.delete(jobs.keys().next().value!)
    return {jobId}
  }
  return {startIndex,async wait(jobId:string){const job=jobs.get(jobId);if(!job)throw new Error('Unknown Code Context job');return job},
    get indexing(){return indexing},get lastJob(){return lastJob},get settledDiagnostics(){return settledDiagnostics}}
}
export type IndexJobs=ReturnType<typeof createIndexJobs>
