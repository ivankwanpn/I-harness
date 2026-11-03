import type { Store } from '../store.ts'
import type { CodeRetrievalStatus } from '../types.ts'
import type { ConfigurationOwner } from './configuration.ts'
import type { Indexing, IndexJobs } from './index-job.ts'

export function diagnostics(job:Indexing) {
  const now=Date.now()
  return {...job.diagnostics,elapsedMs:Math.max(0,now-job.startedAt),phaseElapsedMs:Math.max(0,now-job.phaseStartedAt)}
}
export function phase(job:Indexing,value:NonNullable<CodeRetrievalStatus['indexDiagnostics']>['phase']) {
  job.diagnostics.phase=value;job.phaseStartedAt=Date.now()
}

/** Telemetry is shared by index and search; snapshots never expose mutable state. */
export function createStatus(store:Store,lifetime:()=>Pick<ConfigurationOwner,'config'|'closed'|'stopping'|'activeJobs'>,jobs:()=>Pick<IndexJobs,'indexing'|'lastJob'|'settledDiagnostics'>) {
  let error:string|undefined,sourceHealth:CodeRetrievalStatus['sourceHealth']
  const metrics={embeddingRequests:0,embeddingCacheHits:0,reportedInputTokens:0,unreportedRequests:0}
  const usage={request(){metrics.embeddingRequests++;metrics.unreportedRequests++},reported(tokens:number){metrics.reportedInputTokens+=tokens;metrics.unreportedRequests--}}
  function status():CodeRetrievalStatus {
    const {config,closed,stopping,activeJobs}=lifetime(),{indexing,lastJob,settledDiagnostics}=jobs()
    return {enabled:config.enabled,state:closed||!config.enabled?'disabled':stopping?'stopping':indexing?'indexing':error?'error':store.status().generation?'ready':'unindexed',
      config:structuredClone(config),...store.status(),metrics:{...metrics},activeJobs,...(indexing?{jobId:indexing.jobId,progress:{...indexing.progress},indexDiagnostics:diagnostics(indexing)}:settledDiagnostics?{indexDiagnostics:{...settledDiagnostics}}:{}),...(lastJob?{lastJob:{...lastJob}}:{}),...(sourceHealth?{sourceHealth:{...sourceHealth,reasons:[...sourceHealth.reasons]}}:{}),...(error?{error}:{})}
  }
  return {status,metrics,usage,get error(){return error},setError(value:string|undefined){error=value},setSourceHealth(value:CodeRetrievalStatus['sourceHealth']){sourceHealth=value},
    reset(){error=undefined;sourceHealth=undefined}}
}
export type RetrievalTelemetry=ReturnType<typeof createStatus>
