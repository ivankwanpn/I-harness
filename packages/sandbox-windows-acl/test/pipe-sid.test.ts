import { beforeEach, expect, it, vi } from 'vitest'
const n=vi.hoisted(()=>({next:100n,expectedSid:100n,live:new Map<bigint,{domain:string;bytes:Buffer}>(),calls:0,freed:[] as bigint[],localFreed:[] as bigint[],decodes:[] as string[],bindings:[] as any[],issue:undefined as undefined|((slot:bigint)=>number),lastError:undefined as undefined|(()=>number),free:undefined as undefined|((p:bigint)=>bigint|null),pointerFailure:false,charFailure:false,charValue:undefined as unknown,allocFailure:false,encodeFailure:false,decodeHook:undefined as undefined|(()=>void),encodeHook:undefined as undefined|(()=>void)}))
vi.mock('koffi',async original=>{const actual=await original<any>();const koffiSize=(t:any)=>actual.default.sizeof(t);return {...actual,default:{...actual.default,
  alloc:(type:any,length:number)=>{if(n.allocFailure)throw null;const p=n.next++;n.live.set(p,{domain:'heap',bytes:Buffer.alloc(koffiSize(type)*length,0xaa)});return p},
  free:(p:bigint)=>{expect(n.live.get(p)?.domain).toBe('heap');n.freed.push(p);n.live.delete(p)},
  encode:(p:bigint,_type:unknown,value:bigint|null)=>{if(n.encodeFailure)throw undefined;const b=n.live.get(p)!.bytes;if(_type==='uint32')b.writeUInt32LE(Number(value??0));else b.writeBigUInt64LE(BigInt(value??0));n.encodeHook?.()},
  decode:(p:bigint|Buffer,type:unknown,length?:number)=>{
    if(Buffer.isBuffer(p))return p.readBigUInt64LE(typeof type==='number'?type:0)||null
    const allocation=n.live.get(p);if(!allocation){n.decodes.push('stale');throw Error('stale native read')}
    if(type==='uint32')return allocation.bytes.readUInt32LE()
    if(type==='str16'){n.decodes.push('wrong-pointer-level');throw Error('unsafe extra pointer dereference rejected by fixture')}
    if(type==='char16'){n.decodes.push('characters');expect(length).toBe(-1);if(n.charFailure)throw false;n.decodeHook?.();if(n.charValue!==undefined)return n.charValue;return allocation.bytes.toString('utf16le').split('\0')[0]}
    n.decodes.push('pointer');if(n.pointerFailure){n.pointerFailure=false;throw undefined}return allocation.bytes.readBigUInt64LE()||null
  },
  load:()=>({func:(abi:unknown,name:string,result:unknown,args:unknown[])=>{n.bindings.push({abi,name,result,args});return ()=>1}}),
}}})
import koffi from 'koffi'
import { findLogonSid } from '../src/token.ts'
import { NativeInitOwner } from '../src/init-owner.ts'
import { logonSidText } from '../src/pipe-sid.ts'
import { win32,type NativePtr,type Win32Bindings } from '../src/ffi.ts'
const sid=100n as NativePtr,text='S-1-5-5-123-456',out=200n as NativePtr
beforeEach(()=>{n.next=100n;n.expectedSid=100n;n.live.clear();n.calls=0;n.freed=[];n.localFreed=[];n.decodes=[];n.bindings=[];n.issue=undefined;n.lastError=undefined;n.free=undefined;n.pointerFailure=false;n.charFailure=false;n.charValue=undefined;n.allocFailure=false;n.encodeFailure=false;n.decodeHook=undefined;n.encodeHook=undefined})
function publish(slot:bigint,value=text){n.live.set(out,{domain:'local',bytes:Buffer.from(value+'\0','utf16le')});n.live.get(slot)!.bytes.writeBigUInt64LE(out)}
function setup(){const api={
  convertSidToStringSidW(input:bigint,slot:bigint){n.calls++;expect(this).toBe(api);expect(input).toBe(n.expectedSid);expect(n.live.get(input)?.domain).toBe('heap');expect(n.live.get(slot)?.domain).toBe('heap');expect(n.live.get(slot)!.bytes.readBigUInt64LE()).toBe(0n);if(n.issue)return n.issue(slot);publish(slot);return 1},
  localFree(p:bigint){expect(this).toBe(api);expect(n.live.get(p)?.domain).toBe('local');n.localFreed.push(p);if(n.free)return n.free(p);n.live.delete(p);return null},
  getLastError(){expect(this).toBe(api);return n.lastError?n.lastError():0xfedcba98},formatMessageW(){return 0},
} as unknown as Win32Bindings;const owner=new NativeInitOwner(api);expect(owner.bytes(12)).toBe(sid);return {api,owner}}
function thrown(action:()=>unknown){try{action();throw Error('expected failure')}catch(e){return e}}
it('copies actual NUL UTF16 characters from original output, using the correct allocator pair',()=>{
  const {owner}=setup();const result=logonSidText(owner,sid);expect(result).toBe(text);expect(n.decodes).toEqual(['pointer','characters']);expect(n.localFreed).toEqual([out]);expect(n.live.has(out)).toBe(false);owner.cleanup();owner.cleanup();expect(n.freed).toEqual([101n,100n]);expect(result).toBe(text);expect(n.calls).toBe(1)
})
it('binds stdcall BOOL and two pointer-width native arguments',async()=>{
  await win32();const b=n.bindings.find(b=>b.name==='ConvertSidToStringSidW');expect(b.abi).toBe('__stdcall');expect(b.result).toBe('int');expect(b.args).toHaveLength(2);expect(b.args.map((t:any)=>koffi.sizeof(t))).toEqual([8,8])
})
it('known BOOL zero retains exact Win32 identity and skips even a published failed output',()=>{
  const {owner}=setup();n.issue=slot=>{publish(slot);return 0};const e=thrown(()=>logonSidText(owner,sid));expect(e).toMatchObject({api:'ConvertSidToStringSidW',win32Code:0xfedcba98});owner.cleanup();expect(n.localFreed).toEqual([]);expect(n.freed).toEqual([101n,100n]);expect(n.calls).toBe(1)
})
it('known FALSE stays failed when error retrieval throws falsey',()=>{
  const {owner}=setup();n.issue=()=>0;n.lastError=()=>{throw undefined};expect(thrown(()=>logonSidText(owner,sid))).toBeUndefined();owner.cleanup();expect(n.freed).toEqual([101n,100n]);expect(n.localFreed).toEqual([]);expect(n.calls).toBe(1)
})
it.each([undefined,null,false,0,''])('pins null unknown output for falsey issue exception %j',cause=>{
  const {owner}=setup();n.issue=()=>{throw cause};expect(thrown(()=>logonSidText(owner,sid))).toBe(cause);expect(()=>owner.cleanup()).toThrow();expect(()=>owner.cleanup()).toThrow();expect(n.calls).toBe(1);expect(n.freed).toEqual([]);expect(n.localFreed).toEqual([])
})
it.each([undefined,null,false])('recovers original published output after falsey issue exception %j',cause=>{
  const {owner}=setup();n.issue=slot=>{publish(slot);throw cause};expect(thrown(()=>logonSidText(owner,sid))).toBe(cause);owner.cleanup();owner.cleanup();expect(n.calls).toBe(1);expect(n.localFreed).toEqual([out]);expect(n.freed).toEqual([101n,100n])
})
it.each([NaN,undefined,true,0x80000000])('does not accept malformed native BOOL %j',result=>{
  const {owner}=setup();n.issue=slot=>{publish(slot);return result as number};expect(()=>logonSidText(owner,sid)).toThrow();owner.cleanup();expect(n.calls).toBe(1);expect(n.localFreed).toEqual([out])
})
it('retries only original pointer recovery after success followed by falsey pointer decode failure',()=>{
  const {owner}=setup();n.pointerFailure=true;expect(thrown(()=>logonSidText(owner,sid))).toBeUndefined();owner.cleanup();expect(n.calls).toBe(1);expect(n.localFreed).toEqual([out]);expect(n.freed).toEqual([101n,100n])
})
it('keeps same LocalAlloc output after falsey character decode failure',()=>{
  const {owner}=setup();n.charFailure=true;expect(thrown(()=>logonSidText(owner,sid))).toBe(false);owner.cleanup();expect(n.calls).toBe(1);expect(n.localFreed).toEqual([out]);expect(n.freed).toEqual([101n,100n])
})
it.each(['','S-1-5-18','S-1-5-5-a-2',42])('rejects invalid logon text %j while retaining cleanup',value=>{
  const {owner}=setup();n.charValue=value;expect(()=>logonSidText(owner,sid)).toThrow();owner.cleanup();expect(n.calls).toBe(1);expect(n.localFreed).toEqual([out])
})
it('pins a successful null output without inventing a LocalAlloc address',()=>{
  const {owner}=setup();n.issue=()=>1;expect(()=>logonSidText(owner,sid)).toThrow();expect(()=>owner.cleanup()).toThrow();expect(n.calls).toBe(1);expect(n.freed).toEqual([]);expect(n.localFreed).toEqual([])
})
it.each([false,true])('known LocalFree refusal retries on original owner, reporting throws=%s',reportThrow=>{
  const {owner}=setup();n.free=p=>p;if(reportThrow)n.lastError=()=>{throw null};const e=thrown(()=>logonSidText(owner,sid));if(reportThrow)expect(e).toBeNull();else expect(e).toMatchObject({api:'LocalFree',win32Code:0xfedcba98});expect(n.live.has(101n)).toBe(true);n.free=undefined;owner.cleanup();owner.cleanup();expect(n.localFreed).toEqual([out,out]);expect(n.calls).toBe(1);expect(n.freed).toEqual([101n,100n])
})
it('pins consumed LocalFree on same owner without touching a reused address',()=>{
  const {owner}=setup();n.free=p=>{n.live.delete(p);throw undefined};expect(()=>logonSidText(owner,sid)).toThrow();n.live.set(out,{domain:'local',bytes:Buffer.from('replacement\0','utf16le')});expect(()=>owner.cleanup()).toThrow();expect(()=>owner.transfer(out)).toThrow();expect(n.localFreed).toEqual([out]);expect(n.freed).toEqual([]);expect(n.live.get(out)?.bytes.toString('utf16le')).toBe('replacement\0');expect(n.calls).toBe(1)
})
it.each(['allocation','initialization'] as const)('retains original partial slot %s debt',step=>{
  const {owner}=setup();n.allocFailure=step==='allocation';n.encodeFailure=step==='initialization';expect(()=>logonSidText(owner,sid)).toThrow();owner.cleanup();expect(n.calls).toBe(0);expect(n.localFreed).toEqual([]);expect(n.freed).toEqual(step==='allocation'?[100n]:[101n,100n])
})
it('refuses conversion if retirement happens during slot initialization',()=>{
  const {owner}=setup();n.encodeHook=()=>owner.cleanup();expect(()=>logonSidText(owner,sid)).toThrow();expect(n.calls).toBe(0);expect(n.decodes).toEqual([]);expect(n.freed).toEqual([101n,100n])
})
it('refuses stale pointer read when conversion retires its original owner before return',()=>{
  const {owner}=setup();n.issue=slot=>{publish(slot);owner.cleanup();return 1};expect(()=>logonSidText(owner,sid)).toThrow();expect(n.decodes).toEqual(['pointer']);expect(n.calls).toBe(1);expect(n.localFreed).toEqual([out]);expect(n.freed).toEqual([101n,100n])
})
it('refuses successful return from a character decode session retired during decode',()=>{
  const {owner}=setup();n.decodeHook=()=>owner.cleanup();expect(()=>logonSidText(owner,sid)).toThrow();expect(n.calls).toBe(1);expect(n.localFreed).toEqual([out]);expect(n.freed).toEqual([101n,100n])
})

it('refuses another conversion using an acknowledged retired original SID',()=>{
  const {owner}=setup();owner.release(sid,'heap');const next=n.next;expect(()=>logonSidText(owner,sid)).toThrow();expect(n.calls).toBe(0);expect(n.next).toBe(next);owner.cleanup();expect(n.freed).toEqual([sid])
})
it('refuses another conversion using an unknown-consumed SID even if its address is reused',()=>{
  const {owner}=setup();const free=koffi.free;vi.spyOn(koffi,'free').mockImplementationOnce((p:any)=>{free(p);throw undefined});expect(()=>owner.release(sid,'heap')).toThrow();n.live.set(sid,{domain:'heap',bytes:Buffer.alloc(12)});const next=n.next;expect(()=>logonSidText(owner,sid)).toThrow();expect(n.next).toBe(next);expect(n.calls).toBe(0);expect(()=>owner.cleanup()).toThrow();expect(n.freed).toEqual([sid]);expect(n.live.has(sid)).toBe(true)
})
it('retains known failure cleanup even when formatted diagnostics throw falsey',()=>{
  const {api,owner}=setup();n.issue=()=>0;api.formatMessageW=()=>{throw false};expect(thrown(()=>logonSidText(owner,sid))).toBe(false);owner.cleanup();expect(n.calls).toBe(1);expect(n.localFreed).toEqual([]);expect(n.freed).toEqual([101n,100n])
})

it('rejects ambiguous same-owner heap address reuse instead of authenticating pointer equality',()=>{
  const {owner}=setup();owner.release(sid,'heap');vi.spyOn(koffi,'alloc').mockImplementationOnce(()=>{n.live.set(sid,{domain:'heap',bytes:Buffer.alloc(12)});return sid as any});owner.bytes(12);expect(()=>logonSidText(owner,sid)).toThrow('ambiguous');expect(n.calls).toBe(0);owner.cleanup();expect(n.freed).toEqual([sid,sid])
})
it('accepts the actual findLogonSid allocation on the original init owner without a child-scope lookup',()=>{
  const {api,owner}=setup();api.getTokenInformation=(_token,cls,groups,_size,needed)=>{expect(cls).toBe(2);n.live.get(needed)!.bytes.writeUInt32LE(24);if(!groups)return 0;groups.writeUInt32LE(1,0);groups.writeBigUInt64LE(77n,8);groups.writeUInt32LE(0xc0000000,16);return 1};api.getLengthSid=()=>12;api.copySid=(size,dest,source)=>{expect(size).toBe(12);expect(source).toBe(77n);expect(n.live.get(dest)?.bytes.length).toBe(12);return 1}
  const copied=findLogonSid(api,55n as NativePtr,owner);expect(copied).toBe(102n);n.expectedSid=copied;expect(logonSidText(owner,copied)).toBe(text);owner.cleanup();expect(n.calls).toBe(1);expect(n.localFreed).toEqual([out]);expect(n.freed).toEqual([103n,102n,101n,100n])
})
