import { expect, it } from 'vitest'
import * as managed from '../src/managed/view.ts'
import { captureFactGroup, encodeFactBatch,factPrefixDigest } from '../src/index.ts'
import type { SessionEvent, Session } from '../src/events/types.ts'
import type { JournalPrefix, OwnerToken, FactOutcome } from '../src/managed/types.ts'
import { createManagedSessionState } from '../src/managed/view.ts'
import { createActionCaptures } from '../../session-persistence/src/coordinator/action-captures.ts'
import { createSourceFacts } from '../../session-persistence/src/coordinator/source-facts.ts'

async function fixture(events: SessionEvent[],controls:{read?():Promise<void>;close?():Promise<void>;beforeAppend?():void}={}) {
  const token: OwnerToken = Object.freeze({sessionId:'owned',incarnation:'original'})
  let prefix: JournalPrefix = {eventCount:events.length,bodyBytes:0,prefixDigest:'a'.repeat(64)}
  let held=true, revision=0, reads:number[]=[], opened=0, closed=0,lastScope:any
  const source={formatVersion:14,get prefix(){return prefix},assertCurrent(){if(!held)throw Error('lost owner')},async consume(accept:any){for(const event of events)await accept([Object.freeze(event)])},async readEvent(index:number){return events[index]!},async settle(){},async close(){},appendCommitted(batch:any,receipt:any){controls.beforeAppend?.();prefix={eventCount:prefix.eventCount+batch.key.count,bodyBytes:prefix.bodyBytes+batch.bytes.length,prefixDigest:receipt.prefixDigest};revision++}}
  const binding={token,assertHeld(){if(!held)throw Error('lost owner')},openDependencies(expected:Readonly<JournalPrefix>){opened++;const epoch=revision;let disposed=false;lastScope={assertCurrent(){if(disposed||revision!==epoch||prefix!==expected)throw Error('changed prefix');binding.assertHeld()},async readEvent(index:number){this.assertCurrent();reads.push(index);await controls.read?.();return events[index]!},async close(){await controls.close?.();disposed=true;closed++}};return lastScope}}
  const state=await (managed as any).restoreManagedExecutionState(source,binding)
  return {state,token,source,binding,events,reads,get lastScope(){return lastScope},get opened(){return opened},get closed(){return closed},lose(){held=false},change(){revision++},receipt(batch:any){return Object.freeze({owner:token,key:batch.key,lastSeq:batch.key.firstSeq+batch.key.count-1,prefixDigest:factPrefixDigest(batch.key.previousPrefixDigest,batch.key.batchDigest)})}}
}
function group(draft:any){const captured=captureFactGroup(draft);if(captured.kind!=='captured')throw Error(captured.code);return captured.group}
function commands(){const refused=async():Promise<FactOutcome>=>({kind:'not-issued',code:'FACT_CANCELLED'});return {admit:refused,observe:refused,reconcile:refused}}
function memberCapture(f:any,captured:any,source:object){return f.state.captureHooks(source,()=>f.binding.assertHeld()).capture(captured,commands())}

it('the original private core normalizes a nonresident image admission and matches the complete public writer',async()=>{
  const events:SessionEvent[]=[{type:'agent/input/admitted',version:1,inputId:'image',text:'task',delivery:'queue',intent:'user',images:[{mediaType:'image/png',dataBase64:'eA=='}],seq:0}]
  const f=await fixture(events), draft={kind:'input-start',promoted:{type:'agent/input/promoted',version:1,inputId:'image'},turn:{type:'turn/start'},message:{type:'user/message',text:'task',imageInputId:'image',input:{inputId:'image',intent:'user'}}}, captured=group(draft)
  const full=createManagedSessionState({formatVersion:14,events:JSON.parse(JSON.stringify(events))} as Session,{sessionId:'owned'})
  const prepared=await f.state.prepareWrite([captured])
  const expected=full.stage((await import('../src/managed/groups.ts')).resolveFactGroup(captured,full.view,1))
  expect(prepared.events).toEqual(expected.events)
  expect(prepared.events.at(-1).imageSummaries).toEqual([{mediaType:'image/png',bytes:1}])
  expect(f.reads).toEqual([0]);expect(f.opened).toBe(1);expect(f.closed).toBe(1)
  expect('view' in f.state).toBe(false);expect('events' in f.state).toBe(false)
  const batch=encodeFactBatch('once',f.source.prefix.prefixDigest,prepared.events), receipt=f.receipt(batch)
  prepared.beforeIssue(batch);prepared.install(batch,receipt);prepared.install(batch,receipt)
  expect(f.state.eventCount).toBe(4)
})

it('ACK membership belongs to exact original capture/outcome objects after an optional lease settles and Stop',async()=>{
  const f=await fixture([{type:'turn/start',seq:0},{type:'user/message',text:'task',seq:1},{type:'step/start',seq:2}])
  const source={},captured=group({kind:'assistant-audit',assistant:{type:'assistant/message',text:'answer'}})
  const capture=memberCapture(f,captured,source)
  const lease=await f.state.prepare();await lease.settle()
  const prepared=await f.state.prepareWrite([captured]), batch=encodeFactBatch('one-capture',f.source.prefix.prefixDigest,prepared.events),receipt=f.receipt(batch)
  prepared.beforeIssue(batch);prepared.install(batch,receipt)
  const outcome=Object.freeze({kind:'committed',receipt,seqs:Object.freeze([3])}) as FactOutcome
  f.state.acknowledge(captured,outcome)
  const members=(managed as any).readAcknowledgedExecutionMembers(capture,outcome)
  expect(members).toEqual(prepared.events);expect(members[0]).toBe(prepared.events[0])
  expect(()=> (managed as any).readAcknowledgedExecutionMembers({...capture},outcome)).toThrow()
  expect(()=> (managed as any).readAcknowledgedExecutionMembers(capture,{...outcome})).toThrow()
  f.state.stopNewWork()
  expect((managed as any).readAcknowledgedExecutionMembers(capture,outcome)[0]).toBe(prepared.events[0])
  f.state.releaseSource(source)
  expect(()=> (managed as any).readAcknowledgedExecutionMembers(capture,outcome)).toThrow()
})

it('only the original constructor binding authenticates a no-view producer',async()=>{
  const f=await fixture([]),owner={ownsAction:()=>false,beginAction(){throw Error('unused')},registerReceivedInputSource(){throw Error('unused')},async drain(){}}
  f.state.bindOwner(owner)
  expect((managed as any).isManagedExecutionOwner(f.state.identity,owner)).toBe(true)
  expect((managed as any).isManagedExecutionOwner({...f.state.identity},owner)).toBe(false)
  expect((managed as any).isManagedExecutionOwner(f.state.identity,{...owner})).toBe(false)
  expect(()=>f.state.bindOwner(owner)).toThrow()
  f.lose()
  expect((managed as any).isManagedExecutionOwner(f.state.identity,owner)).toBe(false)
})

it('the capture original instruction/body pin outlives source retirement and refuses after its own release',async()=>{
  const f=await fixture([]),source={},captured=group({kind:'metadata',event:{type:'plan/mode',mode:'on'}})
  const capture=memberCapture(f,captured,source)
  const staged=await f.state.prepareWrite([captured]),batch=encodeFactBatch('pin',f.source.prefix.prefixDigest,staged.events),receipt=f.receipt(batch)
  staged.beforeIssue(batch);staged.install(batch,receipt)
  const outcome=Object.freeze({kind:'committed',receipt,seqs:Object.freeze([0])}) as FactOutcome
  f.state.acknowledge(captured,outcome)
  const pin=(managed as any).retainAcknowledgedExecutionMembers(capture,outcome)
  f.state.stopNewWork();f.state.releaseSource(source)
  expect(pin.members[0]).toBe(staged.events[0]);pin.assertCurrent()
  await expect(f.state.close()).rejects.toThrow('capture')
  pin.release();expect(()=>pin.assertCurrent()).toThrow()
  expect(()=> (managed as any).readAcknowledgedExecutionMembers(capture,outcome)).toThrow()
  await f.state.close()
})

it('a prefix revision changed across actual dependency hydration refuses before any install',async()=>{
  let enter!:()=>void,resume!:()=>void
  const entered=new Promise<void>(resolve=>enter=resolve),held=new Promise<void>(resolve=>resume=resolve)
  const f=await fixture([{type:'tool/call',callId:'old',name:'read',args:{},seq:0}],{async read(){enter();await held}})
  const captured=group({kind:'tool',event:{type:'tool/dispatch',callId:'old',eventSeq:{kind:'prior',seq:0,expectedType:'tool/call'}}})
  const writing=f.state.prepareWrite([captured]);await entered;f.change();resume()
  await expect(writing).rejects.toThrow('changed prefix')
  expect(f.state.eventCount).toBe(1);expect(f.closed).toBe(1)
})

it('falsey cleanup failure retains the exact reader and blocks preparation until original cleanup succeeds',async()=>{
  let failed=true
  const f=await fixture([{type:'tool/call',callId:'old',name:'read',args:{},seq:0}],{async close(){if(failed)throw 0}}),captured=group({kind:'tool',event:{type:'tool/dispatch',callId:'old',eventSeq:{kind:'prior',seq:0,expectedType:'tool/call'}}})
  await expect(f.state.prepareWrite([captured])).rejects.toBe(0)
  await expect(f.state.prepareWrite([captured])).rejects.toThrow('cleanup unresolved')
  expect(f.opened).toBe(1);expect(f.closed).toBe(0)
  failed=false;await f.state.close();expect(f.closed).toBe(1)
})

it('failed dependency cleanup retains its original method even if the reader is later substituted',async()=>{
  let failed=true,replacement=0
  const f=await fixture([],{async close(){if(failed)throw 0}})
  await expect(f.state.prepareWrite([group({kind:'metadata',event:{type:'plan/mode',mode:'on'}})])).rejects.toBe(0)
  f.lastScope.close=async()=>{replacement++}
  failed=false;await f.state.close()
  expect(replacement).toBe(0);expect(f.closed).toBe(1)
})

it('the original writer accepts the verified canonical receipt owner copy and keeps receipt identity for ACK',async()=>{
  const f=await fixture([]),source={},captured=group({kind:'metadata',event:{type:'plan/mode',mode:'on'}})
  const capture=memberCapture(f,captured,source)
  const staged=await f.state.prepareWrite([captured]),batch=encodeFactBatch('canonical',f.source.prefix.prefixDigest,staged.events)
  const receipt=Object.freeze({...f.receipt(batch),owner:Object.freeze({...f.token})})
  staged.beforeIssue(batch);staged.install(batch,receipt)
  const outcome=Object.freeze({kind:'committed',receipt,seqs:Object.freeze([0])}) as FactOutcome
  f.state.acknowledge(captured,outcome)
  expect((managed as any).readAcknowledgedExecutionMembers(capture,outcome)[0]).toBe(staged.events[0])
})

it('a forged matching receipt before the original issuance cannot install or grant ACK membership',async()=>{
  const f=await fixture([]),source={},captured=group({kind:'metadata',event:{type:'plan/mode',mode:'on'}})
  const capture=memberCapture(f,captured,source)
  const staged=await f.state.prepareWrite([captured]),batch=encodeFactBatch('not-issued',f.source.prefix.prefixDigest,staged.events),receipt=f.receipt(batch)
  expect(()=>staged.install(batch,receipt)).toThrow('issuance')
  const outcome=Object.freeze({kind:'committed',receipt,seqs:Object.freeze([0])}) as FactOutcome
  expect(()=>f.state.acknowledge(captured,outcome)).toThrow()
  expect(()=> (managed as any).readAcknowledgedExecutionMembers(capture,outcome)).toThrow()
  expect(f.state.eventCount).toBe(0)
})

it('an original issued write blocks replacement preparation and retries installation with its first exact receipt',async()=>{
  let fail=true,appends=0
  const f=await fixture([],{beforeAppend(){appends++;if(fail)throw Error('original install fault')}}),source={},captured=group({kind:'metadata',event:{type:'plan/mode',mode:'on'}})
  const capture=memberCapture(f,captured,source)
  const staged=await f.state.prepareWrite([captured]),batch=encodeFactBatch('original-unknown',f.source.prefix.prefixDigest,staged.events),receipt=f.receipt(batch)
  staged.beforeIssue(batch)
  await expect(f.state.prepareWrite([captured])).rejects.toThrow('issued write')
  expect(()=>staged.beforeIssue(batch)).toThrow()
  expect(()=>staged.install(batch,receipt)).toThrow('original install fault')
  expect(()=>staged.install({...batch},receipt)).toThrow()
  expect(()=>staged.install(batch,{...receipt})).toThrow('Original pending')
  fail=false;staged.install(batch,receipt)
  const outcome=Object.freeze({kind:'committed',receipt,seqs:Object.freeze([0])}) as FactOutcome
  f.state.acknowledge(captured,outcome)
  expect((managed as any).readAcknowledgedExecutionMembers(capture,outcome)[0]).toBe(staged.events[0])
  expect(f.state.eventCount).toBe(1);expect(appends).toBe(2)
})

it('coalesced groups acknowledge only each actual capture slice of the original frame',async()=>{
  const f=await fixture([]),source={},ga=group({kind:'metadata',event:{type:'plan/mode',mode:'on'}}),gb=group({kind:'metadata',event:{type:'session/title',title:'title'}})
  const a=memberCapture(f,ga,source),b=memberCapture(f,gb,source)
  const staged=await f.state.prepareWrite([ga,gb]),batch=encodeFactBatch('coalesced',f.source.prefix.prefixDigest,staged.events),receipt=f.receipt(batch)
  staged.beforeIssue(batch);staged.install(batch,receipt)
  const oa=Object.freeze({kind:'committed',receipt,seqs:Object.freeze([0])}) as FactOutcome,ob=Object.freeze({kind:'committed',receipt,seqs:Object.freeze([1])}) as FactOutcome
  expect(()=>f.state.acknowledge(ga,{kind:'committed',receipt,seqs:[0,1]})).toThrow()
  f.state.acknowledge(ga,oa);f.state.acknowledge(gb,ob)
  expect((managed as any).readAcknowledgedExecutionMembers(a,oa)).toEqual([staged.events[0]])
  expect((managed as any).readAcknowledgedExecutionMembers(b,ob)[0]).toBe(staged.events[1])
  expect(()=> (managed as any).readAcknowledgedExecutionMembers(a,ob)).toThrow()
})

it('only original proven absence retires its issued operation before an explicit same-capture retry',async()=>{
  const f=await fixture([]),captured=group({kind:'metadata',event:{type:'plan/mode',mode:'on'}}),staged=await f.state.prepareWrite([captured]),batch=encodeFactBatch('absent',f.source.prefix.prefixDigest,staged.events)
  staged.beforeIssue(batch)
  expect(()=>staged.settleAbsent({kind:'absent',key:{...batch.key}})).toThrow()
  staged.settleAbsent({kind:'absent',key:batch.key})
  expect(()=>staged.install(batch,f.receipt(batch))).toThrow()
  const retry=await f.state.prepareWrite([captured]),next=encodeFactBatch('explicit-retry',f.source.prefix.prefixDigest,retry.events)
  retry.beforeIssue(next);retry.install(next,f.receipt(next));expect(f.state.eventCount).toBe(1)
})

it('primary and cleanup falsey failures remain distinct and keep the original reader debt',async()=>{
  let failed=true
  const f=await fixture([{type:'tool/call',callId:'old',name:'read',args:{},seq:0}],{async read(){throw null},async close(){if(failed)throw 0}}),captured=group({kind:'tool',event:{type:'tool/dispatch',callId:'old',eventSeq:{kind:'prior',seq:0,expectedType:'tool/call'}}})
  const failure=await f.state.prepareWrite([captured]).catch((error:unknown)=>error)
  expect(failure).toBeInstanceOf(AggregateError);expect(failure.errors).toEqual([null,0])
  failed=false;await f.state.close();expect(f.closed).toBe(1)
})

it('discarding an unissued original preparation retires its semantic stage without installing it',async()=>{
  const f=await fixture([]),captured=group({kind:'metadata',event:{type:'plan/mode',mode:'on'}}),staged=await f.state.prepareWrite([captured]),batch=encodeFactBatch('discarded',f.source.prefix.prefixDigest,staged.events)
  staged.discardUnissued()
  expect(()=>staged.beforeIssue(batch)).toThrow()
  expect(f.state.eventCount).toBe(0)
  const next=await f.state.prepareWrite([captured]),issued=encodeFactBatch('next',f.source.prefix.prefixDigest,next.events)
  next.beforeIssue(issued);next.install(issued,f.receipt(issued));expect(f.state.eventCount).toBe(1)
})

it('only the original capture factory can forward its same-owner wrapper membership',async()=>{
  const f=await fixture([]),other=await fixture([]),source={},captured=group({kind:'metadata',event:{type:'plan/mode',mode:'on'}})
  const original=memberCapture(f,captured,source),hooks=f.state.captureHooks(source,()=>f.binding.assertHeld()),incoming=commands()
  expect(()=>other.state.captureHooks({},()=>other.binding.assertHeld()).forward(original,commands())).toThrow()
  expect(()=>hooks.forward({...original},commands())).toThrow()
  const forwarded=hooks.forward(original,incoming)
  expect(forwarded).not.toBe(incoming)
  expect(()=>hooks.forward(original,commands())).toThrow()
  const staged=await f.state.prepareWrite([captured]),batch=encodeFactBatch('wrapper',f.source.prefix.prefixDigest,staged.events),receipt=f.receipt(batch)
  staged.beforeIssue(batch);staged.install(batch,receipt)
  const outcome=Object.freeze({kind:'committed',receipt,seqs:Object.freeze([0])}) as FactOutcome
  f.state.acknowledge(captured,outcome)
  expect((managed as any).readAcknowledgedExecutionMembers(forwarded,outcome)[0]).toBe(staged.events[0])
  expect(()=> (managed as any).readAcknowledgedExecutionMembers(incoming,outcome)).toThrow()
  expect(()=> (managed as any).readAcknowledgedExecutionMembers({...forwarded},outcome)).toThrow()
  f.state.releaseSource(source)
  expect(()=> (managed as any).readAcknowledgedExecutionMembers(forwarded,outcome)).toThrow()
})

it('the actual action and source factories construct exact frozen ACK wrappers without blessing caller DTOs',async()=>{
  const f=await fixture([{type:'conversation/semantics',version:1,mode:'accepted-exchange-v1',seq:0},{type:'step/start',actionId:'a',attemptId:'t',seq:1}]),source={},status=new WeakMap<object,FactOutcome>()
  const hooks=f.state.captureHooks(source,()=>f.binding.assertHeld())
  const operations={captureMembers:hooks,assertHeld:()=>f.binding.assertHeld(),quarantineCapture(){throw Error('unexpected invalid capture')},status:(group:object)=>status.get(group),async reconcile(){throw Error('unexpected replacement reconcile')},async admit(group:any){
    const staged=await f.state.prepareWrite([group]),batch=encodeFactBatch('actual-factory-'+f.state.eventCount,f.source.prefix.prefixDigest,staged.events),receipt=f.receipt(batch)
    staged.beforeIssue(batch);staged.install(batch,receipt)
    const outcome=Object.freeze({kind:'committed',receipt,seqs:Object.freeze(staged.events.map((event:any)=>event.seq!))}) as FactOutcome
    f.state.acknowledge(group,outcome);status.set(group,outcome);return outcome
  }}
  const action=createActionCaptures(operations,()=>operations),capture=action.captureModelExchange({type:'assistant/message',text:'actual'}, {type:'model/exchange-accepted',version:1,exchangeId:'e',actionId:'a',attemptId:'t',stepStartSeq:{kind:'prior',seq:1,expectedType:'step/start'},assistantSeq:{kind:'group',position:0,expectedType:'assistant/message'},callSeqs:[]})
  const outcome=await capture.admit()
  expect((managed as any).readAcknowledgedExecutionMembers(capture,outcome).map((event:any)=>event.seq)).toEqual([2,3])
  const records=createSourceFacts(operations),fact=records.capture({kind:'metadata',event:{type:'plan/mode',mode:'on'}}),saved=await fact.admit()
  f.state.stopNewWork()
  expect(await fact.observe()).toBe(saved)
  expect((managed as any).readAcknowledgedExecutionMembers(fact,saved)[0].seq).toBe(4)
  expect(Object.isFrozen(fact)).toBe(true);expect(Object.isFrozen(capture)).toBe(true)
  expect(()=> (managed as any).readAcknowledgedExecutionMembers({...fact},saved)).toThrow()
  expect(()=>fact.observe.call({...fact})).toThrow()
  expect(()=>{(fact as any).observe=()=>Promise.resolve(saved)}).toThrow()
  expect('registerCapture'in f.state).toBe(false)
})

it('a private replacement hydrates the original nonresident coverage and matches the full writer',async()=>{
  const events:SessionEvent[]=[{type:'user/message',text:'H',seq:0},{type:'assistant/message',text:'old',seq:1},{type:'user/message',text:'tail',seq:2}],f=await fixture(events)
  const captured=group({kind:'context-reduction',events:[{type:'compaction/replacement',version:1,replacementId:'private',text:'summary',coverage:[{item:{kind:'exchange',at:{seq:1,part:'message'}},sources:[{seq:1,part:'message'}]}],insertBefore:{kind:'exchange',at:{seq:1,part:'message'}}}]})
  const staged=await f.state.prepareWrite([captured]),full=createManagedSessionState({formatVersion:14,events:JSON.parse(JSON.stringify(events))},{sessionId:'owned'})
  const expected=full.stage((await import('../src/managed/groups.ts')).resolveFactGroup(captured,full.view,3))
  expect(staged.events).toEqual(expected.events);expect(f.reads).toEqual([1])
  const batch=encodeFactBatch('replacement',f.source.prefix.prefixDigest,staged.events)
  staged.beforeIssue(batch);staged.install(batch,f.receipt(batch));expect(f.state.eventCount).toBe(4)
})

it('observes restored private Code store and unfinished cells from the original validated stream',async()=>{
  const f=await fixture([
    {type:'code/cell',cellId:'done',sessionId:'owned',state:'started',seq:0},
    {type:'code/store',version:1,cellId:'done',sessionId:'owned',writes:[['x',7]],seq:1},
    {type:'code/cell',cellId:'done',sessionId:'owned',state:'completed',seq:2},
    {type:'code/cell',cellId:'open',sessionId:'owned',parentCallId:'call',state:'started',seq:3},
  ])
  const owner={ownsAction:()=>false,beginAction(){throw Error('unused')},registerReceivedInputSource(){throw Error('unused')},async drain(){},assertReady(){}}
  f.state.bindOwner(owner)
  const {createOwnerDeliveryControl}=await import('../src/managed/delivery-control.ts')
  createOwnerDeliveryControl(f.state.delivery,()=>f.state.eventCount)
  expect(f.state.observe().codeState()).toEqual({store:{kind:'value',entries:[['x',7]]},unfinished:[{cellId:'open',parentCallId:'call'}]})
})


it('updates private Code state only when the original live append is installed',async()=>{
  const f=await fixture([])
  const owner={ownsAction:()=>false,beginAction(){throw Error('unused')},registerReceivedInputSource(){throw Error('unused')},async drain(){},assertReady(){}}
  f.state.bindOwner(owner)
  const {createOwnerDeliveryControl}=await import('../src/managed/delivery-control.ts')
  createOwnerDeliveryControl(f.state.delivery,()=>f.state.eventCount)
  const captured=group({kind:'code',event:{type:'code/cell',cellId:'live',sessionId:'owned',state:'started'}})
  const prepared=await f.state.prepareWrite([captured])
  expect(f.state.observe().codeState().unfinished).toEqual([])
  const batch=encodeFactBatch('code-start',f.source.prefix.prefixDigest,prepared.events), receipt=f.receipt(batch)
  prepared.beforeIssue(batch);prepared.install(batch,receipt)
  expect(f.state.observe().codeState().unfinished).toEqual([{cellId:'live'}])
})

it('restored private Code store honors the original rewind window',async()=>{
  const events:any[]=[
    {type:'code/cell',cellId:'a',sessionId:'owned',state:'started',seq:0},
    {type:'code/store',version:1,cellId:'a',sessionId:'owned',writes:[['x',1]],seq:1},
    {type:'code/cell',cellId:'a',sessionId:'owned',state:'completed',seq:2},
    {type:'code/cell',cellId:'b',sessionId:'owned',state:'started',seq:3},
    {type:'code/store',version:1,cellId:'b',sessionId:'owned',writes:[['x',2]],seq:4},
    {type:'code/cell',cellId:'b',sessionId:'owned',state:'completed',seq:5},
    {type:'rewind/point',version:1,targetTurn:1,anchorSeq:3,mode:'conversation',fileOps:[],seq:6},
  ]
  const f=await fixture(events), owner={ownsAction:()=>false,beginAction(){throw Error('unused')},registerReceivedInputSource(){throw Error('unused')},async drain(){},assertReady(){}}
  f.state.bindOwner(owner)
  const {createOwnerDeliveryControl}=await import('../src/managed/delivery-control.ts')
  createOwnerDeliveryControl(f.state.delivery,()=>f.state.eventCount)
  expect(f.state.observe().codeState().store).toEqual({kind:'value',entries:[['x',1]]})
})
