import { identity, sourceIds } from '../config.ts'
import { cosine, embed, modelIdentity, validVector, vectorKey } from '../embedding.ts'
import type { Store } from '../store.ts'
import type { CodeAccess, CodeHit, CodeRetrievalOptions, CodeRetrievalService, CodeSearchResult } from '../types.ts'
import type { ConfigurationOwner } from './configuration.ts'
import type { RetrievalTelemetry } from './status.ts'
import { createRevalidation, MAX_SOURCE_CHECKS } from './revalidation.ts'

const MAX_SEARCH_CANDIDATES=1024

export function createSearch(options:CodeRetrievalOptions,store:Store,lifetime:Pick<ConfigurationOwner,'config'|'admit'|'operation'>,
  startIndex:CodeRetrievalService['startIndex'],wait:CodeRetrievalService['wait'],telemetry:Pick<RetrievalTelemetry,'usage'|'setSourceHealth'>) {
  async function search(access:CodeAccess,input:Parameters<CodeRetrievalService['search']>[1]):Promise<CodeSearchResult> {
    lifetime.admit(access);identity(input.query,'query');sourceIds(input.sourceIds)
    if(Buffer.byteLength(input.query)>1024)throw new Error('Query exceeds 1024 bytes')
    const limit=input.limit??10,maxBytes=Math.min(input.maxBytes??lifetime.config.maxSearchBytes,lifetime.config.maxSearchBytes)
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Invalid search limit')
    if(!Number.isInteger(maxBytes)||maxBytes<128)throw new Error('Search budget must allow a 128-byte result envelope')
    let prefix=input.pathPrefix
    if(prefix!==undefined){identity(prefix,'path prefix');prefix=prefix.replaceAll('\\','/').replace(/\/+$/,'');if(prefix.startsWith('/')||prefix.split('/').some(p=>p==='..'||p==='.')||prefix.includes(':'))throw new Error('Invalid relative path prefix')}
    if(lifetime.config.autoRefresh)await wait((await startIndex(access,{sourceIds:input.sourceIds})).jobId)
    lifetime.admit(access)
    const captured=structuredClone(lifetime.config)
    return lifetime.operation(access,async (signal,check)=>{
      await store.open(captured.maxDiskBytes);check()
      const state=store.status(),reasons=new Set(state.reasons),hits:CodeHit[]=[]
      let mode:CodeSearchResult['mode']='lexical'
      let candidates=store.candidates(input.query,input.sourceIds,prefix)
      if(captured.mode==='hybrid') {
        const model=modelIdentity(captured.embedding!)
        if(state.model!==model)reasons.add('embedding-index-rebuild-required')
        else {
          const [vector]=await embed([input.query],captured.embedding!,options,signal,telemetry.usage);check()
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
      const revalidation=createRevalidation(options,access,signal,check,reasons)
      const {validated,fileKey,validate}=revalidation
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
      revalidation.addDiagnostics(result)
      boundedReasons()
      while(Buffer.byteLength(JSON.stringify(result))>maxBytes&&hits.length){hits.pop();reasons.add('result-budget');boundedReasons()}
      check()
      telemetry.setSourceHealth(revalidation.health(state.generation))
      return result
    })
  }
  return search
}
