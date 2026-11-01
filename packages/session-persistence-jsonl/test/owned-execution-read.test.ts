import {afterEach,expect,it,vi} from 'vitest'
import * as fs from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createOwnership} from '../../session-persistence/src/coordinator/ownership.ts'
import {heldFactOwner} from '../../session-persistence/src/coordinator/fact-owner.ts'
import {openOwnedExecutionDependencies} from '../src/backend/owned-execution-read.ts'
vi.mock('node:fs/promises',async load=>{const actual=await load<typeof import('node:fs/promises')>();return {...actual,open:vi.fn(actual.open),readFile:vi.fn(actual.readFile),stat:vi.fn(actual.stat)}})
const originalOpen=vi.mocked(fs.open).getMockImplementation()!
const originalStat=vi.mocked(fs.stat).getMockImplementation()!
afterEach(()=>{vi.mocked(fs.open).mockImplementation(originalOpen);vi.mocked(fs.stat).mockImplementation(originalStat);vi.mocked(fs.readFile).mockClear()})
async function fixture(){
 const root=await fs.mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'owned-deps-')),backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'a'});coordinator.enqueue('a',[{type:'plan/mode',mode:'on'},{type:'plan/mode',mode:'off'}]);await coordinator.flush('a');await coordinator.close()
 const ownership=createOwnership(backend,{lock:{enabled:true}}),claim=await ownership.pinOwnership('a');let current=true
 const held=heldFactOwner({sessionId:'a',incarnation:'original-writer'},ownership,()=>{if(!current)throw Error('writer changed')})
 const prefix=await backend.readJournalPrefix!('a',held)
 return {root,backend,held,prefix,path:join(root,'a.jsonl'),invalidate(){current=false},async close(){await claim.release();await Promise.all(ownership.releaseHeldLocks());await fs.rm(root,{recursive:true,force:true})}}
}
it('registers synchronously and reads selected dependencies on one original descriptor without public replay',async()=>{
 const f=await fixture();let opens=0
 vi.mocked(fs.readFile).mockClear()
 vi.mocked(fs.open).mockImplementation(async(...args)=>{if(args[0]===f.path)opens++;return originalOpen(...args)})
 const scope=openOwnedExecutionDependencies(f.backend,'a',f.held,f.prefix)
 expect(opens).toBe(0)
 try{expect(await scope.readEvent(1)).toMatchObject({seq:1,type:'plan/mode',mode:'off'});expect(await scope.readEvent(0)).toMatchObject({seq:0,mode:'on'});expect(opens).toBe(1);expect(vi.mocked(fs.readFile).mock.calls.filter(args=>args[0]===f.path)).toEqual([])}finally{await scope.close();expect(()=>scope.assertCurrent()).toThrow();await f.close()}
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
 try{await expect(scope.readEvent(0)).rejects.toThrow()}finally{await scope.close();await f.close()}
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
