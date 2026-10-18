import type { CodeAccess, CodeHit, CodeRetrievalOptions, CodeSearchResult, CodeSourceValidation, CodeRetrievalStatus } from '../types.ts'

export const MAX_SOURCE_CHECKS=256
/** Per-search admission cache; every published file is independently rechecked. */
export function createRevalidation(options:CodeRetrievalOptions,access:CodeAccess,signal:AbortSignal,check:()=>void,reasons:Set<string>) {
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
  function addDiagnostics(result:CodeSearchResult) {
    if(refused.size) {
      const diagnostics=new Map<string,NonNullable<CodeSearchResult['diagnostics']>[number]>()
      for(const refusal of refused.values()) {
        const key=JSON.stringify([refusal.reason,refusal.code]),previous=diagnostics.get(key)
        if(previous)previous.count++
        else if(diagnostics.size<16)diagnostics.set(key,{reason:refusal.reason,...(refusal.code?{code:refusal.code}:{}),count:1})
      }
      result.diagnostics=[...diagnostics.values()]
    }
  }
  function health(generation:number):NonNullable<CodeRetrievalStatus['sourceHealth']> {
    const healthReasons:string[]=[...new Set([...refused.values()].map(value=>value.reason))]
    for(const reason of ['source-validation-limit','candidate-budget'])if(reasons.has(reason))healthReasons.push(reason)
    return {scope:'last-search',state:healthReasons.length?'degraded':validated.size?'current':'unchecked',generation,checkedFiles:validated.size,refusedFiles:refused.size,reasons:healthReasons,checkedAt:Date.now()}
  }
  return {validated,fileKey,validate,addDiagnostics,health}
}
