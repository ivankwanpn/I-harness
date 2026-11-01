import { expect, it } from 'vitest'
import { reduceUsageObservations } from '../src/observation-reducer.js'
import type { UsageObservationV1 } from '../src/observation-types.js'
import {encodeUsageObservation,decodeUsageObservation} from '../src/observation-codec.js'
const digest='a'.repeat(64), other='b'.repeat(64)
const identity={ownerSessionId:'s',actionId:'a'}
const candidate={semanticId:digest,payloadId:digest,payloadKind:'http-json-body' as const}
function fact(n:number, observation:object):UsageObservationV1{return {kind:'usage-observation',version:1,observationId:'f'+n,observedAt:10+n,source:'journal-fact',observation:{...identity,factSeq:n,...observation}} as UsageObservationV1}
function live(id:string,observation:object,time=20):UsageObservationV1{return {kind:'usage-observation',version:1,observationId:id,observedAt:time,source:'live-owner',observation:{...identity,...observation}} as UsageObservationV1}
const open=fact(1,{type:'action-open',purpose:'main',origin:{kind:'input',seq:0},startedAt:1,expiresAt:100})
const bind=fact(2,{type:'action-bind',executionDomain:'physical'})
const reserve=fact(3,{type:'attempt-reserve',...candidate,attemptId:'t',ordinal:1,lane:'main',cause:'initial',incarnation:'i'})
const handoff=live('h',{type:'handoff',...candidate,attemptId:'t',sendId:'send',rebind:0,incarnation:'i'})
const snapshot=(ordinal:number,counters:object,time=30)=>live('u'+ordinal,{type:'usage-snapshot',attemptId:'t',sendId:'send',snapshotOrdinal:ordinal,providerId:'p',modelId:'m',workspace:'w',billing:'api',validity:'valid',terminalCoverage:'complete',...counters},time)
const query={start:0,end:100}
it('accepts closed optional original handoff attribution without fabricating usage and flags later disagreement',()=>{
 const attribution={providerId:'media-provider',modelId:'media-model',workspace:'w',billing:'api' as const}
 const attributed={...handoff,observation:{...handoff.observation,attribution}} as UsageObservationV1
 expect(decodeUsageObservation(encodeUsageObservation(attributed))).toEqual(attributed)
 expect(()=>encodeUsageObservation({...attributed,observation:{...attributed.observation,attribution:{providerId:'p'}}})).toThrow()
 expect(()=>encodeUsageObservation({...attributed,observation:{...attributed.observation,attribution:{...attribution,extra:true}}})).toThrow()
 const empty=reduceUsageObservations([open,bind,reserve,attributed],query)
 expect(empty.sends[0]).toMatchObject({providerId:'media-provider',modelId:'media-model',coverage:'unavailable',totalTokens:null});expect(empty.sends[0].inputTokens).toBeUndefined()
 expect(reduceUsageObservations([open,bind,reserve,handoff],query).sends[0].providerId).toBeUndefined()
 const conflict=reduceUsageObservations([open,bind,reserve,attributed,snapshot(1,{inputTokens:8,outputTokens:2,inputTokenSemantics:'includes-cache'})],query)
 expect(conflict.sends[0]).toMatchObject({providerId:'media-provider',coverage:'incomplete'});expect(conflict.warnings.join()).toMatch(/attribution/)
})
it('folds shuffled cumulative corrections once, keeps failed usage and separates action/handoff buckets',()=>{
 const rows=[open,bind,reserve,handoff,snapshot(1,{inputTokens:10,inputTokenSemantics:'includes-cache'}),snapshot(2,{outputTokens:3}),snapshot(3,{inputTokens:8}),fact(4,{type:'action-close',disposition:'stopped'})]
 const result=reduceUsageObservations([...rows.reverse(),handoff],query)
 expect(result.totals).toMatchObject({logicalActions:1,transportHandoffs:1,localInvocations:0})
 expect(result.sends[0]).toMatchObject({inputTokens:8,outputTokens:3,totalTokens:11,estimatedCostUsd:null})
 expect(result.actions[0].disposition).toBe('stopped')
 expect(reduceUsageObservations(rows,{start:0,end:10}).totals).toMatchObject({logicalActions:1,transportHandoffs:0})
 expect(reduceUsageObservations(rows,{start:19,end:21}).sends[0].outputTokens).toBe(3)
})
it('does not promote unmatched snapshots or conflicting IDs to known sends',()=>{
 expect(reduceUsageObservations([snapshot(1,{inputTokens:0})],query).totals).toMatchObject({transportHandoffs:0,unknownUsage:1})
 const result=reduceUsageObservations([open,bind,reserve,handoff,{...handoff,observation:{...handoff.observation,payloadId:other}} as UsageObservationV1],query)
 expect(result.totals.transportHandoffs).toBe(0);expect(result.warnings.length).toBeGreaterThan(0)
})
it('binds rebind incarnation and candidate, requires complete rebind chain',()=>{
 const unsent=fact(4,{type:'attempt-settle',attemptId:'t',disposition:'unsent'})
 const rebind=fact(5,{type:'attempt-rebind',...candidate,payloadId:other,attemptId:'t',rebind:1,incarnation:'i'})
 const sent=live('h2',{type:'handoff',...candidate,payloadId:other,attemptId:'t',sendId:'send',rebind:1,incarnation:'i'})
 const issued=fact(6,{type:'attempt-settle',attemptId:'t',disposition:'issued',sendId:'send'})
 const complete=fact(7,{type:'attempt-settle',attemptId:'t',disposition:'completed',sendId:'send'})
 expect(reduceUsageObservations([sent,reserve,bind,open,rebind,unsent,issued,complete,snapshot(1,{inputTokens:8,outputTokens:3,inputTokenSemantics:'includes-cache'})],query).sends[0]).toMatchObject({disposition:'completed',rebind:1,totalTokens:11})
 expect(reduceUsageObservations([sent,reserve,bind,open,rebind],query).totals.transportHandoffs).toBe(0)
 expect(reduceUsageObservations([sent,reserve,bind,open,unsent,{...rebind,observation:{...rebind.observation,incarnation:'wrong'}} as UsageObservationV1],query).totals.transportHandoffs).toBe(0)
 expect(reduceUsageObservations([sent,reserve,bind,open],query).totals.transportHandoffs).toBe(0)
})
it('rejects cross-action owner journal coordinates',()=>{
 const second=[open,bind,reserve,handoff].map(row=>({...row,observationId:'second'+row.observationId,observation:{...row.observation,actionId:'other'}} as UsageObservationV1))
 expect(reduceUsageObservations([open,bind,reserve,handoff,...second],query).totals.logicalActions).toBe(0)
})
it('rejects conflicting original time at one journal coordinate',()=>{
 expect(reduceUsageObservations([open,{...open,observationId:'different-time',observedAt:99},bind,reserve,handoff],query).totals.logicalActions).toBe(0)
})
it('deduplicates missing-reservation associations',()=>{
 expect(reduceUsageObservations([handoff,{...handoff,observationId:'replay'}],query).totals.unknownReservations).toBe(1)
})
it('detects a missing partial cumulative update that could contain a downward correction',()=>{
 const result=reduceUsageObservations([open,bind,reserve,handoff,snapshot(1,{inputTokens:10,outputTokens:1,inputTokenSemantics:'includes-cache'}),snapshot(3,{outputTokens:3})],query)
 expect(result.sends[0]).toMatchObject({inputTokens:10,outputTokens:3,coverage:'incomplete'})
})
it('refuses contradictory terminal facts instead of selecting the latest disposition',()=>{
 const done=fact(4,{type:'attempt-settle',attemptId:'t',disposition:'completed',sendId:'send'})
 const failed=fact(5,{type:'attempt-settle',attemptId:'t',disposition:'failed',sendId:'send'})
 expect(reduceUsageObservations([open,bind,reserve,handoff,done,failed],query).totals.transportHandoffs).toBe(0)
})
it('retains measured Stop usage when the original issued reservation settles after action close',()=>{
 const stopped=fact(4,{type:'action-close',disposition:'stopped'})
 const late=fact(5,{type:'attempt-settle',attemptId:'t',disposition:'unknown',sendId:'send'})
 const result=reduceUsageObservations([open,bind,reserve,handoff,snapshot(1,{inputTokens:8,outputTokens:3,inputTokenSemantics:'includes-cache',terminalCoverage:'partial'},22),stopped,late],query)
 expect(result.actions[0].disposition).toBe('stopped')
 expect(result.sends[0]).toMatchObject({disposition:'unknown',totalTokens:11,coverage:'incomplete'})
 expect(result.totals).toMatchObject({transportHandoffs:1,measuredTokenSubtotal:11})
})
it('still refuses a new rebind after action close while allowing original settlement drainage',()=>{
 const unsent=fact(4,{type:'attempt-settle',attemptId:'t',disposition:'unsent'})
 const stopped=fact(5,{type:'action-close',disposition:'stopped'})
 const rebind=fact(6,{type:'attempt-rebind',...candidate,attemptId:'t',rebind:1,incarnation:'i'})
 const sent=live('h-after',{type:'handoff',...candidate,attemptId:'t',sendId:'send',rebind:1,incarnation:'i'})
 expect(reduceUsageObservations([open,bind,reserve,unsent,stopped,rebind,sent],query).totals.transportHandoffs).toBe(0)
})
it('uses known includes-cache denominator without inventing absent creation tokens',()=>{
 const result=reduceUsageObservations([open,bind,reserve,handoff,snapshot(1,{inputTokens:100,outputTokens:10,cacheReadTokens:25,inputTokenSemantics:'includes-cache'})],query)
 expect(result.totals.cacheHitRate).toBe(0.25);expect(result.sends[0].cacheCreationTokens).toBeUndefined();expect(result.sends[0].uncachedInputTokens).toBeNull()
})
it('keeps absent counters distinct from zero, rejects inconsistent cache and invalid updates',()=>{
 const base=[open,bind,reserve,handoff]
 expect(reduceUsageObservations([...base,snapshot(1,{inputTokens:0,outputTokens:0,inputTokenSemantics:'excludes-cache'})],query).sends[0].totalTokens).toBeNull()
 expect(reduceUsageObservations([...base,snapshot(1,{inputTokens:8,outputTokens:3,cacheReadTokens:2,cacheCreationTokens:1,inputTokenSemantics:'excludes-cache'})],query).sends[0].totalTokens).toBe(14)
 const invalid=reduceUsageObservations([...base,snapshot(1,{inputTokens:8,outputTokens:3,inputTokenSemantics:'includes-cache'}),snapshot(2,{validity:'invalid',inputTokens:2})],query)
 expect(invalid.sends[0]).toMatchObject({inputTokens:8,coverage:'incomplete'});expect(invalid.warnings.length).toBeGreaterThan(0)
})
it('separates local and legacy observations without physical inference or dual summing',()=>{
 const local=fact(3,{type:'local-invocation',localInvocationId:'l',ordinal:1,lane:'main',incarnation:'i'})
 const result=reduceUsageObservations([open,fact(2,{type:'action-bind',executionDomain:'local-test'}),local],query,[{id:'legacy',startedAt:2,durationMs:1,workspace:'w',providerId:'p',modelId:'m',billing:'subscription',status:'failed'}])
 expect(result.totals).toMatchObject({logicalActions:1,localInvocations:1,transportHandoffs:0,legacyInvocations:1})
})
it('invalidates both sides of send identity collisions independent of order',()=>{
 const otherReserve=fact(4,{type:'attempt-reserve',...candidate,attemptId:'t2',ordinal:2,lane:'recovery',cause:'retry',incarnation:'i2'})
 const otherHandoff=live('h2',{type:'handoff',...candidate,attemptId:'t2',sendId:'send',rebind:0,incarnation:'i2'})
 const rows=[open,bind,reserve,handoff,otherReserve,otherHandoff]
 expect(reduceUsageObservations(rows,query).totals.transportHandoffs).toBe(0)
 expect(reduceUsageObservations(rows.reverse(),query).totals.transportHandoffs).toBe(0)
})
it('keeps conflicting usage ordinal uncertain and does not accept contradictory local ordinals',()=>{
 const row=snapshot(1,{inputTokens:8,outputTokens:2,inputTokenSemantics:'includes-cache'})
 const result=reduceUsageObservations([open,bind,reserve,handoff,row,{...row,observationId:'conflict',observation:{...row.observation,inputTokens:9}} as UsageObservationV1],query)
 expect(result.sends[0].coverage).toBe('unavailable');expect(result.warnings.length).toBeGreaterThan(0)
 const local=fact(3,{type:'local-invocation',localInvocationId:'l',ordinal:1,lane:'main',incarnation:'i'})
 const otherLocal=fact(4,{type:'local-invocation',localInvocationId:'l2',ordinal:1,lane:'main',incarnation:'i2'})
 expect(reduceUsageObservations([open,fact(2,{type:'action-bind',executionDomain:'local-test'}),local,otherLocal],query).totals.localInvocations).toBe(0)
})
it('keeps known unsent, unknown reservation and memory provenance distinct; no subscription invoice',()=>{
 expect(reduceUsageObservations([open,bind,reserve,fact(4,{type:'attempt-settle',attemptId:'t',disposition:'unsent'})],query).totals).toMatchObject({knownUnsentCandidates:1,unknownReservations:0,transportHandoffs:0})
 expect(reduceUsageObservations([open,bind,reserve],query).totals.unknownReservations).toBe(1)
 const measured=snapshot(1,{inputTokens:8,outputTokens:2,cacheReadTokens:2,cacheCreationTokens:1,inputTokenSemantics:'includes-cache',billing:'subscription'})
 const result=reduceUsageObservations([{...open,source:'memory-committed'},bind,reserve,handoff,measured],query)
 expect(result.actions[0].durable).toBe(false)
 expect(result.sends[0]).toMatchObject({durable:false,totalInputTokens:8,uncachedInputTokens:5,totalTokens:10,costCoverage:'subscription-no-api-cost',estimatedCostUsd:null})
 expect(result.totals.cacheHitRate).toBe(0.25)
})
it('keeps unsafe total unavailable and invalid cache changes incomplete without losing measured prior usage',()=>{
 const base=[open,bind,reserve,handoff]
 const overflow=reduceUsageObservations([...base,snapshot(1,{inputTokens:Number.MAX_SAFE_INTEGER,outputTokens:1,inputTokenSemantics:'includes-cache'})],query)
 expect(overflow.sends[0].totalTokens).toBeNull();expect(overflow.sends[0].coverage).toBe('incomplete')
 const invalid=reduceUsageObservations([...base,snapshot(1,{inputTokens:8,outputTokens:2,cacheReadTokens:2,cacheCreationTokens:1,inputTokenSemantics:'includes-cache'}),snapshot(2,{inputTokens:1})],query)
 expect(invalid.sends[0]).toMatchObject({inputTokens:8,coverage:'incomplete'})
 expect(invalid.warnings.length).toBeGreaterThan(0)
})
