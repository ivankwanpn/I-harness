import {expect,it} from 'vitest'
import {queryUsageObservations} from '../src/observation-query.js'
import {observations} from './fixtures/observation-query.js'
it('prices the final reduced API send once with explicit zero cache buckets',()=>{
 const rows=structuredClone(observations)
 const update=rows.find(r=>r.observation.type==='usage-snapshot')!
 if(update.observation.type==='usage-snapshot')Object.assign(update.observation,{inputTokens:8,outputTokens:3,cacheReadTokens:0,cacheCreationTokens:0,inputTokenSemantics:'includes-cache'})
 const result=queryUsageObservations({observations:rows,legacyRecords:[],prices:[{providerId:'child-provider',modelId:'child-model',inputPerMillion:1,outputPerMillion:2,source:'fixture',updatedAt:1}],warnings:[],observationNamespace:'present'},{start:0,end:300,timeZone:'UTC'},'legacy')
 const send=result.rows.find(r=>r.kind==='send')!
 expect(send.kind==='send'&&send.value.estimatedCostUsd).toBe(0.000014)
 expect(result.summary).toMatchObject({pricedApiSends:1,unpricedApiSends:0,measuredEstimatedCostUsd:0.000014})
})

it.each([
 [{cacheReadTokens:undefined},null],
 [{cacheReadTokens:1},null],
 [{billing:'subscription'},null],
 [{billing:'unknown'},null],
 [{inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheCreationTokens:0},0],
 [{inputTokens:8,outputTokens:3,cacheReadTokens:0,cacheCreationTokens:0,inputTokenSemantics:'excludes-cache'},0.000014],
])('keeps incomplete/subscription/unknown distinct from explicit free usage (%j)',(change,expected)=>{
 const rows=structuredClone(observations),update=rows.find(r=>r.observation.type==='usage-snapshot')!
 Object.assign(update.observation,{cacheReadTokens:0,cacheCreationTokens:0},change)
 for(const key of Object.keys(update.observation))if((update.observation as any)[key]===undefined)delete (update.observation as any)[key]
 if('billing'in change){const handoff=rows.find(r=>r.observation.type==='handoff')!;if(handoff.observation.type==='handoff')handoff.observation.attribution!.billing=change.billing as any}
 const before=JSON.stringify(rows),result=queryUsageObservations({observations:rows,legacyRecords:[],prices:[{providerId:'child-provider',modelId:'child-model',inputPerMillion:1,outputPerMillion:2,source:'fixture',updatedAt:1}],warnings:[],observationNamespace:'present'},{start:0,end:300,timeZone:'UTC'},'legacy')
 expect(result.rows.find(r=>r.kind==='send')?.value).toMatchObject({estimatedCostUsd:expected});expect(JSON.stringify(rows)).toBe(before)
})
it('uses latest cumulative correction once, including failed usage and separate older cohort',()=>{
 const rows=structuredClone(observations),first=rows.find(r=>r.observation.type==='usage-snapshot')!
 Object.assign(first.observation,{inputTokens:100,outputTokens:30,cacheReadTokens:2,cacheCreationTokens:1})
 const last=structuredClone(first);last.observationId='correction';last.observedAt=201;Object.assign(last.observation,{snapshotOrdinal:2,inputTokens:8,outputTokens:3,cacheReadTokens:2,cacheCreationTokens:1});rows.push(last)
 const result=queryUsageObservations({observations:rows,legacyRecords:[],prices:[{providerId:'child-provider',modelId:'child-model',inputPerMillion:1,outputPerMillion:2,cacheReadPerMillion:0.5,cacheCreationPerMillion:3,source:'fixture',updatedAt:1}],warnings:[],observationNamespace:'present'},{start:0,end:300,timeZone:'UTC'},'legacy')
 expect(result.summary).toMatchObject({pricedApiSends:1,measuredEstimatedCostUsd:0.000015});expect(result.daily[0]!.summary.measuredEstimatedCostUsd).toBe(0.000015);expect(result.models[0]!.measuredEstimatedCostUsd).toBe(0.000015);expect(result.legacy.totalRecords).toBe(0)
})
