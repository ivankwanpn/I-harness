import {expect,it} from 'vitest'
import {queryUsageObservations} from '../src/observation-query.js'
import {decodeUsageSnapshotV2,decodeLegacyUsageView} from '../src/observation-snapshot-decode.js'
import type {UsageObservationV1} from '../src/observation-types.js'
import {observations} from './fixtures/observation-query.js'
const population={observations,legacyRecords:[],prices:[],warnings:[],observationNamespace:'present' as const}
it('folds terminal outside range before date/model filtering and keeps pagination outside totals',()=>{
 const result=queryUsageObservations(population,{start:0,end:20,timeZone:'UTC',modelId:'child-model'},'legacy')
 expect(result.summary).toMatchObject({logicalActions:1,transportHandoffs:1,measuredTokenSubtotal:11,legacyInvocations:0})
 expect(result.coverage).toMatchObject({recordingMode:'legacy',status:'partial'});expect(result.coverage.warnings.join()).toMatch(/not enabled/)
 const decoded=decodeUsageSnapshotV2(result);expect(decoded).toEqual(result)
 expect(queryUsageObservations(population,{start:0,end:20,timeZone:'UTC',pageSize:1},'legacy').summary).toEqual(result.summary)
 const early=queryUsageObservations(population,{start:0,end:5,timeZone:'UTC',modelId:'child-model'},'legacy');expect(early.summary).toMatchObject({logicalActions:1,transportHandoffs:0,measuredTokenSubtotal:null});expect(early.options.models).toContain('child-model')
 expect(decodeLegacyUsageView(result.legacy).kind).toBe('legacy-only')
 const send=result.rows.find(row=>row.kind==='send');expect(send?.kind==='send'&&send.value.modelId).toBe('child-model')
})
it('keeps local, unresolved, known-unsent and unmatched updates separate from sends',()=>{
 const clone=(owner:string)=>observations.slice(0,3).map(r=>({...r,observationId:owner+r.observationId,observation:{...r.observation,ownerSessionId:owner}} as UsageObservationV1))
 const unsent=clone('unsent'),unknown=clone('unknown'),local=clone('local').slice(0,2)
 local[1]={...local[1]!,observation:{...local[1]!.observation,executionDomain:'local-test'}} as UsageObservationV1
 const fact=(owner:string,payload:object)=>({kind:'usage-observation',version:1,source:'journal-fact',observedAt:9,observationId:owner+'extra',observation:{ownerSessionId:owner,actionId:'a',...payload}} as UsageObservationV1)
 const rows=[...observations,...unsent,fact('unsent',{type:'attempt-settle',factSeq:4,attemptId:'t',disposition:'unsent'}),...unknown,...local,fact('local',{type:'local-invocation',factSeq:3,localInvocationId:'l',ordinal:1,lane:'main',incarnation:'i'}),{...observations.at(-1)!,observationId:'unmatched',observedAt:12,observation:{...observations.at(-1)!.observation,ownerSessionId:'unmatched'}} as UsageObservationV1]
 const result=queryUsageObservations({...population,observations:rows},{start:0,end:20,timeZone:'UTC'},'legacy')
 expect(result.summary).toMatchObject({logicalActions:4,transportHandoffs:1,localInvocations:1,knownUnsentCandidates:1,unknownReservations:1,unknownUsage:1})
 expect(new Set(result.rows.map(row=>row.kind))).toEqual(new Set(['action','send','local','known-unsent','unknown-reservation','unmatched-update']))
 const filtered=queryUsageObservations({...population,observations:rows},{start:0,end:20,timeZone:'UTC',route:'unknown'},'legacy')
 expect(filtered.summary).toMatchObject({transportHandoffs:0,localInvocations:1,knownUnsentCandidates:1})
})
it('decoder rejects hostile extra/version/numbers and detaches valid input',()=>{
 const value=queryUsageObservations(population,{start:0,end:20,timeZone:'UTC'},'legacy')
 expect(()=>decodeUsageSnapshotV2({...value,version:3})).toThrow();expect(()=>decodeUsageSnapshotV2({...value,hostile:true})).toThrow()
 expect(()=>decodeUsageSnapshotV2({...value,summary:{...value.summary,logicalActions:NaN}})).toThrow()
 expect(()=>decodeUsageSnapshotV2({...value,rows:Array(1)})).toThrow()
 expect(()=>decodeUsageSnapshotV2({...value,totalRows:99})).toThrow()
 expect(()=>decodeUsageSnapshotV2({...value,rows:value.rows.map(row=>row.kind==='send'?{...row,value:{...row.value,costCoverage:'subscription-no-api-cost'}}:row)})).toThrow()
 const copy=decodeUsageSnapshotV2(value);value.coverage.warnings.push('mutated');expect(copy.coverage.warnings).not.toContain('mutated')
})
