import {expect,it} from 'vitest'
import {reduceUsageObservations} from '../src/observation-reducer.js'
import {queryUsageObservations} from '../src/observation-query.js'
import type {UsageObservationV1} from '../src/observation-types.js'
import {decodeUsageSnapshotV2} from '../src/observation-snapshot-decode.js'
it('retains reported unattributed usage separately through the closed browser projection without inventing sends',()=>{
 const row:UsageObservationV1={kind:'usage-observation',version:1,source:'live-owner',observationId:'aux',observedAt:5,observation:{type:'unattributed-invocation',providerId:'aux-provider',modelId:'aux-model',workspace:'w',projectId:'project',billing:'api',inputTokens:8,outputTokens:3,inputTokenSemantics:'includes-cache',validity:'valid',terminalCoverage:'partial'}}
 const fold=reduceUsageObservations([row,row],{start:0,end:10})
 expect(fold.totals).toMatchObject({logicalActions:0,transportHandoffs:0,unattributedInvocations:1,measuredSends:0})
 const result=queryUsageObservations({observations:[row,row],legacyRecords:[],prices:[],warnings:[],observationNamespace:'present'},{start:0,end:10,timeZone:'UTC'},'observations')
 expect(result.rows).toHaveLength(1);expect(result.rows[0]).toMatchObject({kind:'unattributed',value:{providerId:'aux-provider',inputTokens:8,outputTokens:3,inputTokenSemantics:'includes-cache',validity:'valid',terminalCoverage:'partial'}})
 expect(result.summary.measuredTokenSubtotal).toBeNull();expect(result.summary.transportHandoffs).toBe(0)
 if(row.observation.type!=='unattributed-invocation')throw Error('Expected unattributed fixture')
 const {inputTokens:_input,outputTokens:_output,...unmeasured}=row.observation
 const missing=queryUsageObservations({observations:[{...row,observation:unmeasured}],legacyRecords:[],prices:[],warnings:[],observationNamespace:'present'},{start:0,end:10,timeZone:'UTC'},'observations')
 expect(missing.rows[0]).not.toHaveProperty('value.inputTokens');expect(missing.rows[0]).not.toHaveProperty('value.outputTokens')
 const invalid=structuredClone(result);Object.assign(invalid.rows[0]!.value,{outputTokens:-1});expect(()=>decodeUsageSnapshotV2(invalid)).toThrow()
 const invalidTerminal=structuredClone(result);Object.assign(invalidTerminal.rows[0]!.value,{terminalCoverage:'invented'});expect(()=>decodeUsageSnapshotV2(invalidTerminal)).toThrow()
 const copy=decodeUsageSnapshotV2(result);Object.assign(result.rows[0]!.value,{inputTokens:999});expect(copy.rows[0]).toHaveProperty('value.inputTokens',8)
})
