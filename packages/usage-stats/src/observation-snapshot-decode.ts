import type {UsageSnapshotV2,UsageConsumerView} from './observation-snapshot-types.js'
import type {UsageSnapshot} from './types.js'
type Check=(value:unknown)=>unknown
const fail=():never=>{throw new TypeError('Invalid usage snapshot')}
const str:Check=v=>typeof v==='string'&&v.length<=4096?v:fail()
const id:Check=v=>typeof v==='string'&&v.trim().length>0&&v.length<=4096?v:fail()
const groupKey:Check=v=>typeof v==='string'&&v.length>0&&v.length<=32768?v:fail()
const integer:Check=v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:fail()
const decimal:Check=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:fail()
const ratio:Check=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1?v:fail()
const bool:Check=v=>typeof v==='boolean'?v:fail()
const one=(...choices:unknown[]):Check=>v=>choices.includes(v)?v:fail()
const nullable=(check:Check):Check=>v=>v===null?null:check(v)
function object(required:Record<string,Check>,optional:Record<string,Check>={}):Check{return value=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return fail()
 const result:Record<string,unknown>={},descriptors=Object.getOwnPropertyDescriptors(value)
 for(const key of Reflect.ownKeys(value)){if(typeof key!=='string'||!Object.hasOwn(required,key)&&!Object.hasOwn(optional,key))return fail();const d=descriptors[key]!;if(!d.enumerable||!('value'in d)||d.value===undefined)return fail();result[key]=(required[key]??optional[key]!)(d.value)}
 for(const key of Object.keys(required))if(!Object.hasOwn(result,key))return fail()
 return result
}}
const array=(check:Check,max:number):Check=>value=>{
 if(!Array.isArray(value)||value.length>max||Reflect.ownKeys(value).length!==value.length+1)return fail()
 const result:unknown[]=[];for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!('value'in d))return fail();result.push(check(d.value))}return result
}
const strings=array(id,10000)
const origin:Check=value=>{if(!value||typeof value!=='object')return fail();const v=value as Record<string,unknown>,base={kind:id,seq:integer}
 if(['input','predecessor','command'].includes(String(v.kind)))return object({...base,kind:one(v.kind)})(value)
 if(['tool','code'].includes(String(v.kind)))return object({...base,kind:one(v.kind),parentActionId:id})(value)
 if(v.kind==='observation-input')return object({...base,kind:one('observation-input'),inputId:id})(value)
 if(v.kind==='delegated-input')return object({...base,kind:one('delegated-input'),ref:one(v.ref),...(v.ref==='admitted'?{inputId:id}:v.ref==='inbox'?{messageId:id}:fail())})(value)
 return fail()
}
const attribution={providerId:id,modelId:id,workspace:id,billing:one('api','subscription','unknown')},optionalAttribution={projectId:id}
const counters={inputTokens:integer,outputTokens:integer,cacheReadTokens:integer,cacheCreationTokens:integer,inputTokenSemantics:one('includes-cache','excludes-cache')}
const identity={ownerSessionId:id,actionId:id},lane=one('main','recovery','summary','auxiliary')
const action=object({...identity,startedAt:integer,purpose:one('main','manual','approval','title','media'),origin,executionDomain:nullable(one('physical','local-test')),disposition:nullable(one('accepted','completed','failed','stopped','expired','exhausted')),durable:bool})
const send=object({...identity,attemptId:id,sendId:id,handoffAt:integer,lane,rebind:v=>Number(integer(v))<=3?v:fail(),durable:bool,disposition:nullable(one('unsent','issued','unknown','completed','failed')),totalInputTokens:nullable(integer),uncachedInputTokens:nullable(integer),totalTokens:nullable(integer),coverage:one('complete','incomplete','unavailable'),estimatedCostUsd:one(null),costCoverage:one('subscription-no-api-cost','unavailable')},{...counters,providerId:id,modelId:id,workspace:id,projectId:id,billing:attribution.billing})
const valueChecks:Record<string,Check>={action,send,local:object({...identity,localInvocationId:id,lane}),'unknown-reservation':object({...identity,attemptId:id}),'known-unsent':object({...identity,attemptId:id}),'unmatched-update':object({...identity,attemptId:id,sendId:id}),unattributed:object(attribution,optionalAttribution)}
const row:Check=value=>{if(!value||typeof value!=='object')return fail();const kind=(value as Record<string,unknown>).kind;if(typeof kind!=='string'||!Object.hasOwn(valueChecks,kind))return fail();return object({kind:one(kind),key:id,at:integer,value:valueChecks[kind]!})(value)}
const summaryFields={logicalActions:integer,transportHandoffs:integer,localInvocations:integer,unknownReservations:integer,knownUnsentCandidates:integer,unknownUsage:integer,unattributedInvocations:integer,legacyInvocations:integer,measuredSends:integer,unavailableSends:integer,measuredInputSubtotal:nullable(integer),measuredOutputSubtotal:nullable(integer),measuredTokenSubtotal:nullable(integer),cacheHitRate:nullable(ratio)}
const summary=object(summaryFields)
const price=object({providerId:id,modelId:id,inputPerMillion:decimal,outputPerMillion:decimal,source:id,updatedAt:integer},{cacheReadPerMillion:decimal,cacheCreationPerMillion:decimal})
const options=object({workspaces:strings,projects:strings,providers:strings,models:strings})
const totalsFields={requests:integer,completed:integer,failed:integer,cancelled:integer,inputTokens:nullable(integer),uncachedInputTokens:nullable(integer),outputTokens:nullable(integer),cacheReadTokens:nullable(integer),cacheCreationTokens:nullable(integer),totalTokens:nullable(integer),cacheHitRate:nullable(ratio),measuredRequests:integer,cacheMeasuredRequests:integer,estimatedCostUsd:nullable(decimal),pricedRequests:integer,subscriptionRequests:integer}
const chartTokens=nullable(object({uncachedInputTokens:integer,cacheReadTokens:integer,cacheCreationTokens:integer,outputTokens:integer,unclassifiedTokens:integer}))
const legacyGroup=object({...totalsFields,key:id,label:str},{chartTokens})
// Request metrics stay host diagnostics in V2; a legacy response may carry them.
// Validate their closed scalar structure without importing the Node host validator.
const requestMetrics=object({version:one(1),coverage:one('complete','neutral-only','incomplete'),sizeKind:one('http-json-body','sdk-command-estimate','neutral-envelope-estimate'),inlineBinaryBytes:integer,cacheMetadataBytes:integer,signatureBytes:integer,systemTokens:integer,schemaTokens:integer,reasoningTokens:integer,imageCount:integer,capSupport:one('supported','unsupported','unknown'),minimumOutputCap:integer},{bodyBytes:integer,sdkCommandBytesEstimate:integer,configuredOutputCap:integer,effectiveOutputCap:integer,reasoningBudget:integer})
const legacyRow=object({id:id,startedAt:integer,durationMs:decimal,...attribution,status:one('completed','failed','cancelled'),totalInputTokens:nullable(integer),uncachedInputTokens:nullable(integer),totalTokens:nullable(integer),estimatedCostUsd:nullable(decimal)},{...counters,...optionalAttribution,sessionId:id,firstTokenMs:decimal,price,requestMetrics})
const legacy=object({generatedAt:integer,summary:object(totalsFields,{chartTokens}),daily:array(object({...totalsFields,date:id},{chartTokens}),367),models:array(legacyGroup,10000),providers:array(legacyGroup,10000),records:array(legacyRow,200),totalRecords:integer,page:integer,pageSize:integer,options,prices:array(price,10000),warnings:array(str,256)},{recordingSince:integer})
const query=object({start:integer,end:integer,timeZone:id,page:integer,pageSize:integer,sort:one('newest','oldest','tokens')},{workspace:id,projectId:id,providerId:id,modelId:id,route:one('unknown')})
const group=object({key:groupKey,label:id,transportHandoffs:integer,measuredSends:integer,unavailableSends:integer,measuredTokenSubtotal:nullable(integer)})
const snapshot=object({kind:one('usage-observation-snapshot'),version:one(2),query,coverage:object({recordingMode:one('legacy','observations'),observationStorage:one('absent','present'),status:one('partial','unavailable'),warnings:array(str,256)}),summary,daily:array(object({date:id,summary}),367),models:array(group,10000),providers:array(group,10000),rows:array(row,200),totalRows:integer,page:integer,pageSize:integer,legacy,prices:array(price,10000),options})
export function decodeUsageSnapshotV2(value:unknown):UsageSnapshotV2{
 const result=snapshot(value) as UsageSnapshotV2
 if(result.query.end<=result.query.start||result.page<1||result.page>1000000||result.pageSize<1||result.pageSize>200||result.query.page!==result.page||result.query.pageSize!==result.pageSize||result.rows.length>result.pageSize||result.rows.length>result.totalRows||new Set(result.rows.map(r=>r.key)).size!==result.rows.length)fail()
 if(result.summary.measuredSends>result.summary.transportHandoffs||result.summary.unavailableSends>result.summary.transportHandoffs)fail()
 if(result.rows.length!==Math.max(0,Math.min(result.pageSize,result.totalRows-(result.page-1)*result.pageSize)))fail()
 if((result.coverage.observationStorage==='absent')!==(result.coverage.status==='unavailable'))fail()
 if(result.query.end-result.query.start>366*86400000||!Number.isFinite(new Date(result.query.end).getTime())||/^[+-]/.test(result.query.timeZone))fail()
 try{new Intl.DateTimeFormat('en',{timeZone:result.query.timeZone}).format(result.query.start)}catch{fail()}
 for(const row of result.rows){if(row.kind==='action'&&(row.at!==row.value.startedAt||row.key!==JSON.stringify(['action',row.value.ownerSessionId,row.value.actionId])))fail();if(row.kind==='send'&&(row.at!==row.value.handoffAt||row.key!==JSON.stringify(['send',row.value.ownerSessionId,row.value.actionId,row.value.attemptId,row.value.sendId])))fail();if((row.kind==='unknown-reservation'||row.kind==='known-unsent')&&row.key!==JSON.stringify(['reservation',row.value.ownerSessionId,row.value.actionId,row.value.attemptId]))fail();if(row.kind==='local'&&row.key!==JSON.stringify(['local',row.value.ownerSessionId,row.value.actionId,row.value.localInvocationId]))fail()}
 for(const row of result.rows)if(row.kind==='send'){
  const send=row.value
  if((send.billing==='subscription')!==(send.costCoverage==='subscription-no-api-cost'))fail()
  if(send.coverage==='complete'&&send.totalTokens===null)fail()
  if(send.totalTokens!==null&&(send.totalInputTokens===null||send.outputTokens===undefined||send.totalInputTokens+send.outputTokens!==send.totalTokens))fail()
 }
 return result
}
/** Explicitly legacy; never a V2 fallback after an advertised V2 response fails. */
export function decodeLegacyUsageView(value:unknown):UsageConsumerView{
 const result=legacy(value) as UsageSnapshot
 if(result.page<1||result.pageSize<1||result.pageSize>200||result.records.length>result.pageSize||result.records.length>result.totalRecords)fail()
 return {kind:'legacy-only',snapshot:result,warnings:['Older usage records; action and send counts unavailable.',...result.warnings]}
}
