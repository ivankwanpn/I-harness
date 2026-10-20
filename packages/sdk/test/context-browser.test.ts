import { expect, it } from 'vitest'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { contextStateFromBudget, contextStateFromObservation, readSessionContextState, type RequestBudgetSnapshot, type RequestBudgetSnapshotV2 } from '@i-harness/core-session'

it('bundles the actual SDK context reader for browsers and preserves v1/v2 validation', async () => {
  const result = await build({entryPoints:[fileURLToPath(new URL('../src/context.ts',import.meta.url))],bundle:true,platform:'browser',format:'iife',globalName:'ContextReader',write:false,metafile:true,logLevel:'silent'})
  const reader = new Function(result.outputFiles[0]!.text + ';return ContextReader')() as {readSessionContextState:typeof readSessionContextState}
  const digest = 'a'.repeat(64)
  const snapshot:RequestBudgetSnapshot = {version:1,ownerSessionId:'owner',modelId:'m',protocol:'p',bindingFingerprint:digest,bindingRevision:0,projectionRevision:0,neutralFingerprint:digest,identityCoverage:'partial',estimatedInputTokens:10,admissionInputTokens:10,estimateSource:'neutral-only',coverage:'neutral-only',confidence:'estimated',roleTokens:{user:10,assistant:0,tool:0},systemTokens:0,schemaTokens:0,reasoningTokens:0,outputReserve:0,capSupport:'unknown',safetyMargin:0,admission:'fit',contextWindow:100,recoveryRequired:false,fullByProvider:false}
  const observation:RequestBudgetSnapshotV2 = {version:2,ownerSessionId:'owner',modelId:'m',protocol:'custom',bindingFingerprint:digest,bindingRevision:0,projectionRevision:0,neutralFingerprint:digest,identityCoverage:'partial',purpose:'main',estimate:{kind:'estimated',value:10,source:'neutral-only'},disposition:'admit',dimensions:[{dimension:'context',state:'pass',actual:10,limit:100}],pressure:{kind:'known',basis:'shared-context',input:10,inputBudget:100,trigger:80,target:60,hardFits:true,softNeeded:false,targetReady:true},components:{kind:'estimated',source:'projected-heuristic',user:10,assistant:0,tool:0,system:0,schema:0,reasoning:0},output:{capSupport:'unknown',minimumCap:1},recoveryRequired:false,fullByProvider:false,freshness:'current',requestContext:{version:1,semanticRevision:digest,protectionRevision:digest,branchId:digest,contextEpoch:digest,surfaceRevision:digest}}
  const v1=contextStateFromBudget({kind:'ready',snapshot}),v2=contextStateFromObservation(observation)
  const cases=[v1,v2,{...v1,snapshot:{...snapshot,outputReserve:-1}},{...v1,snapshot:{...snapshot,requestContext:{version:1,semanticRevision:digest}}},{...v1,estimatedTokens:99},{...v2,observation:{...observation,extra:'payload'}},{...v2,observation:{...observation,pressure:{...observation.pressure,hardFits:false}}},{...v2,observation:{...observation,output:{capSupport:'unknown',minimumCap:1,effectiveCap:10}}},contextStateFromObservation({...observation,freshness:'stale'}),{kind:'ready',estimatedTokens:1.5,contextWindow:100},null]
  for(const value of cases) for(const owner of ['owner','other',undefined]) expect(reader.readSessionContextState(value,owner)).toEqual(readSessionContextState(value,owner))
  expect(reader.readSessionContextState(v1,'owner').kind).toBe('ready')
  expect(reader.readSessionContextState(v2,'owner').kind).toBe('ready')
  expect(reader.readSessionContextState({...v1,snapshot:{...snapshot,outputReserve:-1}},'owner').kind).toBe('unavailable')
  expect(Object.keys(result.metafile!.inputs).some(path=>/managed\/|generation\.ts|soft-reduction\.ts/.test(path))).toBe(false)
})
