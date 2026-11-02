import {aggregateUsage,validateUsageQuery,configuredUsageCost} from './aggregate.js'
import {reduceUsageObservations} from './observation-reducer.js'
import type {ObservationEntity,ObservationSend} from './observation-projection-types.js'
import type {ObservationQuery,ObservationSummary,UsagePopulation,UsageSnapshotV2,ObservationGroup} from './observation-snapshot-types.js'
import {decodeUsageSnapshotV2} from './observation-snapshot-decode.js'
const fields=['start','end','timeZone','workspace','projectId','providerId','modelId','page','pageSize','sort','route']
export function validateObservationQuery(value:unknown):ObservationQuery{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!fields.includes(k)))throw Error('Invalid observation query')
 const route=(value as Record<string,unknown>).route
 if(route!==undefined&&route!=='unknown')throw Error('Invalid observation route filter')
 return {...validateUsageQuery(value),...(route?{route}:{})}
}
const actionKey=(value:{ownerSessionId:string;actionId:string})=>JSON.stringify([value.ownerSessionId,value.actionId])
function routeMatches(value:{workspace?:string;projectId?:string;providerId?:string;modelId?:string},query:ObservationQuery){
 if(query.route==='unknown'&&value.providerId!==undefined&&value.modelId!==undefined)return false
 return (['workspace','projectId','providerId','modelId'] as const).every(key=>query[key]===undefined||query[key]===value[key])
}
const hasFilter=(q:ObservationQuery)=>q.route!==undefined||(['workspace','projectId','providerId','modelId'] as const).some(k=>q[k]!==undefined)
function safeSubtotal(values:(number|null|undefined)[]):number|null{const present=values.filter((n):n is number=>n!==null&&n!==undefined);if(!present.length)return null;const total=present.reduce((a,b)=>a+b,0);return Number.isSafeInteger(total)?total:null}
function costTotals(sends:ObservationSend[]){const priced=sends.filter(s=>s.costCoverage==='priced'),total=priced.reduce((n,s)=>n+s.estimatedCostUsd!,0);return {pricedApiSends:priced.length,unpricedApiSends:sends.filter(s=>s.billing==='api'&&s.costCoverage!=='priced').length,measuredEstimatedCostUsd:priced.length&&Number.isFinite(total)?total:null}}
function summarize(rows:ObservationEntity[],legacyInvocations=0):ObservationSummary{
 const sends=rows.filter(r=>r.kind==='send').map(r=>r.value)
 const cache=sends.filter(s=>s.totalInputTokens!==null&&s.cacheReadTokens!==undefined),read=safeSubtotal(cache.map(s=>s.cacheReadTokens)),input=safeSubtotal(cache.map(s=>s.totalInputTokens))
 return {...costTotals(sends),logicalActions:rows.filter(r=>r.kind==='action').length,transportHandoffs:sends.length,localInvocations:rows.filter(r=>r.kind==='local').length,unknownReservations:rows.filter(r=>r.kind==='unknown-reservation').length,knownUnsentCandidates:rows.filter(r=>r.kind==='known-unsent').length,unknownUsage:rows.filter(r=>r.kind==='unmatched-update').length,unattributedInvocations:rows.filter(r=>r.kind==='unattributed').length,legacyInvocations,measuredSends:sends.filter(s=>s.totalTokens!==null).length,unavailableSends:sends.filter(s=>s.coverage!=='complete').length,measuredInputSubtotal:safeSubtotal(sends.map(s=>s.totalInputTokens)),measuredOutputSubtotal:safeSubtotal(sends.map(s=>s.outputTokens)),measuredTokenSubtotal:safeSubtotal(sends.map(s=>s.totalTokens)),cacheHitRate:read!==null&&input!==null&&input>0?read/input:null}
}
function groups(sends:ObservationSend[],field:'modelId'|'providerId'):ObservationGroup[]{
 const result=new Map<string,ObservationSend[]>()
 for(const send of sends){const key=send[field]===undefined?'unknown':JSON.stringify([send.providerId??null,send[field]]),values=result.get(key)??[];values.push(send);result.set(key,values)}
 return [...result].sort(([a],[b])=>a.localeCompare(b)).map(([key,values])=>({...costTotals(values),key,label:values[0]![field]??'Unknown route',transportHandoffs:values.length,measuredSends:values.filter(s=>s.totalTokens!==null).length,unavailableSends:values.filter(s=>s.coverage!=='complete').length,measuredTokenSubtotal:safeSubtotal(values.map(s=>s.totalTokens))}))
}
/** Reads complete populations; no IO, projection callbacks or mutation authority. */
export function queryUsageObservations(population:UsagePopulation,input:ObservationQuery,recordingMode:'legacy'|'observations'):UsageSnapshotV2{
 const query=validateObservationQuery(input),fold=reduceUsageObservations(population.observations,{start:0,end:Number.MAX_SAFE_INTEGER},population.legacyRecords)
 const warningsForCost:string[]=[]
 for(const send of fold.sends){const price=population.prices.find(p=>p.providerId===send.providerId&&p.modelId===send.modelId);send.estimatedCostUsd=send.coverage==='complete'?configuredUsageCost(send,price,send.uncachedInputTokens,warningsForCost):null;send.costCoverage=send.billing==='subscription'?'subscription-no-api-cost':send.estimatedCostUsd!==null?'priced':send.billing==='api'?'unpriced':'unavailable'}
 const completeSends=fold.sends,linked=new Map<string,ObservationSend[]>()
 for(const send of completeSends){const key=actionKey(send),values=linked.get(key)??[];values.push(send);linked.set(key,values)}
 const all=fold.entities.filter(row=>{
  if(!hasFilter(query))return true
  if(row.kind==='send'||row.kind==='unattributed')return routeMatches(row.value,query)
  const routes=linked.get(actionKey(row.value))??[]
  return routes.length?routes.some(route=>routeMatches(route,query)):routeMatches({},query)
 })
 const filtered=all.filter(row=>row.at>=query.start&&row.at<query.end)
 const legacy=aggregateUsage(population.legacyRecords,query,population.prices,population.warnings)
 const summary=summarize(filtered,legacy.totalRecords),sends=filtered.filter(r=>r.kind==='send').map(r=>r.value)
 const warnings=[...new Set([...population.warnings,...fold.warnings,...warningsForCost,...(recordingMode==='legacy'?['Observation recording is not enabled; only previously recorded observations are shown.']:[]),'Usage is a point-in-time read; missing observations and active writes may make coverage incomplete.'])]
 if(population.observationNamespace==='absent')warnings.push('Observation storage is absent; action and send coverage is unavailable.')
 const date=new Intl.DateTimeFormat('en-CA',{timeZone:query.timeZone,year:'numeric',month:'2-digit',day:'2-digit'})
 const days=new Map<string,ObservationEntity[]>()
 for(const row of filtered){const parts=date.formatToParts(row.at),key=['year','month','day'].map(k=>parts.find(p=>p.type===k)!.value).join('-'),values=days.get(key)??[];values.push(row);days.set(key,values)}
 const sorted=[...filtered].sort((a,b)=>query.sort==='tokens'?((b.kind==='send'?b.value.totalTokens??-1:-1)-(a.kind==='send'?a.value.totalTokens??-1:-1))||a.key.localeCompare(b.key):(query.sort==='oldest'?a.at-b.at:b.at-a.at)||a.key.localeCompare(b.key))
 const page=query.page!,pageSize=query.pageSize!,options={workspaces:[] as string[],projects:[] as string[],providers:[] as string[],models:[] as string[]}
 for(const [key,field] of [['workspaces','workspace'],['projects','projectId'],['providers','providerId'],['models','modelId']] as const)options[key]=[...new Set([...completeSends.map(s=>s[field]),...population.legacyRecords.map(r=>r[field]),...fold.entities.filter(r=>r.kind==='unattributed').map(r=>r.value[field])].filter((s):s is string=>s!==undefined))].sort()
 return decodeUsageSnapshotV2({kind:'usage-observation-snapshot',version:2,query,coverage:{recordingMode,observationStorage:population.observationNamespace,status:population.observationNamespace==='absent'?'unavailable':'partial',warnings},summary,daily:[...days].sort(([a],[b])=>a.localeCompare(b)).map(([date,rows])=>({date,summary:summarize(rows)})),models:groups(sends,'modelId'),providers:groups(sends,'providerId'),rows:sorted.slice((page-1)*pageSize,page*pageSize),totalRows:filtered.length,page,pageSize,legacy,prices:population.prices,options})
}
