import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { codecPage, codecRow, codecSeed } from '../../core-session/test/fixtures/selected-results.ts'
import { compileSelectedResultsSemanticSeed } from '../src/semantic-seed.ts'
import { createSelectedResultsIntent, readSelectedResultsCore } from '../src/selected-results-fork-contract.ts'
import { parseSelectedResultsHeaderStage, reconstituteSelectedResultsStage, buildSelectedResultsHeader } from '../src/coordinator/selected-results-header.ts'
import { selectedResultsPreparationFacts } from '../src/coordinator/selected-results-preparation.ts'

function fixture(pages: any[] = []) {
  const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{title:'雪'},results:'selected-results-v1'})
  const {intent,requestDigest}=createSelectedResultsIntent(core,{kind:'unmanaged'})
  const invocation={version:1,operationId:'op',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest}
  const reservation={version:1,kind:'semantic-bootstrap-selected-results-capture',request:{invocation,core,requestIntent:intent}}
  const request={invocation,target:{kind:'new'},metadata:{title:'雪'},lineage:{origin:'fork',parentSession:'source'},seed:compileSelectedResultsSemanticSeed(codecSeed('public-completed',pages))}
  return {request,reservation}
}
const canonical=(x:unknown)=>JSON.stringify(x,(_k,v)=>v && typeof v==='object' && !Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0)):v)
it.each([{pages:[]},{pages:[codecPage([codecRow()])]},{pages:[codecPage([codecRow(0,1)]),codecPage([codecRow(1,2)],1)]}])('constructs public stages without embedding records for %s',({pages})=>{
  const {request,reservation}=fixture(pages), result=buildSelectedResultsHeader(request,reservation), stage=result.stage
  const header=JSON.parse(stage.headerBytes), records=request.seed.records
  expect(stage.seed.seedLength).toBe(1+pages.length)
  expect(stage.seed.resultPageCount).toBe(pages.length)
  expect(stage.seed.groupCount).toBe(0)
  expect(stage.originalTarget).toEqual({kind:'new'})
  expect(stage.seed).not.toHaveProperty('records')
  expect(header.semanticSeed.profile).toBe('public-completed')
  const preimage={version:2,route:{protocol:'public-results-v1',request:reservation.request},captureReservation:reservation,invocation:stage.invocation,target:stage.originalTarget,metadata:stage.metadata,lineage:stage.lineage,headerBase:stage.headerBase,seed:{...stage.seed,records}}
  const expected=createHash('sha256').update('ih.bootstrap.selected-results.manifest.v1\0'+canonical(preimage)).digest('hex')
  expect(header.semanticSeed.manifestDigest).toBe(expected)
  expect(Buffer.from(result.stageBytes).toString()).toBe(canonical(stage)+'\n')
  expect(Buffer.from(result.headerBytes).toString()).toBe(canonical(header)+'\n')
  expect(Object.isFrozen(stage.seed.results)).toBe(true)
})
it('rejects mismatched request, seed, layout, origin and reservation',()=>{
  const f=fixture([codecPage([codecRow()])])
  const edits=[(r:any)=>r.metadata.title='other',(r:any)=>r.lineage.parentSession='other',(r:any)=>r.invocation.targetSessionId='other',(r:any)=>r.target={kind:'existing-empty'},(r:any)=>r.initial={},(r:any)=>r.seed.digest='0'.repeat(64),(r:any)=>r.seed.dependencyDigest='0'.repeat(64),(r:any)=>r.seed.sourceObservation.digest='0'.repeat(64),(r:any)=>r.seed.records[0].selection={kind:'completed',atSeq:2},(r:any)=>r.seed.records[0].origins[0].sessionId='other',(r:any)=>r.seed.records[0].resultPageCount=2,(r:any)=>r.seed.records[1].page.rows[0].ref.encodedBytes++,(r:any)=>r.seed.records[0].results.rows++, (r:any)=>r.seed.records[1].seq=7]
  for(const edit of edits){const request=structuredClone(f.request);edit(request);expect(()=>buildSelectedResultsHeader(request,f.reservation)).toThrow()}
  expect(()=>buildSelectedResultsHeader(f.request,{...f.reservation,kind:'semantic-bootstrap-child-capture'})).toThrow()
})
it('detaches and freezes all stage metadata from the caller',()=>{
 const f=fixture(), request:any=structuredClone(f.request), reservation:any=structuredClone(f.reservation), result=buildSelectedResultsHeader(request,reservation)
 request.metadata.title='changed'; reservation.request.core.metadata.title='changed'
 expect(result.stage.metadata.title).toBe('雪');expect(result.stage.captureReservation.request.core.metadata.title).toBe('雪')
 expect(Object.isFrozen(result.stage.captureReservation.request.core.metadata)).toBe(true)
})


it('rejects child profile, forbidden descriptors and encoded header overflow',()=>{
 const f=fixture(), request:any=structuredClone(f.request)
 request.seed=compileSelectedResultsSemanticSeed(codecSeed('child-history'))
 expect(()=>buildSelectedResultsHeader(request,f.reservation)).toThrow()
 const hidden:any=structuredClone(f.request); Object.defineProperty(hidden.seed.records[0],'hidden',{value:true})
 expect(()=>buildSelectedResultsHeader(hidden,f.reservation)).toThrow()
 let invoked=false;const accessor:any=structuredClone(f.request);Object.defineProperty(accessor.seed,'digest',{enumerable:true,get(){invoked=true;return 'x'}})
 expect(()=>buildSelectedResultsHeader(accessor,f.reservation)).toThrow();expect(invoked).toBe(false)
 const core=readSelectedResultsCore({...f.reservation.request.core,metadata:{title:'\u0000'.repeat(16000)}})
 const {intent,requestDigest}=createSelectedResultsIntent(core,{kind:'unmanaged'}), invocation={...f.request.invocation,requestDigest}
 const reservation={...f.reservation,request:{invocation,core,requestIntent:intent}}
 expect(()=>buildSelectedResultsHeader({...f.request,invocation,metadata:core.metadata},reservation)).toThrow()
})


it('parses structural stage and reconstitutes complete records before deriving public facts',()=>{
 const f=fixture([codecPage([codecRow()])]), built=buildSelectedResultsHeader(f.request,f.reservation)
 const stage=parseSelectedResultsHeaderStage(Buffer.from(built.stageBytes))
 expect(stage).toEqual(built.stage)
 const checked=reconstituteSelectedResultsStage(stage,f.request.seed.records)
 expect(checked.stage).toEqual(stage)
 const facts=selectedResultsPreparationFacts(stage,f.request.seed.records)
 expect(facts.semantic).toEqual({version:3,profile:'public-completed',selection:{kind:'completed'},turns:{total:2,completed:[[1,2]],unframedPrefix:false},results:stage.seed.results})
 expect(facts.manifestDigest).toBe(JSON.parse(stage.headerBytes).semanticSeed.manifestDigest)
 expect(Object.isFrozen(facts.semantic.results)).toBe(true)
})
it('rejects malformed stage structure and canonical byte encodings',()=>{
 const f=fixture(), built=buildSelectedResultsHeader(f.request,f.reservation), stage:any=built.stage
 const bad=[(s:any)=>s.version=1,(s:any)=>s.kind='semantic-bootstrap-header',(s:any)=>delete s.captureReservation,(s:any)=>s.originalTarget.kind='resume',(s:any)=>s.metadata.title='other',(s:any)=>s.lineage.parentSession='other',(s:any)=>s.headerBase.formatVersion=12,(s:any)=>s.seed.groupCount=Number.MAX_SAFE_INTEGER,(s:any)=>s.seed.profile='child-history',(s:any)=>s.extra=1,(s:any)=>{const h=JSON.parse(s.headerBytes);h.semanticSeed.initialInputId='x';s.headerBytes=canonical(h)+'\n'},(s:any)=>{const h=JSON.parse(s.headerBytes);h.semanticSeed.seedDigest='0'.repeat(64);s.headerBytes=canonical(h)+'\n'}]
 for(const edit of bad){const v=structuredClone(stage);edit(v);expect(()=>parseSelectedResultsHeaderStage(Buffer.from(canonical(v)+'\n'))).toThrow()}
 expect(()=>parseSelectedResultsHeaderStage(Buffer.from(built.stageBytes.trim()))).toThrow()
 expect(()=>parseSelectedResultsHeaderStage(Buffer.from([0xff]))).toThrow()
 expect(()=>parseSelectedResultsHeaderStage(new Uint8Array(262145))).toThrow()
})
it('requires the complete original records and rejects unbound header and record commitments',()=>{
 const f=fixture([codecPage([codecRow()])]), built=buildSelectedResultsHeader(f.request,f.reservation), stage=parseSelectedResultsHeaderStage(Buffer.from(built.stageBytes))
 expect(()=>reconstituteSelectedResultsStage(stage,[])).toThrow()
 const records:any=structuredClone(f.request.seed.records);records[1].page.rows[0].ref.encodedBytes++
 expect(()=>reconstituteSelectedResultsStage(stage,records)).toThrow()
 const changed:any=structuredClone(stage), h=JSON.parse(changed.headerBytes);h.semanticSeed.manifestDigest='0'.repeat(64);changed.headerBytes=canonical(h)+'\n'
 const parsed=parseSelectedResultsHeaderStage(Buffer.from(canonical(changed)+'\n'))
 expect(()=>reconstituteSelectedResultsStage(parsed,f.request.seed.records)).toThrow()
 expect(()=>selectedResultsPreparationFacts(parsed,f.request.seed.records)).toThrow()
})

it('defers source and manifest claims to complete-record verification',()=>{
 const f=fixture([codecPage([codecRow()])]), original=buildSelectedResultsHeader(f.request,f.reservation)
 for(const edit of [
  (s:any)=>s.seed.sourceObservation.digest='0'.repeat(64),
  (s:any)=>{s.seed.dependencyDigest='0'.repeat(64);const h=JSON.parse(s.headerBytes);h.semanticSeed.dependencyDigest=s.seed.dependencyDigest;s.headerBytes=canonical(h)+'\n'},
  (s:any)=>{s.invocation.createdAt='2026-10-29T00:00:00.000Z';s.captureReservation.request.invocation.createdAt=s.invocation.createdAt;s.headerBase.createdAt=s.invocation.createdAt;const h=JSON.parse(s.headerBytes);h.createdAt=s.invocation.createdAt;s.headerBytes=canonical(h)+'\n'}
 ]) {
  const s:any=structuredClone(original.stage);edit(s)
  const parsed=parseSelectedResultsHeaderStage(Buffer.from(canonical(s)+'\n'))
  expect(()=>reconstituteSelectedResultsStage(parsed,f.request.seed.records)).toThrow()
  expect(()=>selectedResultsPreparationFacts(parsed,f.request.seed.records)).toThrow()
 }
})
it('retains detached frozen structural and verified snapshots',()=>{
 const f=fixture([codecPage([codecRow()])]), built=buildSelectedResultsHeader(f.request,f.reservation)
 const bytes=Buffer.from(built.stageBytes), stage=parseSelectedResultsHeaderStage(bytes), records:any=structuredClone(f.request.seed.records)
 const checked=reconstituteSelectedResultsStage(stage,records), facts=selectedResultsPreparationFacts(stage,records)
 bytes.fill(0);records[1].page.rows[0].ref.encodedBytes++
 expect(checked.seed.records[1]).toEqual(f.request.seed.records[1])
 expect(Object.isFrozen(checked.seed.records[1])).toBe(true)
 expect(Object.isFrozen(stage.captureReservation.request.core.metadata)).toBe(true)
 expect(Object.isFrozen(facts.semantic.turns)).toBe(true)
})
