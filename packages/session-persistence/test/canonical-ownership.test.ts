vi.mock('@i-harness/fs-lock/internal/artifact-path',()=>({createArtifactPathOwner:()=>({capture:(path:string)=>({kind:'ready',key:path,assertCurrent(){}}),settleResources(){}})}))
import {beforeEach,expect,it,vi} from 'vitest'
import {win32 as path} from 'node:path'
const associations=vi.hoisted(()=>new WeakMap<object,any>())
vi.mock('../src/coordinator/artifact-path-association.ts',async original=>({...await original<typeof import('../src/coordinator/artifact-path-association.ts')>(),artifactPathsFor:(backend:object)=>associations.get(backend),artifactScope:(port:any,ids:string[],keys:string[])=>({keys:port?[...ids.map(id=>port.session(id).key),...keys.map(key=>port.document(key).key)]:[...ids,...keys],assertCurrent(){}})}))
const native=vi.hoisted(()=>({keys:new Map<string,string>(),held:new Map<string,object>(),acquired:[] as string[],released:[] as string[],refuse:undefined as string|undefined,refuseRelease:undefined as string|undefined}))
vi.mock('@i-harness/fs-lock',async()=>{const {createHash}=await import('node:crypto'),{join}=await import('node:path');return{lockPathFor:(root:string,key:string)=>{const actual=join(root,'.i-harness-locks',createHash('sha256').update(key).digest('hex').slice(0,24)+'.lock');native.keys.set(actual,key);return actual},acquireSessionLock:async({lockPath:actual}:{lockPath:string})=>{const key=native.keys.get(actual)!;if(native.held.has(key)||native.refuse===key)throw Error('native conflict');const identity={};native.held.set(key,identity);native.acquired.push(key);let held=true;return{get held(){return held},async release(){native.released.push(key);if(native.refuseRelease===key)throw undefined;if(!held)return;held=false;expect(native.held.get(key)).toBe(identity);native.held.delete(key)}}}}})
import {createOwnership,captureHeldOwnershipClaim} from '../src/coordinator/ownership.ts'
beforeEach(()=>{native.keys.clear();native.held.clear();native.acquired=[];native.released=[];native.refuse=undefined;native.refuseRelease=undefined})
function identity(){let current=true;const capture=(p:string)=>({kind:'ready' as const,key:path.resolve('C:\\store',p),assertCurrent(){if(!current)throw Error('retired namespace')}});return{session:(id:string)=>capture(id+'.jsonl'),document:(key:string)=>capture(key+'.doc.jsonl'),taskForParent:(id:string)=>capture('task-'+id+'.doc.jsonl'),prepareSession:async()=>{},prepareDocument:async()=>{},assertOriginal(){},settleResources(){},retire(){current=false}}}
const make=(port=identity())=>{const backend={lockRoot:'fixture'};associations.set(backend,port);return{port,owner:createOwnership(backend,{lock:{enabled:true}})}}
it('does not publish a reusable claim while original ordering close remains unknown',async()=>{
 const {owner}=make(),entered=Promise.withResolvers<void>(),leave=Promise.withResolvers<void>();let closes=0
 owner.beginResultOrderingRegistration({}).commit({assertOutside(){},reserve(retain){const original={async join(){},assertSettled(){},async close(){if(++closes===1){entered.resolve();await leave.promise;throw undefined}}};retain(original);return original}})
 const pending=owner.pinOwnership('parent').then(claim=>({claim}),error=>({error}))
 await entered.promise
 const second=await owner.pinOwnership('parent').then(claim=>({claim}),error=>({error}))
 if('claim'in second)await second.claim.release()
 leave.resolve();const first=await pending
 try{expect('error'in second).toBe(true);expect('error'in first).toBe(true);expect(owner.hasLiveOwnership('parent')).toBe(false)}finally{await owner.retryResultOrdering();await Promise.all(owner.releaseHeldLocks())}
})
it('keeps finite method currency through original ordering close before claim publication',async()=>{
 const {owner}=make();let closes=0
 const original={async join(){},assertSettled(){},async close(){closes++;original.join=async()=>{}}}
 owner.beginResultOrderingRegistration({}).commit({assertOutside(){},reserve(retain){retain(original);return original}})
 const outcome=await owner.pinOwnership('parent').then(claim=>({claim}),error=>({error}))
 if('claim'in outcome)await outcome.claim.release()
 try{expect('error'in outcome).toBe(true);const count=native.acquired.length;await owner.retryResultOrdering();expect(native.acquired.length).toBe(count);expect(closes).toBeGreaterThan(0)}finally{await Promise.all(owner.releaseHeldLocks())}
})
it('preserves falsey acquisition and original close failures without invoking a substituted cleanup',async()=>{
 const {owner,port}=make(),prepare=vi.spyOn(port,'prepareSession');let closes=0,substitutes=0,settled=false
 const original={async join(){},assertSettled(){if(!settled)throw Error('unsettled')},async close(){if(++closes===1)throw null;settled=true}}
 owner.beginResultOrderingRegistration({}).commit({assertOutside(){},reserve(retain){retain(original);throw undefined}})
 await expect(owner.pinOwnership('parent')).rejects.toBeUndefined()
 original.close=async()=>{substitutes++}
 await expect(owner.retryResultOrdering()).rejects.toBe(null)
 await owner.retryResultOrdering();expect(closes).toBe(2);expect(substitutes).toBe(0);expect(prepare).not.toHaveBeenCalled();expect(native.acquired).toEqual([])
})
it.each(['proxy','accessor'] as const)('rejects %s participant methods without evaluating a caller getter',mode=>{
 const {owner}=make(),registration=owner.beginResultOrderingRegistration({});let getters=0
 const participant={assertOutside(){},reserve(){throw Error('unreachable')}}
 if(mode==='accessor')Object.defineProperty(participant,'assertOutside',{get(){getters++;return()=>{}}})
 const raw=mode==='proxy'?new Proxy(participant,{}):participant
 expect(()=>registration.commit(raw)).toThrow(/Original ordering/);expect(getters).toBe(0);registration.cancel();expect(native.acquired).toEqual([])
})
it('refuses changed participant data methods before fresh preparation',async()=>{
 const {owner,port}=make(),prepare=vi.spyOn(port,'prepareSession')
 const participant={assertOutside(){},reserve(retain:(cleanup:import('../src/coordinator/result-ordering-types.ts').OriginalOrderingReservation)=>void){const original={async join(){},assertSettled(){},async close(){}};retain(original);return original}}
 owner.beginResultOrderingRegistration({}).commit(participant)
 participant.assertOutside=()=>{}
 await expect(owner.pinOwnership('parent')).rejects.toThrow(/Changed original/)
 expect(prepare).not.toHaveBeenCalled();expect(native.acquired).toEqual([])
})
it('keeps the captured original cleanup when a retained reservation changes or acquisition throws falsey',async()=>{
 const {owner,port}=make(),prepare=vi.spyOn(port,'prepareSession');let closes=0,substitutes=0
 const original={async join(){original.close=async()=>{substitutes++}},assertSettled(){},async close(){closes++;if(closes===1)throw null}}
 owner.beginResultOrderingRegistration({}).commit({assertOutside(){},reserve(retain){retain(original);return original}})
 await expect(owner.pinOwnership('parent')).rejects.toThrow(/Changed original/)
 expect(prepare).not.toHaveBeenCalled();expect(native.acquired).toEqual([])
 await expect(owner.retryResultOrdering()).rejects.toBe(null);expect(closes).toBe(1);expect(substitutes).toBe(0)
 await owner.retryResultOrdering();expect(closes).toBe(2);expect(substitutes).toBe(0)
})
it('refuses a clean returned reservation different from original retained cleanup',async()=>{
 const {owner,port}=make(),prepare=vi.spyOn(port,'prepareSession');let closes=0
 owner.beginResultOrderingRegistration({}).commit({assertOutside(){},reserve(retain){retain({async join(){},assertSettled(){},async close(){closes++}});return{async join(){},assertSettled(){},async close(){throw Error('replacement close')}}}})
 await expect(owner.pinOwnership('parent')).rejects.toThrow(/retained/)
 expect(prepare).not.toHaveBeenCalled();expect(native.acquired).toEqual([])
 await owner.retryResultOrdering();expect(closes).toBe(1)
})
it('fences incomplete registration and refuses copied registrations or replacement of an original participant',async()=>{
 const {owner,port}=make(),identity={},registration=owner.beginResultOrderingRegistration(identity),prepare=vi.spyOn(port,'prepareSession')
 const participant={assertOutside(){},reserve(retain:(cleanup:import('../src/coordinator/result-ordering-types.ts').OriginalOrderingReservation)=>void){const original={async join(){},assertSettled(){},async close(){}};retain(original);return original}}
 await expect(owner.pinOwnership('parent')).rejects.toThrow('ordering unresolved');expect(prepare).not.toHaveBeenCalled();expect(native.acquired).toEqual([])
 expect(()=>({...registration}).commit(participant)).toThrow('receiver')
 registration.commit(participant)
 const duplicate=owner.beginResultOrderingRegistration(identity)
 expect(()=>duplicate.commit({...participant})).toThrow('Changed original ordering participant');duplicate.cancel()
 const claim=await owner.pinOwnership('parent');claim.assertHeld();await claim.release();await Promise.all(owner.releaseHeldLocks())
})
it('reuses exact held session captures and slots without preparing or recapturing through a fresh prerequisite',async()=>{
 const {owner,port}=make(),first=await owner.pinOwnership('parent'),before=[...native.acquired]
 const registration=owner.beginResultOrderingRegistration({})
 let prerequisites=0
 registration.commit({assertOutside(){prerequisites++;throw Error('fresh acquisition refused')},reserve(){throw Error('unreachable')}})
 port.prepareSession=async()=>{throw Error('unexpected prepare')}
 port.session=()=>{throw Error('unexpected session recapture')}
 port.taskForParent=()=>{throw Error('unexpected task recapture')}
 const second=await owner.pinOwnership('parent')
 expect(prerequisites).toBe(0);expect(native.acquired).toEqual(before);first.assertHeld();second.assertHeld()
 await expect(owner.pinOwnership('fresh')).rejects.toThrow('fresh acquisition refused');expect(prerequisites).toBe(1)
 port.retire();await expect(owner.pinOwnership('parent')).rejects.toThrow('retired namespace')
 await first.release();await second.release();await Promise.all(owner.releaseHeldLocks())
})
it('does not use document-only or partial native debt as complete session reuse',async()=>{
 const {owner}=make(),document=await owner.pinDocumentOwnership('parent')
 let prerequisites=0
 owner.beginResultOrderingRegistration({}).commit({assertOutside(){prerequisites++;throw Error('original gate refuses')},reserve(){throw Error('unreachable')}})
 await expect(owner.pinOwnership('parent')).rejects.toThrow('original gate refuses');expect(prerequisites).toBe(1)
 document.assertHeld();await document.release();await Promise.all(owner.releaseHeldLocks())
 const {owner:partial}=make()
 native.refuse='artifact-ownership:'+path.resolve('C:\\store','task-parent.doc.jsonl');native.refuseRelease='artifact-ownership:'+path.resolve('C:\\store','parent.jsonl')
 await expect(partial.pinOwnership('parent')).rejects.toThrow()
 partial.beginResultOrderingRegistration({}).commit({assertOutside(){prerequisites++;throw Error('original gate refuses')},reserve(){throw Error('unreachable')}})
 await expect(partial.pinOwnership('parent')).rejects.toThrow('original gate refuses');expect(prerequisites).toBe(2)
 native.refuse=undefined;native.refuseRelease=undefined;await Promise.all(partial.releaseHeldLocks())
})
it('retains original service admission through partial native rollback and explicit exact cleanup',async()=>{
 const {owner}=make();let fenced=0
 owner.beginResultOrderingRegistration({}).commit({assertOutside(){},reserve(retain){
  fenced++;let settled=false,closed=false
  const original={async join(){settled=true},assertSettled(){if(!settled)throw Error('unsettled')},async close(){if(!closed){closed=true;fenced--}}}
  retain(original);return original
 }})
 native.refuse='artifact-ownership:'+path.resolve('C:\\store','task-parent.doc.jsonl');native.refuseRelease='artifact-ownership:'+path.resolve('C:\\store','parent.jsonl')
 await expect(owner.pinOwnership('parent')).rejects.toThrow();expect(fenced).toBe(1)
 const acquired=[...native.acquired]
 await expect(owner.retryResultOrdering()).rejects.toBeUndefined();expect(fenced).toBe(1);expect(native.acquired).toEqual(acquired)
 native.refuse=undefined;native.refuseRelease=undefined
 await owner.retryResultOrdering();expect(fenced).toBe(0);expect(native.acquired).toEqual(acquired);expect(native.held.size).toBe(0)
 await Promise.all(owner.releaseHeldLocks())
})
it('retains exact session plus original task bundle for canonical aliases and releases one live adoption only',async()=>{
  const {owner}=make();await owner.ensureOwnership('parent');await owner.ensureOwnership('parent');await owner.ensureOwnership('nested/../parent');expect(native.acquired).toHaveLength(3);expect(owner.hasLiveOwnership('parent')).toBe(true);expect(owner.hasLiveOwnership('nested/../parent')).toBe(true)
  const {owner:foreign}=make();await expect((foreign as any).pinDocumentOwnership('parent')).rejects.toThrow();await expect((foreign as any).pinDocumentOwnership('task-parent')).rejects.toThrow();await owner.releaseOwnershipUnlocked('nested/../parent');const free=await(foreign as any).pinDocumentOwnership('parent');await free.release();await expect((foreign as any).pinDocumentOwnership('task-parent')).rejects.toThrow();expect(owner.hasLiveOwnership('parent')).toBe(true);await owner.releaseOwnershipUnlocked('parent');await Promise.all(owner.releaseHeldLocks());await Promise.all(foreign.releaseHeldLocks());expect(native.held.size).toBe(0)
})
it('shares physical session/document ownership across roles while retaining original claim association',async()=>{
  const {owner}=make(),{owner:other}=make();const claim=await owner.pinOwnership('name.doc');captureHeldOwnershipClaim(owner,'name.doc',claim).assertHeld();await expect((other as any).pinDocumentOwnership('name')).rejects.toThrow();const same=await(owner as any).pinDocumentOwnership('name');expect(()=>captureHeldOwnershipClaim(owner,'name.doc',same)).toThrow();await claim.release();same.assertHeld();await same.release();await Promise.all(owner.releaseHeldLocks());await Promise.all(other.releaseHeldLocks());expect(native.held.size).toBe(0)
})
it('retains partial-bundle rollback debt with a falsey failure and retries only original resources',async()=>{
  const {owner}=make();native.refuse='artifact-ownership:'+path.resolve('C:\\store','task-parent.doc.jsonl');native.refuseRelease='artifact-ownership:'+path.resolve('C:\\store','parent.jsonl');const error=await owner.pinOwnership('parent').catch(e=>e);expect(error).toBeInstanceOf(AggregateError);expect(error.errors.at(-1)).toBeUndefined();expect(native.held.size).toBe(1);native.refuseRelease=undefined;await Promise.all(owner.releaseHeldLocks());expect(native.held.size).toBe(0)
})
it('keeps temporary claims separate from idempotent original live adoption and currentness',async()=>{
  const {owner,port}=make();const a=await owner.pinOwnership('parent'),b=await owner.pinOwnership('parent');a.retainLive();b.retainLive();await a.release();await owner.releaseOwnershipUnlocked('parent');b.assertHeld();expect(owner.hasLiveOwnership('parent')).toBe(false);port.retire();expect(()=>b.assertHeld()).toThrow();await b.release();await Promise.all(owner.releaseHeldLocks());expect(native.held.size).toBe(0)
})

it('concurrent bundle borrowers share exact native resources and independent temporary claims', async()=>{
  const {owner}=make(); const [a,b]=await Promise.all([owner.pinOwnership('parent'),owner.pinOwnership('nested/../parent')]); expect(native.acquired).toHaveLength(3); a.retainLive(); b.retainLive(); await Promise.all([a.release(),b.release()]); await owner.releaseOwnershipUnlocked('parent'); expect(owner.hasLiveOwnership('nested/../parent')).toBe(true); await owner.releaseOwnershipUnlocked('nested/../parent'); await Promise.all(owner.releaseHeldLocks()); expect(native.held.size).toBe(0)
})
it('opposing bundle extensions refuse while retaining every healthy original guard',async()=>{
  const {owner:a}=make(),{owner:b}=make(); const document=await a.pinDocumentOwnership('parent'); await b.ensureOwnership('parent'); const results=await Promise.allSettled([a.ensureOwnership('x/../parent'),b.ensureOwnership('x/../parent')]); expect(results.map(r=>r.status)).toEqual(['rejected','rejected']); document.assertHeld(); expect(b.hasLiveOwnership('parent')).toBe(true); await document.release(); await b.ensureOwnership('x/../parent'); await b.releaseOwnershipUnlocked('parent'); expect(b.hasLiveOwnership('x/../parent')).toBe(true); await Promise.all([...a.releaseHeldLocks(),...b.releaseHeldLocks()]); expect(native.held.size).toBe(0)
})

it('preserves singleton falsey bundle disposal and the original native-session ownership diagnostic', async()=>{
  const {owner}=make(),{owner:foreign}=make(),claim=await owner.pinOwnership('parent')
  native.refuseRelease='artifact-ownership:'+path.resolve('C:\\store','parent.jsonl')
  await expect(claim.release()).rejects.toBeUndefined()
  expect(owner.ownerOf('parent')).toBe(true)
  expect(owner.hasLiveOwnership('parent')).toBe(false)
  expect(()=>claim.assertHeld()).toThrow()
  await expect(foreign.pinOwnership('parent')).rejects.toThrow()
  native.refuseRelease=undefined
  await claim.release();await Promise.all([...owner.releaseHeldLocks(),...foreign.releaseHeldLocks()])
  expect(native.held.size).toBe(0)
})

it('document-only ownership cannot satisfy session authority while a foreign full session is independently held',async()=>{
 const {owner}=make(),{owner:foreign}=make(),document=await owner.pinDocumentOwnership('parent')
 try{const session=await foreign.pinOwnership('parent');try{expect(()=>owner.assertHeld('parent')).toThrow('Exclusive managed ownership is unavailable');foreign.assertHeld('parent');document.assertHeld()}finally{await session.release()}}finally{await document.release();await Promise.all([...owner.releaseHeldLocks(),...foreign.releaseHeldLocks()])}
})
it('document-only pins cannot become captured original parent proofs or task document scopes',async()=>{
 const {issueHeldTaskDocumentScope}=await import('../src/coordinator/task-document-scope.ts'),{owner}=make(),document=await owner.pinDocumentOwnership('parent')
 try{expect(()=>captureHeldOwnershipClaim(owner,'parent',document)).toThrow('Invalid ownership claim');expect(()=>issueHeldTaskDocumentScope(owner,'parent',document,{assertActive(){}})).toThrow('Invalid ownership claim');document.assertHeld();expect(()=>document.retainLive()).toThrow('Document pin cannot retain session ownership')}finally{await document.release();await Promise.all(owner.releaseHeldLocks())}
})
it('document-first registration selects the genuine complete session proof and retires only its authority',async()=>{
 const {issueHeldTaskDocumentScope}=await import('../src/coordinator/task-document-scope.ts'),port=identity(),originalDocument=port.document;let documentCurrent=true;port.document=(key:string)=>{const captured=originalDocument(key);return{...captured,assertCurrent(){captured.assertCurrent();if(!documentCurrent)throw Error('document-only namespace changed')}}};const {owner}=make(port),{owner:foreign}=make(),document=await owner.pinDocumentOwnership('parent'),session=await owner.pinOwnership('parent')
 try{documentCurrent=false;expect(()=>document.assertHeld()).toThrow('document-only namespace changed');owner.assertHeld('parent');captureHeldOwnershipClaim(owner,'parent',session).assertHeld();const scope=issueHeldTaskDocumentScope(owner,'parent',session,{assertActive(){}});scope.assertActive();documentCurrent=true;await session.release();document.assertHeld();expect(()=>owner.assertHeld('parent')).toThrow('Exclusive managed ownership is unavailable');expect(()=>scope.assertActive()).toThrow();const next=await foreign.pinOwnership('parent');foreign.assertHeld('parent');await next.release()}finally{documentCurrent=true;await session.release();await document.release();await Promise.all([...owner.releaseHeldLocks(),...foreign.releaseHeldLocks()])}
})
