import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { canonicalJsonData } from '@i-harness/core-session'
import { createSelectedResultsIntent, readSelectedResultsCore } from '../src/selected-results-fork-contract.ts'
import { captureSelectedResultsRoute, selectedBootstrapPathKey } from '../src/coordinator/selected-results-route.ts'
import { bootstrapPaths } from '../../session-persistence-jsonl/src/backend/bootstrap-stage.ts'
import { childBootstrapPathKey } from '../src/coordinator/bootstrap-route.ts'
import { selectedBootstrapPaths } from '../../session-persistence-jsonl/src/backend/selected-results-route-path.ts'

function fixture() {
 const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{title:'original'},results:'selected-results-v1'})
 const {intent,requestDigest}=createSelectedResultsIntent(core,{kind:'unmanaged'})
 return {protocol:'public-results-v1',request:{invocation:{version:1,operationId:'op',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest},core,requestIntent:intent}}
}
it('captures only the closed selected route and detaches caller aliases',()=>{
 const input:any=structuredClone(fixture()), captured=captureSelectedResultsRoute(input)
 input.request.core.metadata.title='changed'
 expect(captured.request.core.metadata.title).toBe('original')
 expect(Object.isFrozen(captured)).toBe(true)
 let invoked=false; const accessor:any=fixture(); Object.defineProperty(accessor,'request',{enumerable:true,get(){invoked=true;return input.request}})
 expect(()=>captureSelectedResultsRoute(accessor)).toThrow(); expect(invoked).toBe(false)
 for(const bad of [{...fixture(),extra:true},{...fixture(),protocol:'public'}, {...fixture(),invocation:fixture().request.invocation}]) expect(()=>captureSelectedResultsRoute(bad)).toThrow()
})
it('uses the independent domain hash for all paths and separates old keys',()=>{
 const route=captureSelectedResultsRoute(fixture()), invocation=route.request.invocation
 const key=createHash('sha256').update('ih.bootstrap.selected-results.path.v1\0'+canonicalJsonData(invocation)).digest('hex')
 expect(selectedBootstrapPathKey(invocation)).toBe(key)
 const paths=selectedBootstrapPaths('target.jsonl',route)
 expect(paths).toEqual({stage:`target.jsonl.bootstrap-${key}.stage`,promote:`target.jsonl.bootstrap-${key}.promote`,publish:`target.jsonl.bootstrap-${key}.publish`})
 expect(paths.stage).not.toBe(bootstrapPaths('target.jsonl',invocation).stage)
 expect(key).not.toBe(childBootstrapPathKey(invocation))
})
