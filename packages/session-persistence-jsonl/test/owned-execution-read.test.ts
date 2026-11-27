import {afterEach,expect,it,vi} from 'vitest'
import * as fs from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createOwnership} from '../../session-persistence/src/coordinator/ownership.ts'
import {heldFactOwner} from '../../session-persistence/src/coordinator/fact-owner.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {readArchiveHistoryPrefix} from '@i-harness/session-persistence/internal/archive-read'
import {openOwnedExecutionDependencies} from '../src/backend/owned-execution-read.ts'
import {encodeFactBatch,factPrefixDigest,type JournalPrefix} from '@i-harness/core-session'
const resumed=vi.hoisted(()=>[] as JournalPrefix[])
const restoration=vi.hoisted(()=>({
 original:undefined as undefined|{backend:object;proof:object;writer:import('@i-harness/session-persistence').HeldFactOwner},
}))
vi.mock('../../session-persistence/src/archive-read-internal.ts',async load=>{
 const actual=await load<typeof import('../../session-persistence/src/archive-read-internal.ts')>()
 return {...actual,readArchiveHistoryPrefix(backend:object,proof:object,writer?:import('@i-harness/session-persistence').HeldFactOwner){
  if(writer)restoration.original={backend,proof,writer}
  return actual.readArchiveHistoryPrefix(backend,proof,writer)
 }}
})
vi.mock('@i-harness/core-session/internal/archive',async load=>{
 const actual=await load<typeof import('@i-harness/core-session/internal/archive')>()
 return {...actual,createJournalStreamDecoder(...args:Parameters<typeof actual.createJournalStreamDecoder>){
  if(args[3]?.from)resumed.push(args[3].from)
  return actual.createJournalStreamDecoder(...args)
 }}
})
vi.mock('node:fs/promises',async load=>{const actual=await load<typeof import('node:fs/promises')>();return {...actual,open:vi.fn(actual.open),readFile:vi.fn(actual.readFile),stat:vi.fn(actual.stat)}})
const originalOpen=vi.mocked(fs.open).getMockImplementation()!
const originalStat=vi.mocked(fs.stat).getMockImplementation()!
afterEach(()=>{vi.mocked(fs.open).mockImplementation(originalOpen);vi.mocked(fs.stat).mockImplementation(originalStat);vi.mocked(fs.readFile).mockClear();resumed.length=0;restoration.original=undefined})
async function fixture(){
 const root=await fs.mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'owned-deps-')),backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'a'});coordinator.enqueue('a',[{type:'plan/mode',mode:'on'},{type:'plan/mode',mode:'off'}]);await coordinator.flush('a');await coordinator.close()
 const ownership=createOwnership(backend,{lock:{enabled:true}}),claim=await ownership.pinOwnership('a');let current=true
 const held=heldFactOwner({sessionId:'a',incarnation:'original-writer'},ownership,()=>{if(!current)throw Error('writer changed')})
 const prefix=await backend.readJournalPrefix!('a',held)
 return {root,backend,held,prefix,path:join(root,'a.jsonl'),invalidate(){current=false},async close(){await claim.release();await Promise.all(ownership.releaseHeldLocks());await fs.rm(root,{recursive:true,force:true})}}
}

async function restoredFixture(options?:Parameters<typeof createJsonlBackend>[1]){
 const root=await fs.mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'restored-deps-'))
 const backend=createJsonlBackend(root,options),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'a'})
 // A later page can select the second frame without reading the first body.
 await coordinator.append('a',[{type:'user/message',text:'earlier'}])
 await coordinator.append('a',[{type:'plan/mode',mode:'on'}])
 return {backend,coordinator,path:join(root,'a.jsonl'),async close(){try{await coordinator.close()}finally{await fs.rm(root,{recursive:true,force:true})}}}
}
const restoredPage={afterSeq:1,limit:1}

it.each(['held decoder','sealed cold handoff'] as const)('reuses only the coordinates of the original %s on its first dependency read',async source=>{
 const f=await restoredFixture()
 try{
  if(source==='sealed cold handoff')await f.coordinator.readHistoryPage!('a',restoredPage)
  const owner=await acquireManagedExecution(f.coordinator,'a')
  expect(resumed).toHaveLength(0)
  const before=restoration.original
  expect(before?.writer.owner.sessionId).toBe('a')
  expect(readArchiveHistoryPrefix(f.backend,{...before!.proof},before!.writer)).toEqual({kind:'unavailable'})
  expect(readArchiveHistoryPrefix(f.backend,before!.proof,before!.writer)).toEqual({kind:'unavailable'})
  let opens=0
  vi.mocked(fs.open).mockImplementation(async(...args)=>{if(args[0]===f.path)opens++;return originalOpen(...args)})
  await expect(f.coordinator.readHistoryPage!('a',restoredPage)).resolves.toMatchObject({headSeq:2,events:[{seq:1,type:'plan/mode',mode:'on'}]})
  expect(resumed).toMatchObject([{eventCount:2}])
  expect(opens).toBe(1)
  owner.observe().assertCurrent()
 }finally{await f.close()}
})

it.each(['header','unselected body'] as const)('checks the actual %s bytes before publishing any restored framing selection',async what=>{
 const f=await restoredFixture()
 try{
  await acquireManagedExecution(f.coordinator,'a')
  const raw=await fs.readFile(f.path,'utf8')
  const changed=what==='header'?raw.replace('"sessionId":"a"','"sessionId":"b"'):raw.replace('"text":"earlier"','"text":"changed"')
  expect(changed).not.toBe(raw)
  expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(raw))
  await fs.writeFile(f.path,changed)
  await expect(f.coordinator.readHistoryPage!('a',restoredPage)).rejects.toThrow('Owned dependency prefix mismatch')
  expect(resumed).toHaveLength(0)
 }finally{await f.close()}
})

it.each(['custom archive','opaque environment'] as const)('leaves the first dependency read unseeded with a %s',async kind=>{
 const options:Parameters<typeof createJsonlBackend>[1]=kind==='custom archive'?{wrap(backend){
  const read=backend.read.bind(backend);backend.read=id=>read(id)
 }}:undefined
 const f=await restoredFixture(options)
 try{
  await acquireManagedExecution(f.coordinator,'a')
  const parse=JSON.parse
  const opaque=kind==='opaque environment'?vi.spyOn(JSON,'parse').mockImplementation((text,reviver)=>parse(text,reviver)):undefined
  try{
   await expect(f.coordinator.readHistoryPage!('a',restoredPage)).resolves.toMatchObject({headSeq:2,events:[{seq:1,type:'plan/mode',mode:'on'}]})
   expect(resumed).toHaveLength(0)
  }finally{opaque?.mockRestore()}
 }finally{await f.close()}
})

it('verifies the complete prefix once for a batch and returns selected records in request order',async()=>{
 const f=await fixture();let opens=0,reads=0
 vi.mocked(fs.readFile).mockClear()
 vi.mocked(fs.open).mockImplementation(async(...args)=>{const h=await originalOpen(...args);if(args[0]===f.path){opens++;const read=h.read.bind(h);h.read=(async(...args:any[])=>{reads++;return (read as any)(...args)}) as typeof h.read}return h})
 const scope=openOwnedExecutionDependencies(f.backend,'a',f.held,f.prefix)
 expect(opens).toBe(0)
 try{expect(await scope.readEvents!([1,0])).toMatchObject([{seq:1,type:'plan/mode',mode:'off'},{seq:0,mode:'on'}]);expect(opens).toBe(1);expect(reads).toBe(1);expect(vi.mocked(fs.readFile).mock.calls.filter(args=>args[0]===f.path)).toEqual([])}finally{await scope.close();expect(()=>scope.assertCurrent()).toThrow();await f.close()}
})
it('opens a descriptor only after a nonempty dependency read starts',async()=>{
 const f=await fixture()
 let opened=0,closed=0
 const entered=Promise.withResolvers<void>(), release=Promise.withResolvers<void>()
 vi.mocked(fs.open).mockImplementation(async(...args)=>{
  if(args[0]!==f.path)return originalOpen(...args)
  opened++
  entered.resolve()
  await release.promise
  const handle=await originalOpen(...args),close=handle.close.bind(handle)
  handle.close=async()=>{closed++;await close()}
  return handle
 })
 const unused=openOwnedExecutionDependencies(f.backend,'a',f.held,f.prefix)
 const active=openOwnedExecutionDependencies(f.backend,'a',f.held,f.prefix)
 try {
  expect(await unused.readEvents!([])).toEqual([])
  expect(opened).toBe(0)
  const reading=active.readEvent(0)
  void reading.catch(()=>{})
  await entered.promise
  const closing=active.close()
  await unused.close()
  expect(opened).toBe(1)
  expect(closed).toBe(0)
  release.resolve()
  await expect(reading).rejects.toThrow('scope retired')
  await closing
  expect(closed).toBe(1)
 } finally {
  release.resolve()
  await unused.close()
  await active.close()
  await f.close()
 }
})
it('uses the same verified frame positions across scopes and extends them across a committed append',async()=>{
 const f=await fixture()
 const scope=openOwnedExecutionDependencies(f.backend,'a',f.held,f.prefix)
 try {
  await expect(scope.readEvent(0)).resolves.toMatchObject({seq:0,mode:'on'})
  await scope.close()
  const text='附加內容'.repeat(30)
  const batch=encodeFactBatch('index-test',f.prefix.prefixDigest,[{type:'user/message',text,seq:2}])
  const next={
   eventCount:f.prefix.eventCount+1,
   bodyBytes:f.prefix.bodyBytes+batch.bytes.length,
   prefixDigest:factPrefixDigest(f.prefix.prefixDigest,batch.key.batchDigest),
  }
  await fs.appendFile(f.path,batch.bytes)
  vi.mocked(fs.open).mockImplementation(async(...args)=>{
   const handle=await originalOpen(...args)
   if(args[0]===f.path) {
    const read=handle.read.bind(handle)
    handle.read=((buffer:Buffer,offset:number,length:number,position:number)=>
     read(buffer,offset,Math.min(length,19),position)) as typeof handle.read
   }
   return handle
  })
  const appended=openOwnedExecutionDependencies(f.backend,'a',f.held,next)
  try {
   expect(await appended.readEvents!([2,0,1])).toMatchObject([{seq:2,text},{seq:0,mode:'on'},{seq:1,mode:'off'}])
   expect(await appended.readEvent(2)).toMatchObject({seq:2,text})
   expect(resumed).toEqual([f.prefix,next])
  } finally {await appended.close()}
 } finally {await scope.close();await f.close()}
})
it('rejects a same-size change outside the requested frame after indexing the prefix',async()=>{
 const f=await fixture()
 const batch=encodeFactBatch('unselected-test',f.prefix.prefixDigest,[{type:'user/message',text:'untouched',seq:2}])
 const prefix={
  eventCount:f.prefix.eventCount+1,
  bodyBytes:f.prefix.bodyBytes+batch.bytes.length,
  prefixDigest:factPrefixDigest(f.prefix.prefixDigest,batch.key.batchDigest),
 }
 await fs.appendFile(f.path,batch.bytes)
 const original=openOwnedExecutionDependencies(f.backend,'a',f.held,prefix)
 try {
  await original.readEvent(0)
  await original.close()
  const bytes=await fs.readFile(f.path,'utf8')
  const changed=bytes.replace('"untouched"','"corrupted"')
  expect(changed).not.toBe(bytes)
  expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(bytes))
  await fs.writeFile(f.path,changed)
  const reading=openOwnedExecutionDependencies(f.backend,'a',f.held,prefix)
  try {await expect(reading.readEvent(0)).rejects.toThrow('Owned dependency prefix mismatch')}
  finally {await reading.close()}
 } finally {await original.close();await f.close()}
})
it('keeps its opened extent fixed and rejects a concurrent append rather than adopting a new prefix',async()=>{
 const f=await fixture();let changed=false
 vi.mocked(fs.open).mockImplementation(async(...args)=>{const h=await originalOpen(...args);if(args[0]===f.path){const read=h.read.bind(h);h.read=(async(...args:any[])=>{if(!changed){changed=true;await fs.appendFile(f.path,'late partial frame')}return (read as any)(...args)}) as typeof h.read}return h})
 const scope=openOwnedExecutionDependencies(f.backend,'a',f.held,f.prefix)
 try{await expect(scope.readEvent(0)).rejects.toThrow('archive changed')}finally{await scope.close();await f.close()}
})
it('refuses distinct original descriptor/path inode identities which collide as Numbers',async()=>{
 const f=await fixture(),originalInode=9007199254740992n,replacementInode=9007199254740993n,pathModes:boolean[]=[]
 expect(originalInode).not.toBe(replacementInode);expect(Number(originalInode)).toBe(Number(replacementInode))
 vi.mocked(fs.open).mockImplementation(async(...args)=>{const h=await originalOpen(...args);if(args[0]===f.path){const stat=h.stat.bind(h);h.stat=(async(options:any)=>{const actual=await stat(options);Object.defineProperty(actual,'ino',{value:options?.bigint?originalInode:Number(originalInode)});return actual}) as typeof h.stat}return h})
 vi.mocked(fs.stat).mockImplementation((async(...args:any[])=>{const actual=await (originalStat as any)(...args);if(args[0]===f.path){pathModes.push(args[1]?.bigint===true);Object.defineProperty(actual,'ino',{value:args[1]?.bigint?replacementInode:Number(replacementInode)})}return actual}) as typeof fs.stat)
 const scope=openOwnedExecutionDependencies(f.backend,'a',f.held,f.prefix)
 try{await expect(scope.readEvent(0)).rejects.toThrow('archive changed');expect(pathModes).toEqual([true])}finally{await scope.close();await f.close()}
})
it('does not hide a complete invalid later frame when reading an earlier dependency',async()=>{
 const f=await fixture();await fs.appendFile(f.path,'{"recordKind":"session/fact-batch","version":1}\n')
 const scope=openOwnedExecutionDependencies(f.backend,'a',f.held,f.prefix)
 try{await expect(scope.readEvents!([0,1])).rejects.toThrow()}finally{await scope.close();await f.close()}
})
it('retains consumed close uncertainty and never retries a no-op as successful cleanup',async()=>{
 const f=await fixture();let closes=0
 vi.mocked(fs.open).mockImplementation(async(...args)=>{const h=await originalOpen(...args);if(args[0]===f.path){const close=h.close.bind(h);h.close=async()=>{closes++;await close();throw null}}return h})
 const scope=openOwnedExecutionDependencies(f.backend,'a',f.held,f.prefix)
 try{await scope.readEvent(0);await expect(scope.close()).rejects.toBeNull();await expect(scope.close()).rejects.toBeNull();expect(closes).toBe(1);expect(()=>openOwnedExecutionDependencies(f.backend,'a',f.held,f.prefix)).toThrow()}finally{await f.close()}
})
it('qualifies the actual birth on tracked original stage handles and retains their cleanup debt',async()=>{
 const root=await fs.mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'owned-birth-'))
 const name='target.jsonl.bootstrap-64c3bd709617798d612a7e7b5831888c178148516deef8e5d9a9cda46ef6f400.stage'
 for(const file of ['target.jsonl',name])await fs.copyFile(join(import.meta.dirname,'fixtures/bootstrap13-public',file),join(root,file))
 const backend=createJsonlBackend(root),ownership=createOwnership(backend,{lock:{enabled:true}}),claim=await ownership.pinOwnership('target'),held=heldFactOwner({sessionId:'target',incarnation:'birth-writer'},ownership,()=>{})
 const prefix=await backend.readJournalPrefix!('target',held);let fault=true,opens=0,closes=0
 vi.mocked(fs.open).mockImplementation(async(...args)=>{const h=await originalOpen(...args);if(args[0]===join(root,name)){opens++;const close=h.close.bind(h);h.close=async()=>{closes++;if(fault)throw 0;return close()}}return h})
 const scope=openOwnedExecutionDependencies(backend,'target',held,prefix)
 try{await expect(scope.readEvent(0)).rejects.toThrow();await expect(scope.close()).rejects.toThrow('cleanup');expect(opens).toBe(1);expect(()=>openOwnedExecutionDependencies(backend,'target',held,prefix)).toThrow('birth cleanup');fault=false;await scope.close();expect(closes).toBeGreaterThan(1);expect(opens).toBe(1);const next=openOwnedExecutionDependencies(backend,'target',held,prefix);try{expect(await next.readEvent(0)).toMatchObject({type:'session/bootstrap',seq:0})}finally{await next.close()}}finally{fault=false;await scope.close();await claim.release();await Promise.all(ownership.releaseHeldLocks());await fs.rm(root,{recursive:true,force:true})}
})
it('refuses copied backend/owner and mismatching original prefix without granting authority',async()=>{
 const f=await fixture()
 try{expect(()=>openOwnedExecutionDependencies({...f.backend},'a',f.held,f.prefix)).toThrow();expect(()=>openOwnedExecutionDependencies(f.backend,'a',{...f.held},f.prefix)).toThrow();const scope=openOwnedExecutionDependencies(f.backend,'a',f.held,{...f.prefix,prefixDigest:'f'.repeat(64)});await expect(scope.readEvent(0)).rejects.toThrow();await scope.close()}finally{await f.close()}
})
it('refuses source change during an awaited positional read and still closes its acquired handle',async()=>{
 const f=await fixture();let closes=0
 vi.mocked(fs.open).mockImplementation(async(...args)=>{const h=await originalOpen(...args);if(args[0]===f.path){const read=h.read.bind(h),close=h.close.bind(h);h.read=(async(...args:any[])=>{const result=await (read as any)(...args);f.invalidate();return result}) as typeof h.read;h.close=async()=>{closes++;return close()}}return h})
 const scope=openOwnedExecutionDependencies(f.backend,'a',f.held,f.prefix)
 try{await expect(scope.readEvent(0)).rejects.toThrow('writer changed');await scope.close();expect(closes).toBe(1)}finally{await f.close()}
})
it('preserves falsey primary and original close debt, refusing replacement until exact retry',async()=>{
 const f=await fixture();let fault=true,closes=0
 vi.mocked(fs.open).mockImplementation(async(...args)=>{const h=await originalOpen(...args);if(args[0]===f.path){const close=h.close.bind(h);h.read=(async()=>{throw undefined}) as typeof h.read;h.close=async()=>{closes++;if(fault)throw false;return close()}}return h})
 const scope=openOwnedExecutionDependencies(f.backend,'a',f.held,f.prefix)
 try{await expect(scope.readEvent(0)).rejects.toBeUndefined();await expect(scope.close()).rejects.toBe(false);expect(()=>openOwnedExecutionDependencies(f.backend,'a',f.held,f.prefix)).toThrow();fault=false;await scope.close();expect(closes).toBe(2)}finally{fault=false;await scope.close();await f.close()}
})
