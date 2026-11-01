import {decodeUsageSnapshotV2,decodeLegacyUsageView,type UsageConsumerView} from '@i-harness/usage-stats/observation-snapshot'
import type {ObservationQuery} from '@i-harness/usage-stats/observation-snapshot'
export function matchesUsageQuery(snapshot:{query:ObservationQuery},query:ObservationQuery):boolean{return (['start','end','timeZone','workspace','projectId','providerId','modelId','page','pageSize','sort','route'] as const).every(key=>snapshot.query[key]===query[key])}
export function plainUsageWarning(value:string,t:(zh:string,en:string)=>string):string{
 if(/authority|journal|fact|coordinate|reservation|incarnation|reconcil/i.test(value))return t('部分記錄無法可靠配對；用量可能不完整。','Some records could not be matched reliably; usage may be incomplete.')
 if(/observation.*not enabled/i.test(value))return t('動作與傳送記錄尚未啟用。','Action and send recording is not enabled.')
 if(/observation storage is absent/i.test(value))return t('動作與傳送歷史記錄未提供。','Action and send history is unavailable.')
 if(/point-in-time/i.test(value))return t('活動仍在進行或記錄缺漏時，用量可能不完整。','Usage may be incomplete while activity is running or records are missing.')
 return value
}
/** Main supplies a negotiated view. Raw snapshots are explicit legacy embedder input only. */
export function decodeUsageConsumerView(value:unknown):UsageConsumerView{
 if(value&&typeof value==='object'&&'kind'in value){
  const view=value as Record<string,unknown>
  if(view.kind==='observations'&&Object.keys(view).length===2&&Object.hasOwn(view,'snapshot'))return {kind:'observations',snapshot:decodeUsageSnapshotV2(view.snapshot)}
  if(view.kind==='legacy-only'&&Object.keys(view).length===3&&Array.isArray(view.warnings)&&view.warnings.length<=256&&view.warnings.every(w=>typeof w==='string'&&w.length<=4096)){
   const result=decodeLegacyUsageView(view.snapshot);if(result.kind==='legacy-only')result.warnings=[...new Set([...result.warnings,...view.warnings])];return result
  }
  throw Error('Unsupported usage response')
 }
 return decodeLegacyUsageView(value)
}
