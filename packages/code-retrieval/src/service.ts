import { randomUUID } from 'node:crypto'
import { chunks } from './chunker.ts'
import { configuration, identity, sourceIds } from './config.ts'
import { cosine, embed, modelIdentity, validVector, vectorKey } from './embedding.ts'
import { hash, Store, type StoredFile } from './store.ts'
import type { CodeAccess, CodeHit, CodeRetrievalOptions, CodeRetrievalService, CodeRetrievalStatus, CodeSearchResult, CodeSourceValidation } from './types.ts'

const MAX_SOURCE_CHECKS=256,MAX_SEARCH_CANDIDATES=1024

export function createCodeRetrievalService(options:CodeRetrievalOptions):CodeRetrievalService {
  identity(options.workspaceId,'workspace ID')
  let config=configuration(options.config??{}),closed=false,stopping=0,error:string|undefined
  const store=new Store(options.root,options.workspaceId)
  const metrics={embeddingRequests:0,embeddingCacheHits:0,reportedInputTokens:0,unreportedRequests:0}
  const usage={request(){metrics.embeddingRequests++;metrics.unreportedRequests++},reported(tokens:number){metrics.reportedInputTokens+=tokens;metrics.unreportedRequests--}}
  type Operation={controller:AbortController;done:Promise<unknown>;sessionId:string}
  const active=new Set<Operation>(),jobs=new Map<string,Promise<CodeRetrievalStatus>>()
  type JobBinding=ReturnType<NonNullable<CodeRetrievalOptions['registerJob']>>
  type Indexing={jobId:string;sourceIds?:string[];progress:{files:number;bytes:number};startedAt:number;phaseStartedAt:number;diagnostics:NonNullable<CodeRetrievalStatus['indexDiagnostics']>;cancel():void;bindings:Map<string,JobBinding>}
  let indexing:Indexing|undefined
  let lastJob:CodeRetrievalStatus['lastJob']
  let settledDiagnostics:CodeRetrievalStatus['indexDiagnostics']
  let sourceHealth:CodeRetrievalStatus['sourceHealth']
  let controls:Promise<unknown>=Promise.resolve()
  const status=():CodeRetrievalStatus=>({enabled:config.enabled,state:closed||!config.enabled?'disabled':stopping?'stopping':indexing?'indexing':error?'error':store.status().generation?'ready':'unindexed',
    config:structuredClone(config),...store.status(),metrics:{...metrics},activeJobs:active.size,...(indexing?{jobId:indexing.jobId,progress:{...indexing.progress},indexDiagnostics:diagnostics(indexing)}:settledDiagnostics?{indexDiagnostics:{...settledDiagnostics}}:{}),...(lastJob?{lastJob:{...lastJob}}:{}),...(sourceHealth?{sourceHealth:{...sourceHealth,reasons:[...sourceHealth.reasons]}}:{}),...(error?{error}:{})})
  function diagnostics(job:Indexing) {
    const now=Date.now()
    return {...job.diagnostics,elapsedMs:Math.max(0,now-job.startedAt),phaseElapsedMs:Math.max(0,now-job.phaseStartedAt)}
  }
  function phase(job:Indexing,value:NonNullable<CodeRetrievalStatus['indexDiagnostics']>['phase']) {
    job.diagnostics.phase=value;job.phaseStartedAt=Date.now()
  }
  function admit(access:CodeAccess,controlOwner=false) {
    identity(access.sessionId,'session ID');access.signal?.throwIfAborted()
    if(closed)throw new Error('Code Context is closed')
    if(!config.enabled)throw new Error('Code Context is disabled')
    if(stopping&&!controlOwner)throw new Error('Code Context is stopping')
  }
  function operation<T>(access:CodeAccess,run:(signal:AbortSignal,check:()=>void)=>Promise<T>,controller=new AbortController()):Promise<T> {
    const signal=access.signal?AbortSignal.any([access.signal,controller.signal]):controller.signal
    const deadline=Date.now()+config.deadlineMs
    const check=()=>{if(Date.now()>=deadline&&!signal.aborted)controller.abort(new Error('Code Context deadline exceeded'));signal.throwIfAborted()}
    const timer=setTimeout(()=>controller.abort(new Error('Code Context deadline exceeded')),config.deadlineMs)
    const item:Operation={controller,done:Promise.resolve(),sessionId:access.sessionId};active.add(item)
    const promise=Promise.resolve().then(()=>{check();return run(signal,check)}).finally(()=>{clearTimeout(timer);active.delete(item)})
    item.done=promise;return promise
  }
  function control<T>(fn:()=>Promise<T>):Promise<T> {
    stopping++
    const next=controls.then(async()=>{
      for(const item of active)item.controller.abort(new Error('Code Context operation cancelled'))
      await Promise.allSettled([...active].map(item=>item.done))
      return fn()
    }).finally(()=>{stopping--})
    controls=next.catch(()=>{});return next
  }
  async function startIndex(access:CodeAccess,input:{sourceIds?:string[];force?:boolean}={}):Promise<{jobId:string}> {
    admit(access);sourceIds(input.sourceIds)
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
        await operation(access,async(signal,check)=>{await options.reader.authorizeIndex!({...access,signal},{sourceIds:affected});check()})
        admit(access)
        if(indexing!==reserved)return startIndex(access,requested)
      } else if([...active].some(item=>item.sessionId!==access.sessionId) || reserved&&!reserved.bindings.has(access.sessionId))throw new Error('Code Context source authorization is unavailable for a shared rebuild')
      return control(async()=>{
        // Drainage and synchronous reservation share this owner. Admission
        // remains closed until the replacement is tracked in indexing/active.
        // Do not await the job here: later cancel/clear/disable owners must be
        // able to abort and drain it.
        admit(access,true)
        return reserveIndex(access,requested,available)
      })
    }
    if(indexing){
      const reserved=indexing
      if(!reserved.bindings.has(access.sessionId)) {
        if(!options.reader.authorizeIndex || !reserved.sourceIds)throw new Error('Code Context source authorization is unavailable for a shared job')
        await operation(access,async(signal,check)=>{await options.reader.authorizeIndex!({...access,signal},{sourceIds:[...reserved.sourceIds!]});check()})
        admit(access)
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
    const jobId=`code-context-${randomUUID()}`,captured=structuredClone(config),scope=input.sourceIds?[...new Set(input.sourceIds)]:undefined
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
    indexing=reservation;error=undefined
    const work=operation(access,async (signal,check)=>{
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
          if(indexing?.jobId===jobId){indexing.progress={files:files.length,bytes:totalBytes};Object.assign(indexing.diagnostics,{files:files.length,bytes:totalBytes,chunks:totalChunks-preserved.chunks})}
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
            if(cached){const vector=validVector(cached,dimensions);dimensions??=vector.length;cacheVector(key,vector);metrics.embeddingCacheHits++}
            else missing.set(key,chunk.text)
          }
          const pending=[...missing]
          for(let offset=0;offset<pending.length;offset+=16) {
            const batch=pending.slice(offset,offset+16)
            const result=await embed(batch.map(([,text])=>text),{...captured.embedding!,...(dimensions?{dimensions}:{})},options,signal,usage)
            check()
            for(let i=0;i<batch.length;i++){const vector=validVector(result[i],dimensions);dimensions??=vector.length;cacheVector(batch[i][0],vector)}
          }
        }
        check()
        phase(reservation,'publishing')
        store.commit(files,scope,[...reasons],model,vectors,captured.maxDiskBytes,check)
        sourceHealth=undefined
        finish('completed')
      } catch(failure) {
        if(signal.aborted&&signal.reason?.message!=='Code Context deadline exceeded')finish('cancelled','Code Context indexing cancelled')
        else {error=failure instanceof Error?failure.message:'Code Context indexing failed';finish('failed',error)}
      } finally {if(indexing?.jobId===jobId)indexing=undefined}
    },jobController).catch(failure=>{
      if(indexing?.jobId===jobId)indexing=undefined
      if(failure?.message!=='Code Context deadline exceeded'&&(jobController.signal.aborted||access.signal?.aborted||failure?.message==='Code Context operation cancelled'))finish('cancelled','Code Context indexing cancelled')
      else {error=failure instanceof Error?failure.message:'Code Context indexing failed';finish('failed',error)}
    }).then(()=>{
      const snapshot={...status(),lastJob:{...result}},sharedStatus=result.outcome==='completed'?'completed':result.outcome==='cancelled'?'killed':'error'
      for(const binding of new Set(reservation.bindings.values())) {
        try {binding?.finish(sharedStatus,JSON.stringify(result))}
        catch(failure) {error=`Code Context job management failed: ${failure instanceof Error?failure.message:String(failure)}`;finish('failed',error)}
      }
      return error?{...status(),lastJob:{...result}}:snapshot
    })
    jobs.set(jobId,work)
    // Bound completed handles; callers can always inspect current durable status.
    if(jobs.size>64)jobs.delete(jobs.keys().next().value!)
    return {jobId}
  }
  async function search(access:CodeAccess,input:Parameters<CodeRetrievalService['search']>[1]):Promise<CodeSearchResult> {
    admit(access);identity(input.query,'query');sourceIds(input.sourceIds)
    if(Buffer.byteLength(input.query)>1024)throw new Error('Query exceeds 1024 bytes')
    const limit=input.limit??10,maxBytes=Math.min(input.maxBytes??config.maxSearchBytes,config.maxSearchBytes)
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Invalid search limit')
    if(!Number.isInteger(maxBytes)||maxBytes<128)throw new Error('Search budget must allow a 128-byte result envelope')
    let prefix=input.pathPrefix
    if(prefix!==undefined){identity(prefix,'path prefix');prefix=prefix.replaceAll('\\','/').replace(/\/+$/,'');if(prefix.startsWith('/')||prefix.split('/').some(p=>p==='..'||p==='.')||prefix.includes(':'))throw new Error('Invalid relative path prefix')}
    if(config.autoRefresh)await service.wait((await startIndex(access,{sourceIds:input.sourceIds})).jobId)
    admit(access)
    const captured=structuredClone(config)
    return operation(access,async (signal,check)=>{
      await store.open(captured.maxDiskBytes);check()
      const state=store.status(),reasons=new Set(state.reasons),hits:CodeHit[]=[]
      let mode:CodeSearchResult['mode']='lexical'
      let candidates=store.candidates(input.query,input.sourceIds,prefix)
      if(captured.mode==='hybrid') {
        const model=modelIdentity(captured.embedding!)
        if(state.model!==model)reasons.add('embedding-index-rebuild-required')
        else {
          const [vector]=await embed([input.query],captured.embedding!,options,signal,usage);check()
          // A generation may commit while the transport is pending. Use only
          // candidates and vectors captured together from the current snapshot.
          if(store.status().generation!==state.generation)throw new Error('Index changed during search; retry')
          const lexical=new Map(candidates.map(c=>[JSON.stringify([c.sourceId,c.path,c.startOffset]),c.score]))
          candidates=store.all(input.sourceIds,prefix).map(c=>{
            check()
            const cached=store.vector(vectorKey(model,c.text)),score=lexical.get(JSON.stringify([c.sourceId,c.path,c.startOffset]))??0
            return {...c,score:(cached?cosine(vector,validVector(cached,vector.length)):0)+score/(score+1)}
          }).filter(c=>c.score>0).sort((a,b)=>b.score-a.score||a.path.localeCompare(b.path))
          mode='hybrid'
        }
      }
      if(!state.generation)reasons.add('unindexed')
      const result:CodeSearchResult={hits,mode,partial:reasons.size>0,reasons:[...reasons],generation:state.generation}
      const validated=new Map<string,CodeSourceValidation>(),refused=new Map<string,Extract<CodeSourceValidation,{valid:false}>>()
      const fileKey=(hit:CodeHit)=>JSON.stringify([hit.sourceId,hit.path,hit.revision])
      async function validate(hit:CodeHit):Promise<CodeSourceValidation> {
        let outcome:CodeSourceValidation
        try {
          const value=await options.reader.revalidate({...access,signal},hit)
          outcome=typeof value==='boolean'?(value?{valid:true}:{valid:false,reason:'stale-or-inaccessible-source'}):value
        } catch(failure) {
          check()
          const code=(failure as NodeJS.ErrnoException)?.code
          outcome={valid:false,reason:'source-validation-failed',...(typeof code==='string'?{code:code.slice(0,64)}:{})}
        }
        check()
        if(!outcome.valid){reasons.add(outcome.reason);refused.set(fileKey(hit),outcome)}
        return outcome
      }
      function boundedReasons(){
        result.partial=reasons.size>0;result.reasons=[...reasons]
        if(Buffer.byteLength(JSON.stringify({...result,hits:[]}))>maxBytes){result.reasons=['result-budget'];delete result.diagnostics}
      }
      let visited=0
      for(const candidate of candidates) {
        check()
        if(hits.length>=limit){reasons.add('result-limit');break}
        if(visited++>=MAX_SEARCH_CANDIDATES){reasons.add('candidate-budget');break}
        const hit={...candidate,generation:state.generation}
        const key=fileKey(hit)
        if(!validated.has(key)) {
          if(validated.size>=MAX_SOURCE_CHECKS){reasons.add('source-validation-limit');break}
          validated.set(key,await validate(hit))
        }
        if(!validated.get(key)!.valid)continue
        hits.push(hit);boundedReasons()
        // Reserve room for a budget reason before admitting a hit.
        if(Buffer.byteLength(JSON.stringify({...result,partial:true,reasons:[...result.reasons,'result-budget']}))>maxBytes){hits.pop();reasons.add('result-budget')}
      }
      // Cached admission avoids a full file read for each chunk, but is never
      // publication authority. Recheck each returned file after candidate work
      // so a revision, ignore policy, or permission change removes every chunk.
      for(const hit of [...new Map(hits.map(hit=>[fileKey(hit),hit])).values()]) {
        if(!(await validate(hit)).valid)for(let i=hits.length-1;i>=0;i--)if(fileKey(hits[i])===fileKey(hit))hits.splice(i,1)
      }
      if(refused.size) {
        const diagnostics=new Map<string,NonNullable<CodeSearchResult['diagnostics']>[number]>()
        for(const refusal of refused.values()) {
          const key=JSON.stringify([refusal.reason,refusal.code]),previous=diagnostics.get(key)
          if(previous)previous.count++
          else if(diagnostics.size<16)diagnostics.set(key,{reason:refusal.reason,...(refusal.code?{code:refusal.code}:{}),count:1})
        }
        result.diagnostics=[...diagnostics.values()]
      }
      boundedReasons()
      while(Buffer.byteLength(JSON.stringify(result))>maxBytes&&hits.length){hits.pop();reasons.add('result-budget');boundedReasons()}
      check()
      const healthReasons:string[]=[...new Set([...refused.values()].map(value=>value.reason))]
      for(const reason of ['source-validation-limit','candidate-budget'])if(reasons.has(reason))healthReasons.push(reason)
      sourceHealth={scope:'last-search',state:healthReasons.length?'degraded':validated.size?'current':'unchecked',generation:state.generation,checkedFiles:validated.size,refusedFiles:refused.size,reasons:healthReasons,checkedAt:Date.now()}
      return result
    })
  }
  const service:CodeRetrievalService={status,startIndex,search,
    async wait(jobId){const job=jobs.get(jobId);if(!job)throw new Error('Unknown Code Context job');return job},
    async configure(patch){const captured=structuredClone(patch);configuration(captured,config);await control(async()=>{if(closed)throw new Error('Code Context is closed');config=configuration(captured,config);error=undefined;sourceHealth=undefined});return status()},
    async cancel(){await control(async()=>{});return status()},
    async clear(){await control(async()=>{if(closed)throw new Error('Code Context is closed');await store.open(config.maxDiskBytes);store.clear();error=undefined;sourceHealth=undefined});return status()},
    async close(){if(closed)return;await control(async()=>{store.close();closed=true})},
  }
  return service
}
