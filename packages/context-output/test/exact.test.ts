import {expect,it} from 'vitest'
import {codecSeed,codecPage,codecRow,codecWire} from '../../core-session/test/fixtures/selected-results.ts'
import {commitment,checkRoot,streamHash} from '../src/legacy/fork-codec.ts'
import {captureObservation} from '../src/legacy/observed-read.ts'
import {captureSelectedPlanView} from '../src/legacy/selected-plan-view.ts'
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {ContextStore} from '../src/store.ts'
import {qualifySelectedGraph} from '../src/legacy/selected-readonly-plan.ts'
import {buildPages} from '../src/legacy/fork-pages.ts'
it('checks a V2 plan row against its actual V3 seed page and declaration',()=>{
 const selected=codecRow();selected.protocol='legacy';delete selected.use;selected.original={kind:'local',sessionId:'source',seq:4,event:'context/result-ref',slot:'ref'}
 selected.ref={id:'ctx_'+'c'.repeat(64),workspaceId:'w',sessionId:'source',callId:'c',label:'selected',revision:'c'.repeat(64),bytes:12,originalBytes:12,complete:true,expiresAt:9999999999999}
 const exported=codecSeed('public-completed',[codecPage([selected])]),view=codecWire(exported);view.header={...view.header,sessionId:'target',createdAt:'2026-10-25T00:00:00.000Z'};const header=view.header.semanticSeed,invocation={version:1 as const,operationId:header.operationId,targetSessionId:'target',createdAt:'2026-10-25T00:00:00.000Z',requestDigest:header.requestDigest},binding={workspaceId:'w',invocation,manifestDigest:header.manifestDigest,sourceSessionId:'source',targetSessionId:'target',targetDocumentId:'target',semanticSeedDigest:header.seedDigest,sourceObservationDigest:exported.sourceObservationDigest,selection:{kind:'completed' as const},targetSourceDigest:'e'.repeat(64),turnDomainDigest:streamHash('ih.legacy-fork.turn-domain.v1',exported.seed.turns).digest,totalTurns:2,unframedPrefix:false,selectedResults:header.results},root=checkRoot({version:2,kind:'legacy-fork-plan',binding,observationCount:0,distinctRefCount:0,pages:null})
 const row={...commitment(selected.ref),extent:selected.extent,original:{sessionId:'source',seq:4,part:'context/result-ref.ref' as const},anchor:{kind:'seed-result' as const,manifestSeq:0 as const,pageOrdinal:0,rowOrdinal:0}}
 expect(()=>captureObservation({sessionId:'target',sourceId:'x',selectedView:view,selectedOwner:{view,assertReady(){}},assertCurrent(){},localVisible(){return true},anchorVisible(){return true}} as never)).toThrow('Original selected source view')
 const plan=captureSelectedPlanView(view,root,{sessionId:'target',createdAt:invocation.createdAt});expect(plan.row(row)).toEqual(selected)
 for(const bad of [{...row,metadataDigest:'a'.repeat(64)},{...row,original:{...row.original,seq:5}},{...row,anchor:{...row.anchor,rowOrdinal:1}}])expect(()=>plan.row(bad)).toThrow()
 expect(()=>captureSelectedPlanView(view,{...root,binding:{...binding,selectedResults:{...header.results,digest:'f'.repeat(64)}}},{sessionId:'target',createdAt:invocation.createdAt})).toThrow()
})
it('rejects an internally empty original graph when the seed contains a legacy row',async()=>{
 const row=codecRow();row.protocol='legacy';delete row.use;row.original={kind:'local',sessionId:'source',seq:4,event:'context/result-ref',slot:'ref'}
 row.ref={id:'ctx_'+'c'.repeat(64),workspaceId:'w',sessionId:'source',callId:'c',label:'selected',revision:'c'.repeat(64),bytes:12,originalBytes:12,complete:true,expiresAt:9999999999999}
 const exported=codecSeed('public-completed',[codecPage([row])]),view=codecWire(exported);view.header={...view.header,sessionId:'target',createdAt:'2026-10-25T00:00:00.000Z'}
 const h=view.header.semanticSeed,invocation={version:1 as const,operationId:h.operationId,targetSessionId:'target',createdAt:view.header.createdAt,requestDigest:h.requestDigest},binding={workspaceId:'w',invocation,manifestDigest:h.manifestDigest,sourceSessionId:'source',targetSessionId:'target',targetDocumentId:'target',semanticSeedDigest:h.seedDigest,sourceObservationDigest:exported.sourceObservationDigest,selection:{kind:'completed' as const},targetSourceDigest:'e'.repeat(64),turnDomainDigest:streamHash('ih.legacy-fork.turn-domain.v1',exported.seed.turns).digest,totalTurns:2,unframedPrefix:false,selectedResults:h.results},root=checkRoot({version:2,kind:'legacy-fork-plan',binding,observationCount:0,distinctRefCount:0,pages:null})
 const selected=captureSelectedPlanView(view,root,{sessionId:'target',createdAt:invocation.createdAt})
 expect([...selected.expectedLegacyRows()]).toHaveLength(1)
 const dir=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'coverage-')),store=new ContextStore(dir,'w'),folder=join(store.directory,'plan');await mkdir(folder,{recursive:true});await mkdir(join(folder,'pages'))
 for(const name of ['binding.json','plan.json','applied.json','revoke.0','revoke.1'])await writeFile(join(folder,name),'x')
 const plan={directory:folder,root,selected,planDigest:'',bindingBytes:Buffer.from('x'),planBytes:Buffer.from('x'),appliedBytes:Buffer.from('x')}
 await expect(qualifySelectedGraph(store,plan,{} as never,()=>{})).rejects.toThrow('Selected seed coverage incomplete')
 const bad={...[...selected.expectedLegacyRows()][0]!,original:{sessionId:'source',seq:5,part:'context/result-ref.ref' as const}}
 async function* rows(){yield bad}
 const graph=await buildPages(binding,rows(),async(name,page)=>writeFile(join(folder,'pages',name),JSON.stringify(page)),2)
 const badRoot=checkRoot({...root,...graph,distinctRefCount:1})
 await expect(qualifySelectedGraph(store,{...plan,root:badRoot},{} as never,()=>{})).rejects.toThrow('Selected seed coverage conflict')
})
