import {expect,it} from 'vitest'
import {codecSeed,codecPage,codecRow,codecWire} from '../../core-session/test/fixtures/selected-results.ts'
import {commitment,checkRoot,streamHash} from '../src/legacy/fork-codec.ts'
import {captureObservation} from '../src/legacy/observed-read.ts'
import {captureSelectedPlanView} from '../src/legacy/selected-plan-view.ts'
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
