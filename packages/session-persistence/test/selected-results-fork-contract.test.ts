import { expect, it } from 'vitest'
import { readSelectedResultsPrepareRequest } from '../src/selected-results-fork-contract.ts'
it('captures closed selected requests without invoking getters', () => {
  const request = { version: 2, sourceSessionId: 'source', results: 'selected-results-v1', metadata: { title: 'original' } }
  const captured = readSelectedResultsPrepareRequest(request)
  request.metadata.title = 'changed'
  expect(captured.metadata?.title).toBe('original')
  expect(Object.isFrozen(captured.metadata)).toBe(true)
  expect(() => readSelectedResultsPrepareRequest({ ...request, results: 'none' })).toThrow()
  let called = false
  expect(() => readSelectedResultsPrepareRequest({ version: 2, get sourceSessionId() { called = true; return 'source' }, results: 'selected-results-v1' })).toThrow()
  expect(called).toBe(false)
})
import * as selected from '../src/selected-results-fork-contract.ts'
import { assertSelectedResultsNodeAdmission } from '../src/selected-results-node-admission.ts'
function operation() {
  const core=selected.readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed',atSeq:2},sourceCapture:'first-authorized-capture',metadata:{title:'hello'},results:'selected-results-v1'})
  const {intent,requestDigest}=selected.createSelectedResultsIntent(core,{kind:'project',projectId:'p'})
  return selected.readSelectedResultsOperation({version:2,kind:'session-fork-operation',prepared:{version:2,kind:'session-fork-prepared',core,requestIntent:intent,requestDigest},invocation:{version:1,operationId:'op',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest}})
}
it('recomputes both commitments and binds invocation and path', () => {
  const o=operation()
  expect(selected.readSelectedResultsOperation(o)).toEqual(o)
  expect(selected.selectedResultsPathKey(o.invocation)).toMatch(/^[a-f0-9]{64}$/)
  expect(() => selected.readSelectedResultsOperation({...o,prepared:{...o.prepared,core:{...o.prepared.core,sourceSessionId:'changed'}}})).toThrow()
  expect(() => selected.readSelectedResultsOperation({...o,prepared:{...o.prepared,requestIntent:{...o.prepared.requestIntent,project:{kind:'unassigned'}}}})).toThrow()
  expect(() => selected.readSelectedResultsOperation({...o,invocation:{...o.invocation,targetSessionId:'source'}})).toThrow()
  expect(() => selected.readSelectedResultsOperation({...o,invocation:{...o.invocation,targetSessionId:'../bad'}})).toThrow()
  expect(() => selected.readSelectedResultsOperation({...o,invocation:{...o.invocation,requestDigest:'0'.repeat(64)}})).toThrow()
})
it('rejects invalid closed values and proxies at Node admission', () => {
  const o=operation()
  expect(() => selected.readSelectedResultsPrepareRequest({version:2,sourceSessionId:'source',results:'selected-results-v1',selection:null})).toThrow()
  expect(() => selected.readSelectedResultsCore({...o.prepared.core,selection:{kind:'completed',atSeq:Number.MAX_SAFE_INTEGER+1}})).toThrow()
  expect(() => selected.readSelectedResultsCore({...o.prepared.core,results:'none'})).toThrow()
  expect(() => assertSelectedResultsNodeAdmission({nested:new Proxy({}, {})})).toThrow()
  const c:any={}; c.self=c; expect(() => assertSelectedResultsNodeAdmission(c)).toThrow()
})
it('requires exact operation, receipt, title and captured monotonicity', () => {
  const o=operation(), d='a'.repeat(64)
  const previous=createHash('sha256').update('ih.selected-results.start.v1'+String.fromCharCode(0)+canonicalJsonData({version:1,rows:0,pages:0})).digest('hex')
  const emptyDigest=createHash('sha256').update('ih.selected-results.end.v1'+String.fromCharCode(0)+canonicalJsonData({previous,rows:0,pages:0})).digest('hex')
  const ready={version:2,kind:'ready',operation:o,capture:'captured',sessionId:'target',seedLength:1,title:'hello',receipt:{version:2,invocation:o.invocation,manifestDigest:d,seedLength:1,dependencyClosureDigest:d,seedDigest:d,sourceObservation:{kind:'semantic',digest:d},results:{version:1,rows:0,pages:0,digest:emptyDigest}}}
  expect(selected.readSelectedResultsOutcome(ready,o)).toEqual(ready)
  expect(() => selected.readSelectedResultsOutcome({...ready,receipt:{...ready.receipt,results:{version:1,rows:10001,pages:1,digest:d}}},o)).toThrow()
  expect(() => selected.readSelectedResultsOutcome({...ready,receipt:{...ready.receipt,results:{version:1,rows:1,pages:2,digest:d}}},o)).toThrow()
  expect(() => selected.readSelectedResultsOutcome({...ready,receipt:{...ready.receipt,results:{version:1,rows:1,pages:0,digest:d}}},o)).toThrow()
  expect(() => selected.readSelectedResultsOutcome({...ready,seedLength:0},o)).toThrow()
  expect(() => selected.readSelectedResultsOutcome({...ready,receipt:{...ready.receipt,results:{...ready.receipt.results,rows:-1}}},o)).toThrow()
  expect(() => selected.readSelectedResultsOutcome({...ready,title:'other'},o)).toThrow()
  expect(() => selected.readSelectedResultsHostError({version:2,kind:'session-fork-error',operation:o,capture:'unknown',reason:'internal',lastOutcome:ready},o)).toThrow()
  const blocked={version:2,kind:'blocked',operation:o,capture:'unknown',reason:'unknown',token:{version:2,invocation:o.invocation,phase:'header',manifest:'unknown'}}
  expect(selected.readSelectedResultsOutcome(blocked,o)).toEqual(blocked)
  expect(() => selected.readSelectedResultsOutcome({...blocked,token:{...blocked.token,phase:'seed'}},o)).toThrow()
})
import { createHash } from 'node:crypto'
import { canonicalJsonData } from '@i-harness/core-session'
it('uses the frozen domains and complete canonical inputs', () => {
  const o=operation(), h=(domain:string,value:unknown)=>createHash('sha256').update(domain+'\0'+canonicalJsonData(value)).digest('hex')
  expect(o.prepared.requestIntent.requestCoreDigest).toBe(h('ih.bootstrap.selected-results.core.v1',o.prepared.core))
  expect(o.prepared.requestDigest).toBe(h('ih.bootstrap.selected-results.request.v1',o.prepared.requestIntent))
  expect(selected.selectedResultsPathKey(o.invocation)).toBe(h('ih.bootstrap.selected-results.path.v1',o.invocation))
  const changed=selected.createSelectedResultsIntent(o.prepared.core,{kind:'unassigned'})
  expect(changed.requestDigest).not.toBe(o.prepared.requestDigest)
})
it('rejects accessors and unexpected fields at nested boundaries', () => {
  const o=operation();let called=false
  expect(() => selected.readSelectedResultsCore({...o.prepared.core,metadata:{get title(){called=true;return 'x'}}})).toThrow()
  expect(called).toBe(false)
  expect(() => selected.readSelectedResultsCore({...o.prepared.core,metadata:{title:'hello',unknown:1}})).toThrow()
  expect(() => selected.readSelectedResultsCommand({operation:o,mode:'retry',extra:true})).toThrow()
  expect(selected.readSelectedResultsCommand({operation:o,mode:'retry'}).operation).toEqual(o)
})
it('rejects an invalid empty results fold in a receipt', () => {
  const o=operation(), d='a'.repeat(64)
  const ready={version:2,kind:'ready',operation:o,capture:'captured',sessionId:'target',seedLength:1,title:'hello',receipt:{version:2,invocation:o.invocation,manifestDigest:d,seedLength:1,dependencyClosureDigest:d,seedDigest:d,sourceObservation:{kind:'semantic',digest:d},results:{version:1,rows:0,pages:0,digest:d}}}
  expect(() => selected.readSelectedResultsOutcome(ready,o)).toThrow()
})
