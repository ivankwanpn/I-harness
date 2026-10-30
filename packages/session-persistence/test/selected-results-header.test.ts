import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { validateSubagentHeader } from '@i-harness/core-session'
import { codecPage, codecRow, codecSeed, sealCodecSeed } from '../../core-session/test/fixtures/selected-results.ts'
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
it('rejects a complete initial tuple even when the generic Core header accepts it',()=>{
 const f=fixture([codecPage([codecRow()])]), built=buildSelectedResultsHeader(f.request,f.reservation)
 const stage:any=structuredClone(built.stage), header=JSON.parse(stage.headerBytes)
 Object.assign(header.semanticSeed,{initialInputId:'x',initialInputDigest:'a'.repeat(64),initialStartedAt:0,initialExpiresAt:1})
 expect(()=>validateSubagentHeader(header)).not.toThrow()
 stage.headerBytes=canonical(header)+'\n'
 const bytes=Buffer.from(canonical(stage)+'\n')
 expect(()=>parseSelectedResultsHeaderStage(bytes)).toThrow()
 expect(()=>reconstituteSelectedResultsStage(stage,f.request.seed.records)).toThrow()
 expect(()=>selectedResultsPreparationFacts(stage,f.request.seed.records)).toThrow()
})
it('roundtrips pages followed by shifted groups and denies layout and record tampering',()=>{
 const f=fixture(), exported=codecSeed('public-completed',[codecPage([codecRow(0,1)]),codecPage([codecRow(1,2)],1)])
 // Accepted Core summary groups: two completed turns, with an empty passive cut per group.
 exported.seed.groups=[1,2].map(turn=>({extent:{kind:'framed',first:turn,last:turn},items:[{kind:'summary',scope:'turn',extent:{kind:'framed',first:turn,last:turn},
  origins:[{origin:0,seq:turn,part:'message'}],sourceProvenance:[{origin:0,kind:'summary',authority:'derived',scope:'turn'}],messages:[{role:'user',content:'summary'}]}]}))
 exported.seed.passive.codeStore.groups=[0,0]
 f.request.seed=compileSelectedResultsSemanticSeed(sealCodecSeed(exported.seed))
 const built=buildSelectedResultsHeader(f.request,f.reservation), stage=parseSelectedResultsHeaderStage(Buffer.from(built.stageBytes))
 const checked=reconstituteSelectedResultsStage(stage,f.request.seed.records), facts=selectedResultsPreparationFacts(stage,f.request.seed.records)
 expect(checked.stage).toEqual(built.stage)
 expect(checked.seed.records.map((r:any)=>[r.type,r.seq,r.ordinal])).toEqual([
  ['conversation/seed-manifest',0,undefined],['conversation/seed-results',1,0],['conversation/seed-results',2,1],['conversation/seed-group',3,0],['conversation/seed-group',4,1]])
 expect(stage.seed).toMatchObject({seedLength:5,resultPageCount:2,groupCount:2})
 expect(stage.headerBase.seedLength).toBe(5)
 expect(JSON.parse(stage.headerBytes).semanticSeed.seedLength).toBe(5)
 expect(facts).toMatchObject({seedLength:5,resultPageCount:2,groupCount:2,semantic:{profile:'public-completed',turns:{total:2,completed:[[1,2]],unframedPrefix:false}}})
 expect(facts.semantic.results).toEqual(stage.seed.results)
 for(const edit of [(r:any)=>r[3].seq=1,(r:any)=>r[3].ordinal=2,(r:any)=>r[0].groupCount=1,(r:any)=>r[0].resultPageCount=1,(r:any)=>{[r[2],r[3]]=[r[3],r[2]]},(r:any)=>{[r[3],r[4]]=[r[4],r[3]]}]) {
  const records:any=structuredClone(f.request.seed.records);edit(records)
  expect(()=>reconstituteSelectedResultsStage(stage,records)).toThrow()
  expect(()=>selectedResultsPreparationFacts(stage,records)).toThrow()
 }
 // Keep header and stage layout copies coherent; rejection must use the complete records.
 for(const [pages,groups,length] of [[1,3,5],[2,3,6]]) {
  const changed:any=structuredClone(stage), header=JSON.parse(changed.headerBytes)
  changed.seed.resultPageCount=header.semanticSeed.resultPageCount=pages
  changed.seed.groupCount=header.semanticSeed.groupCount=groups
  changed.seed.results.pages=header.semanticSeed.results.pages=pages
  changed.seed.seedLength=changed.headerBase.seedLength=header.seedLength=header.semanticSeed.seedLength=length
  changed.headerBytes=canonical(header)+'\n'
  const parsed=parseSelectedResultsHeaderStage(Buffer.from(canonical(changed)+'\n'))
  expect(()=>reconstituteSelectedResultsStage(parsed,f.request.seed.records)).toThrow()
  expect(()=>selectedResultsPreparationFacts(parsed,f.request.seed.records)).toThrow()
 }
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

it('reconstitutes a selected stage using its original physical header version',()=>{
 const f=fixture([codecPage([codecRow()])])
 const built=buildSelectedResultsHeader(f.request,f.reservation,14)
 expect(built.stage.headerBase.formatVersion).toBe(14)
 expect(parseSelectedResultsHeaderStage(Buffer.from(built.stageBytes))).toEqual(built.stage)
 expect(reconstituteSelectedResultsStage(built.stage,f.request.seed.records).stage).toEqual(built.stage)
})
