import { expect, it, vi } from 'vitest'
const io=vi.hoisted(()=>({enabled:false,writes:0,syncs:0,bodies:0,live:new Set<object>(),beforeOpen:undefined as undefined|((path:string)=>Promise<void>)}))
vi.mock('node:fs/promises',async original=>{
 const fs=await original<typeof import('node:fs/promises')>()
 return {...fs,async readFile(...args:Parameters<typeof fs.readFile>){if(io.enabled&&/[\\/]blobs[\\/]/.test(String(args[0])))io.bodies++;return fs.readFile(...args)},async writeFile(...args:Parameters<typeof fs.writeFile>){if(io.enabled)io.writes++;return fs.writeFile(...args)},async open(...args:Parameters<typeof fs.open>){const path=String(args[0]);if(io.enabled){if(args[1]!=='r')io.writes++;if(/[\\/]blobs[\\/]/.test(path))io.bodies++;await io.beforeOpen?.(path)}const h=await fs.open(...args),tracked=io.enabled;if(tracked)io.live.add(h);return new Proxy(h,{get(target,key){if(key==='close')return async()=>{await target.close();io.live.delete(h)};if(key==='sync')return async()=>{if(io.enabled)io.syncs++;await target.sync()};const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v}})},async opendir(...args:Parameters<typeof fs.opendir>){const d=await fs.opendir(...args);if(io.enabled)io.live.add(d);const close=d.close.bind(d);d.close=async()=>{await close();io.live.delete(d)};return d}}
})
import { mkdtemp,mkdir,writeFile,readFile,readdir,unlink } from 'node:fs/promises'
import { join,basename } from 'node:path'
import { codecSeed,codecPage,codecRow,codecWire,sealCodecSeed } from '../../core-session/test/fixtures/selected-results.ts'
import * as seedExport from '../../core-session/src/conversation/seed-export.ts'
import { createContextOutputService } from '../src/index.ts'
import { ContextStore } from '../src/store.ts'
import { appliedFor,canonicalRecord,checkBinding,checkRoot,commitment,sourceHash,streamHash } from '../src/legacy/fork-codec.ts'
import { buildPages } from '../src/legacy/fork-pages.ts'
import { expiryBase,expiredTuple,fundSlots,revokedTuple,terminalSlots } from '../src/legacy/fork-disposition.ts'
import { readSelectedPlan,qualifySelectedGraph } from '../src/legacy/selected-readonly-plan.ts'
import { transferDirectory } from '../src/legacy/observed-read.ts'
import type { LegacyReadObservation,LegacyRowV2 } from '../src/legacy/fork-types.ts'
async function fixture(kind:'mixed'|'alias'|'empty'|'managed'|'partial'='mixed'){
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'coverage-')),service=createContextOutputService({root,workspaceId:'w',config:{enabled:true}}),sourceId='original-policy'
 const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()-60000)
 const first=await service.capture({sessionId:'source',callId:'first',label:'first',text:'first body',complete:true,source:{sourceId}});clock.mockRestore()
 const second=await service.capture({sessionId:'source',callId:'second',label:'second',text:'second body',complete:true,source:{sourceId}})
 if(!first||!second)throw Error('Original capture unavailable')
 for(const ref of [first,second])await service.grant({sessionId:'source'},[ref.id],'target')
 const legacy=(ordinal:number,turn:number,ref:typeof first)=>{const r=codecRow(ordinal,turn);r.protocol='legacy';delete r.use;r.ref=ref;r.original={kind:'local',sessionId:'source',seq:ordinal+4,event:'context/result-ref',slot:'ref'};return r}
 const a=legacy(0,1,first),b=legacy(2,2,kind==='alias'?first:second),managed=codecRow(1,2)
 if(kind==='partial')a.extent.last=2
 const pages=kind==='empty'?[]:kind==='managed'?[codecPage([codecRow()])]:[codecPage([a]),codecPage([managed,b],1)]
 let exported=codecSeed('public-completed',pages);if(kind==='partial'){exported.seed.groups=[1,2].map(turn=>({extent:{kind:'framed',first:turn,last:turn},items:[{kind:'summary',scope:'turn',extent:{kind:'framed',first:turn,last:turn},origins:[{origin:0,seq:turn,part:'message'}],sourceProvenance:[{origin:0,kind:'summary',authority:'derived',scope:'turn'}],messages:[{role:'user',content:'summary'}]}]}));exported.seed.passive.codeStore.groups=[0,0];exported=sealCodecSeed(exported.seed)}const view=codecWire(exported);view.header={...view.header,sessionId:'target',createdAt:'2026-10-25T00:00:00.000Z'}
 const h=view.header.semanticSeed,invocation={version:1 as const,operationId:h.operationId,targetSessionId:'target',createdAt:view.header.createdAt,requestDigest:h.requestDigest}
 const binding=checkBinding({workspaceId:'w',invocation,manifestDigest:h.manifestDigest,sourceSessionId:'source',targetSessionId:'target',targetDocumentId:'target',semanticSeedDigest:h.seedDigest,sourceObservationDigest:exported.sourceObservationDigest,selection:{kind:'completed'},targetSourceDigest:sourceHash(sourceId),turnDomainDigest:streamHash('ih.legacy-fork.turn-domain.v1',exported.seed.turns).digest,totalTurns:2,unframedPrefix:false,selectedResults:h.results},2)
 const store=new ContextStore(root,'w'),directory=transferDirectory(store,invocation);await mkdir(join(directory,'pages'),{recursive:true})
 const rows:LegacyRowV2[]=kind==='empty'||kind==='managed'?[]:[{...commitment(first),extent:a.extent,original:{sessionId:'source',seq:4,part:'context/result-ref.ref'},anchor:{kind:'seed-result',manifestSeq:0,pageOrdinal:0,rowOrdinal:0}},{...commitment(b.ref),extent:b.extent,original:{sessionId:'source',seq:6,part:'context/result-ref.ref'},anchor:{kind:'seed-result',manifestSeq:0,pageOrdinal:1,rowOrdinal:2}}]
 for(const ref of [first,second])await fundSlots(store.directory,expiryBase(store.directory,commitment(ref)),expiredTuple('w',commitment(ref)),10_000_000,()=>{})
 const observation:LegacyReadObservation={sessionId:'target',sourceId,bootstrap:{invocation,manifestDigest:h.manifestDigest,seedDigest:h.seedDigest},selectedView:view,assertCurrent(){},localVisible(){throw Error('Source lookup forbidden')},anchorVisible(){throw Error('Source lookup forbidden')}}
 async function publish(actual:LegacyRowV2[]=rows){
  for(const name of await readdir(join(directory,'pages')))await unlink(join(directory,'pages',name))
  for(const name of ['revoke.0','revoke.1'])try{await unlink(join(directory,name))}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
  async function* values(){yield* actual}
  const graph=await buildPages(binding,values(),async(name,page)=>writeFile(join(directory,'pages',name),JSON.stringify(canonicalRecord(page))),2),plan=checkRoot({version:2,kind:'legacy-fork-plan',binding,...graph,distinctRefCount:new Set(actual.map(row=>row.refId)).size})
  for(const [name,value] of Object.entries({'binding.json':{version:2,kind:'legacy-fork-binding',binding},'plan.json':plan,'applied.json':appliedFor(plan)}))await writeFile(join(directory,name),JSON.stringify(canonicalRecord(value)))
  await fundSlots(store.directory,join(directory,'revoke'),revokedTuple(plan),10_000_000,()=>{})
  return readSelectedPlan(store,observation,()=>{})
 }
 async function qualify(){const plan=await readSelectedPlan(store,observation,()=>{});return qualifySelectedGraph(store,plan,observation,()=>{})}
 return {service,store,directory,view,observation,first,second,rows,publish,qualify,async close(){io.enabled=false;io.beforeOpen=undefined;await store.joinLegacyFiles();await service.close()}}
}
it('qualifies the genuine mixed graph and refuses self-consistent omission, duplicate, swap and extra graphs',async()=>{
 const f=await fixture();try{await f.publish();expect(await f.qualify()).toMatchObject({rows:2,distinctRefs:2});expect(f.rows.map(r=>r.anchor)).toEqual([{kind:'seed-result',manifestSeq:0,pageOrdinal:0,rowOrdinal:0},{kind:'seed-result',manifestSeq:0,pageOrdinal:1,rowOrdinal:2}])
 const [a,b]=f.rows as [LegacyRowV2,LegacyRowV2]
 for(const rows of [[a],[a,a],[b,a],[a,b,a],[]]){await f.publish(rows);await expect(f.qualify()).rejects.toThrow(/Selected seed coverage/)}
 }finally{await f.close()}
})
it('keeps hidden expired rows in coverage while visible expiry and missing target ownership refuse',async()=>{
 const f=await fixture();try{
 await f.publish();f.view.events.push({type:'compaction/reset',seq:f.view.events.length,removedSeqs:[1]});const now=vi.spyOn(Date,'now').mockReturnValue(f.first.expiresAt+1)
 try{await terminalSlots(f.store.directory,expiryBase(f.store.directory,commitment(f.first)),expiredTuple('w',commitment(f.first)),()=>{});expect(await f.qualify()).toMatchObject({rows:2,minimumExpiry:f.second.expiresAt});await f.publish([f.rows[1]!]);await expect(f.qualify()).rejects.toThrow('Selected seed coverage');await f.publish()
 f.view.events.pop();await expect(f.qualify()).rejects.toThrow(/expired/)
 }finally{now.mockRestore()}
 }finally{await f.close()}
 const visible=await fixture();try{await visible.publish();await writeFile(join(visible.store.directory,'owners',visible.second.id+'.json'),JSON.stringify(['source']));await expect(visible.qualify()).rejects.toThrow('membership')}finally{await visible.close()}
})
it('preserves two aliases at distinct anchors without collapsing or duplicating observations',async()=>{
 const f=await fixture('alias');try{await f.publish();expect(await f.qualify()).toMatchObject({rows:2,distinctRefs:1});await f.publish([f.rows[0]!,f.rows[0]!]);await expect(f.qualify()).rejects.toThrow('coverage');await f.publish([f.rows[0]!]);await expect(f.qualify()).rejects.toThrow('incomplete')}finally{await f.close()}
})
it.each(['empty','managed'] as const)('qualifies a genuine %s zero-legacy seed with an exact empty graph',async kind=>{const f=await fixture(kind);try{await f.publish();expect(await f.qualify()).toMatchObject({rows:0,distinctRefs:0,minimumExpiry:undefined})}finally{await f.close()}})
it.each(['plan','grant'] as const)('refuses a post-walk %s change through the original final control recheck',async kind=>{
 const f=await fixture();try{const plan=await f.publish(),original=f.store.canonicalRef.bind(f.store);let canonical=0;const spy=vi.spyOn(f.store,'canonicalRef').mockImplementation(async(...args)=>{const ref=await original(...args);canonical++;return ref})
 io.enabled=true;io.beforeOpen=async path=>{if(basename(path)!=='plan.json')return;io.beforeOpen=undefined;expect(canonical).toBe(2);if(kind==='plan')await writeFile(path,'{}');else await terminalSlots(f.store.directory,join(f.directory,'revoke'),revokedTuple(plan.root),()=>{})}
 await expect(qualifySelectedGraph(f.store,plan,f.observation,()=>{})).rejects.toThrow(kind==='plan'?'Original metadata changed':'Original selected grant');spy.mockRestore()
 }finally{await f.close()}
})
it('qualifies read-only without bodies, NEW operations or leaked descriptors and preserves original bytes',async()=>{
 const f=await fixture();try{await f.publish();const files=[join(f.directory,'plan.json'),join(f.directory,'applied.json'),join(f.store.directory,'artifacts',f.first.id+'.json'),join(f.store.directory,'owners',f.first.id+'.json')],before=await Promise.all(files.map(p=>readFile(p))),capture=vi.spyOn(f.service,'capture'),grant=vi.spyOn(f.service,'grant'),index=vi.spyOn(f.store,'ensureIndex'),body=vi.spyOn(f.store,'verifyBody'),exporter=vi.spyOn(seedExport,'exportSelectedResultsConversationSeed'),fund=vi.spyOn(f.store,'fundLegacyBatch'),merge=vi.spyOn(f.store,'mergeLegacyOwner');io.writes=io.syncs=io.bodies=0;io.enabled=true
 expect((await f.qualify()).rows).toBe(2);expect([io.writes,io.syncs,io.bodies,io.live.size]).toEqual([0,0,0,0]);for(const spy of [capture,grant,index,body,exporter,fund,merge]){expect(spy).not.toHaveBeenCalled();spy.mockRestore()}io.enabled=false;expect(await Promise.all(files.map(p=>readFile(p)))).toEqual(before)
 }finally{await f.close()}
})

it('refuses partial inherited cuts through the original visibility owner',async()=>{const f=await fixture('partial');try{await f.publish();expect((await f.qualify()).rows).toBe(2);f.view.events.push({type:'rewind/point',seq:f.view.events.length,anchorSeq:4});await expect(f.qualify()).rejects.toThrow('Ambiguous inherited result cut')}finally{await f.close()}})
