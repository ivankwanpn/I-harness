import { expect, it, vi } from 'vitest'
import { win32 as path } from 'node:path'

type Dir = { id: number; sensitive: boolean; final: string; attributes?: number; policy?: number; identity?: Buffer }
function fixture() {
  const directories = new Map<string, Dir>([
    ['C:\\', {id:99,sensitive:false,final:'\\Device\\Volume\\'}],
    ['C:\\store', { id: 1, sensitive: false, final: '\\Device\\Volume\\store' }],
    ['C:\\store\\Mixed', { id: 2, sensitive: true, final: '\\Device\\Volume\\store\\Mixed' }],
    ['C:\\store\\short', { id: 3, sensitive: false, final: '\\Device\\Volume\\store\\Long Directory' }],
    ['C:\\store\\Long Directory', { id: 3, sensitive: false, final: '\\Device\\Volume\\store\\Long Directory' }],
  ])
  const handles = new Map<bigint, Dir>(), calls: string[] = []
  let next = 1n, error = 0, closeFailure = false, foldCalls = 0
  const closes:bigint[]=[]
  const api = {
    createFileW(name: string, access: number, share: number, attributes: null, disposition: number, flags: number, template: null): bigint | null {
      expect([access, share, attributes, disposition, flags, template]).toEqual([0x80, 7, null, 3, 0x02200000, null])
      calls.push(name)
      const dir = directories.get(name)
      if (!dir) { error = 3; return -1n }
      const handle = next++; handles.set(handle, { ...dir }); return handle
    },
    getLastError() { return error },
    getFileInformationByHandleEx(handle: bigint, kind: number, data: Buffer, size: number) {
      expect([...data]).toEqual(Array(size).fill(0))
      const dir = handles.get(handle)!
      if (kind === 18) { expect(size).toBe(24); data.writeBigUInt64LE(0xf000000000000001n, 0); data.writeUInt32LE(dir.id, 8); if(dir.identity)dir.identity.copy(data,8) }
      else if (kind === 23) { expect(size).toBe(4); data.writeUInt32LE(dir.policy ?? (dir.sensitive ? 1 : 0)) }
      else { expect([kind, size]).toEqual([9, 8]); data.writeUInt32LE(dir.attributes ?? 0x10) }
      return 1
    },
    getFinalPathNameByHandleW(handle: bigint, data: Buffer, units: number, flags: number) {
      expect(flags).toBe(2)
      const value = handles.get(handle)!.final
      if (units <= value.length) return value.length + 1
      data.write(value + '\0', 'utf16le'); return value.length
    },
    lcMapStringEx(locale: string, flags: number, value: string, count: number, output: Buffer | null, capacity: number, version: null, reserved: null, param: bigint) {
      expect([locale, flags, count, version, reserved, param]).toEqual(['', 0x200, value.length, null, null, 0n])
      foldCalls++
      const mapped = value.replace(/[a-z]/g, char => String.fromCharCode(char.charCodeAt(0) - 32))
      if (!output) { expect(capacity).toBe(0); return mapped.length }
      expect(capacity).toBe(mapped.length); output.write(mapped, 'utf16le'); return mapped.length
    },
    closeHandle(handle: bigint): number {
      closes.push(handle)
      if (closeFailure) { closeFailure = false; error = 5; return 0 }
      expect(handles.delete(handle)).toBe(true); return 1
    },
  }
  return { directories, handles, calls, closes, api, setError(value:number){error=value}, setNext(value:bigint){next=value}, failClose() { closeFailure = true }, folds: () => foldCalls }
}

async function implementation() {
  const module = await import('../src/win32-artifact-path.ts').catch(() => undefined)
  expect(module?.createWin32ArtifactPathOwnerWithApi).toBeTypeOf('function')
  return module!.createWin32ArtifactPathOwnerWithApi
}

it('keeps injected native APIs immediate when checks share an artifact batch', async () => {
  const create = await implementation(), f = fixture(), owner = create('C:\\store', f.api)
  const a = owner.capture('C:\\store\\a.jsonl'), b = owner.capture('C:\\store\\b.jsonl')
  f.calls.length = 0
  const { checkWin32ArtifactPaths } = await import('../src/win32-artifact-path.ts')
  checkWin32ArtifactPaths([{ capture: a, method: a.assertCurrent }, { capture: b, method: b.assertCurrent }])
  expect(f.calls).toEqual(['C:\\store', 'C:\\store', 'C:\\store', 'C:\\store'])
  expect(f.handles.size).toBe(0)
})

it('uses actual directory ID, policy and exact UTF16 leaf rather than a globally folded path', async () => {
  const create = await implementation(), f = fixture(), owner = create('C:\\store', f.api)
  const lower = owner.capture('C:\\store\\name.doc.jsonl'), upper = owner.capture('C:\\store\\NAME.doc.jsonl')
  expect(lower.kind).toBe('ready'); expect(upper.kind === 'ready' && upper.key).toBe(lower.kind === 'ready' && lower.key)
  const before = f.folds()
  const sensitive = owner.capture('C:\\store\\Mixed\\name.doc.jsonl'), other = owner.capture('C:\\store\\Mixed\\NAME.doc.jsonl')
  expect(sensitive.kind === 'ready' && sensitive.key).not.toBe(other.kind === 'ready' && other.key)
  expect(f.folds()).toBe(before)
  const long = owner.capture('C:\\store\\Long Directory\\name.doc.jsonl')
  expect(long.kind).toBe('ready')
  expect(owner.capture('C:\\store\\short\\name.doc.jsonl')).toMatchObject({ key: long.kind === 'ready' ? long.key : undefined })
  expect(f.handles.size).toBe(0)
  expect(lower.kind === 'ready' && lower.key).toContain('01000000000000f0')
})

it('returns no final key before actual parents exist and recaptures their actual policy', async () => {
  const create = await implementation(), f = fixture(), owner = create('C:\\store', f.api)
  const pending = owner.capture('C:\\store\\missing\\name.doc.jsonl')
  expect(pending.kind).toBe('needs-parents'); expect('key' in pending).toBe(false)
  f.directories.set('C:\\store\\missing', { id: 4, sensitive: true, final: '\\Device\\Volume\\store\\missing' })
  const next = owner.capture('C:\\store\\missing\\name.doc.jsonl')
  expect(next.kind).toBe('ready')
  expect(next.kind === 'ready' && next.key).toContain(':S:')
  expect(f.handles.size).toBe(0)
})

it('invalidates replaced roots and changed directory policy without retargeting a capture', async () => {
  const create = await implementation(), f = fixture(), owner = create('C:\\store', f.api)
  const capture = owner.capture('C:\\store\\Mixed\\name.doc.jsonl')
  capture.assertCurrent()
  f.directories.get('C:\\store\\Mixed')!.sensitive = false
  expect(() => capture.assertCurrent()).toThrow()
  f.directories.get('C:\\store')!.id = 9
  expect(() => owner.capture('C:\\store\\name.doc.jsonl')).toThrow()
  expect(f.handles.size).toBe(0)
})

it('retains failed original cleanup and refuses capture success until explicit settlement', async () => {
  const create = await implementation(), f = fixture(), owner = create('C:\\store', f.api)
  f.failClose()
  expect(() => owner.capture('C:\\store\\name.doc.jsonl')).toThrow()
  expect(f.handles.size).toBe(1)
  const before = f.calls.length
  expect(() => owner.capture('C:\\store\\name.doc.jsonl')).toThrow()
  expect(f.calls.length).toBe(before)
  owner.settleResources()
  expect(f.handles.size).toBe(0)
  expect(owner.capture(path.join('C:\\store', 'name.doc.jsonl')).kind).toBe('ready')
})

it('never treats a missing bound root or unproved root spelling as directory-creation permission', async () => {
  const create = await implementation(), f = fixture(), owner = create('C:\\store', f.api)
  const value = owner.capture('C:\\store\\name.doc.jsonl')
  expect(() => owner.capture('C:\\STORE\\name.doc.jsonl')).toThrow()
  f.directories.delete('C:\\store')
  expect(() => owner.capture('C:\\store\\name.doc.jsonl')).toThrow()
  expect(() => value.assertCurrent()).toThrow()
  f.directories.set('C:\\store', { id: 1, sensitive: false, final: '\\Device\\Volume\\store' })
  expect(() => value.assertCurrent()).toThrow()
  expect(f.handles.size).toBe(0)
})

it('rejects borrowed owner and capture methods before native work', async () => {
  const create = await implementation(), f = fixture(), owner = create('C:\\store', f.api)
  const value = owner.capture('C:\\store\\name.doc.jsonl'), before = f.calls.length
  expect(() => owner.capture.call({} as typeof owner, 'C:\\store\\name.doc.jsonl')).toThrow()
  expect(() => owner.settleResources.call({} as typeof owner)).toThrow()
  expect(() => value.assertCurrent.call({} as typeof value)).toThrow()
  expect(f.calls.length).toBe(before)
  value.assertCurrent()
})

it('retains a consuming close acknowledgment before fallible ledger bookkeeping', async () => {
  const create = await implementation(), f = fixture(), owner = create('C:\\store', f.api)
  const original = Set.prototype.delete
  let failed = false
  Set.prototype.delete = function (value: unknown) {
    if (!failed && value && typeof value === 'object' && 'closed' in value && value.closed === true) {
      failed = true
      throw new Error('ledger bookkeeping failure')
    }
    return Reflect.apply(original, this, [value])
  }
  try { expect(() => owner.capture('C:\\store\\name.doc.jsonl')).toThrow('ledger bookkeeping failure') }
  finally { Set.prototype.delete = original }
  expect(f.handles.size).toBe(0)
  owner.settleResources()
  expect(owner.capture('C:\\store\\name.doc.jsonl').kind).toBe('ready')
})

it('missing unbound root yields only original-root intent with known ancestor evidence',async()=>{
  const create=await implementation(),f=fixture();f.directories.delete('C:\\store');f.directories.set('C:\\parent',{id:8,sensitive:true,final:'\\Device\\Volume\\parent'})
  const owner=create('C:\\parent\\store',f.api),pending=owner.capture('C:\\parent\\STORE\\nested\\x.doc.jsonl')
  expect(pending.kind).toBe('needs-root');expect(pending).toMatchObject({preparation:{kind:'root-only',path:'C:\\parent\\store'}});expect('key' in pending).toBe(false);expect(f.calls).toContain('C:\\parent');pending.assertCurrent()
  f.directories.get('C:\\parent')!.sensitive=false;expect(()=>pending.assertCurrent()).toThrow();const before=f.calls.length;expect(()=>pending.assertCurrent()).toThrow();expect(f.calls.length).toBe(before)
})
it('recaptures original root after creation and accepts aliases only by actual identity',async()=>{
  const create=await implementation(),f=fixture();f.directories.delete('C:\\store');const owner=create('C:\\store',f.api),old=owner.capture('C:\\STORE\\x.doc.jsonl');expect(old.kind).toBe('needs-root')
  f.directories.set('C:\\store',{id:1,sensitive:false,final:'\\Device\\Volume\\store'});f.directories.set('C:\\STORE',{...f.directories.get('C:\\store')!});expect(()=>old.assertCurrent()).toThrow();expect(owner.capture('C:\\STORE\\x.doc.jsonl')).toMatchObject({kind:'ready'});f.directories.get('C:\\STORE')!.id=7;expect(()=>owner.capture('C:\\STORE\\x.doc.jsonl')).toThrow()
})

it('preserves all128 file-ID bits and sensitive UTF16 code units without mapping',async()=>{
  const create=await implementation(),f=fixture(),id=Buffer.from('ffeeddccbbaa99887766554433221100','hex');f.directories.get('C:\\store')!.identity=id;f.directories.get('C:\\store')!.sensitive=true
  const owner=create('C:\\store',f.api),leaf='a\ud800😀.doc.jsonl',c=owner.capture('C:\\store\\'+leaf);expect(c.kind==='ready'&&c.key).toContain(id.toString('hex'));expect(c.kind==='ready'&&c.key).toContain(Buffer.from(leaf,'utf16le').toString('hex'));expect(f.folds()).toBe(0);expect(f.handles.size).toBe(0)
})
it('uses invariant native size expansion only for insensitive leaves',async()=>{
  const create=await implementation(),f=fixture();f.api.lcMapStringEx=(locale,flags,value,count,output,capacity,version,reserved,param)=>{expect([locale,flags,count,version,reserved,param]).toEqual(['',0x200,value.length,null,null,0n]);const mapped=value.replaceAll('ß','SS').toUpperCase();if(!output){expect(capacity).toBe(0);return mapped.length}expect(capacity).toBe(mapped.length);output.write(mapped,'utf16le');return mapped.length}
  const owner=create('C:\\store',f.api);const a=owner.capture('C:\\store\\ß.doc.jsonl'),b=owner.capture('C:\\store\\SS.doc.jsonl');expect(a.kind==='ready'&&a.key).toBe(b.kind==='ready'&&b.key);expect(f.handles.size).toBe(0)
})
it('keeps mixed-policy sibling anchors distinct and coalesces actual case aliases',async()=>{
  const create=await implementation(),f=fixture();f.directories.set('C:\\STORE',{...f.directories.get('C:\\store')!});f.directories.set('C:\\store\\mixed',{id:8,sensitive:false,final:'\\Device\\Volume\\store\\mixed'});f.directories.get('C:\\store\\Mixed')!.sensitive=false
  const owner=create('C:\\store',f.api),a=owner.capture('C:\\STORE\\x.doc.jsonl'),b=owner.capture('C:\\store\\x.doc.jsonl');expect(a.kind==='ready'&&a.key).toBe(b.kind==='ready'&&b.key);const c=owner.capture('C:\\store\\Mixed\\x.doc.jsonl'),d=owner.capture('C:\\store\\mixed\\x.doc.jsonl');expect(c.kind==='ready'&&c.key).not.toBe(d.kind==='ready'&&d.key)
})
it.each([2,3])('limits absent-parent preparation to native absence code %s',async code=>{
  const create=await implementation(),f=fixture(),open=f.api.createFileW;f.api.createFileW=(...args)=>{const v=open(...args);if(v===-1n)f.setError(code);return v};const owner=create('C:\\store',f.api),c=owner.capture('C:\\store\\missing\\nested\\a..doc.jsonl');expect(c.kind).toBe('needs-parents');expect('key'in c).toBe(false);c.assertCurrent();f.directories.get('C:\\store')!.final+='changed';expect(()=>c.assertCurrent()).toThrow();const before=f.calls.length;expect(()=>c.assertCurrent()).toThrow();expect(f.calls.length).toBe(before)
})
it.each([5,32,123,87])('never treats native open code %s as preparation permission',async code=>{
  const create=await implementation(),f=fixture();f.api.createFileW=()=>{f.setError(code);return -1n};const owner=create('C:\\store',f.api);expect(()=>owner.capture('C:\\store\\missing\\a.doc.jsonl')).toThrow();expect(f.handles.size).toBe(0)
})
it.each([{attributes:0},{attributes:0x410},{policy:2}])('refuses wrong type/reparse/unknown policy %j',async change=>{
  const create=await implementation(),f=fixture();Object.assign(f.directories.get('C:\\store')!,change);expect(()=>create('C:\\store',f.api).capture('C:\\store\\a.doc.jsonl')).toThrow();expect(f.handles.size).toBe(0)
})
it.each([9,18,23])('does not decode failed class%s output',async kind=>{
  const create=await implementation(),f=fixture(),info=f.api.getFileInformationByHandleEx;const seen:number[]=[];f.api.getFileInformationByHandleEx=(h,k,b,s)=>{seen.push(k);if(k===kind){b.fill(0xff);f.setError(87);return 0}return info(h,k,b,s)};expect(()=>create('C:\\store',f.api).capture('C:\\store\\a.doc.jsonl')).toThrow();expect(seen.at(-1)).toBe(kind);expect(f.handles.size).toBe(0)
})
it.each(['query-zero','query-negative','query-nan','query-fraction','query-large','write-zero','write-count','write-nul'])('rejects native case-map %s',async mode=>{
  const create=await implementation(),f=fixture(),map=f.api.lcMapStringEx;f.api.lcMapStringEx=(...args)=>{if(!args[4]){if(mode==='query-zero')return 0;if(mode==='query-negative')return -1;if(mode==='query-nan')return NaN;if(mode==='query-fraction')return 1.5;if(mode==='query-large')return 32769}else{if(mode==='write-zero')return 0;if(mode==='write-count')return args[5]-1;if(mode==='write-nul'){args[4].fill(0);return args[5]}}return map(...args)};expect(()=>create('C:\\store',f.api).capture('C:\\store\\a.doc.jsonl')).toThrow();expect(f.handles.size).toBe(0)
})
it('grows normalized path buffers using required-NUL count then copies count excluding NUL',async()=>{
  const create=await implementation(),f=fixture();f.directories.get('C:\\store')!.final='\\Device\\Volume\\'+('x'.repeat(300));const units:number[]=[],final=f.api.getFinalPathNameByHandleW;f.api.getFinalPathNameByHandleW=(h,b,n,flags)=>{units.push(n);return final(h,b,n,flags)};expect(create('C:\\store',f.api).capture('C:\\store\\a.doc.jsonl').kind).toBe('ready');expect(units.slice(0,2)).toEqual([256,316]);expect(f.handles.size).toBe(0)
})
it.each(['zero','negative','nan','fraction','large','growth','embedded','unterminated'])('rejects normalized path boundary %s',async mode=>{
  const create=await implementation(),f=fixture();let attempts=0;f.api.getFinalPathNameByHandleW=(_h,b,size,flags)=>{attempts++;expect(flags).toBe(2);if(mode==='zero')return 0;if(mode==='negative')return -1;if(mode==='nan')return NaN;if(mode==='fraction')return 1.5;if(mode==='large')return 32769;if(mode==='growth')return size+1;if(mode==='embedded'){b.write('a\0b\0','utf16le');return 3}b.fill(0x41);b.write('abc','utf16le');return 3};expect(()=>create('C:\\store',f.api).capture('C:\\store\\a.doc.jsonl')).toThrow();expect(attempts).toBe(mode==='growth'?3:1);expect(f.handles.size).toBe(0)
})
it.each(['root-final','prefix-id','prefix-policy','query-race','capture-race'])('retires captures on original namespace change %s',async mode=>{
  const create=await implementation(),f=fixture();let queries=0,armed=false;const info=f.api.getFileInformationByHandleEx;f.api.getFileInformationByHandleEx=(h,k,b,s)=>{const r=info(h,k,b,s);if(armed&&k===18){queries++;if(mode==='query-race'&&queries===2)b[8]=99;if(mode==='capture-race'&&queries>4)b[8]=98}return r};const owner=create('C:\\store',f.api),c=owner.capture('C:\\store\\Mixed\\a.doc.jsonl');armed=true;if(mode==='root-final')f.directories.get('C:\\store')!.final+='alias';if(mode==='prefix-id')f.directories.get('C:\\store\\Mixed')!.id=12;if(mode==='prefix-policy')f.directories.get('C:\\store\\Mixed')!.sensitive=false;expect(()=>c.assertCurrent()).toThrow();const before=f.calls.length;expect(()=>c.assertCurrent()).toThrow();expect(f.calls.length).toBe(before);expect(f.handles.size).toBe(0)
})
it.each([undefined,null,false,0,''])('pins falsey unknown original open %j without replacement calls',async cause=>{
  const create=await implementation(),f=fixture();let calls=0;f.api.createFileW=()=>{calls++;throw cause};const owner=create('C:\\store',f.api);let caught:unknown='not thrown';try{owner.capture('C:\\store\\a.doc.jsonl')}catch(e){caught=e}expect(caught).toBe(cause);expect(()=>owner.capture('C:\\store\\a.doc.jsonl')).toThrow();let settled:unknown='not thrown';try{owner.settleResources()}catch(e){settled=e}expect(settled).toBe(cause);expect(calls).toBe(1);expect(f.closes).toEqual([])
})
it.each([undefined,NaN,1,true])('pins malformed native open %j without interpreting it as absence',async value=>{
  const create=await implementation(),f=fixture();let calls=0;f.api.createFileW=()=>{calls++;return value as any};const owner=create('C:\\store',f.api);expect(()=>owner.capture('C:\\store\\a.doc.jsonl')).toThrow();expect(()=>owner.settleResources()).toThrow();expect(()=>owner.capture('C:\\store\\a.doc.jsonl')).toThrow();expect(calls).toBe(1)
})
it.each([false,true])('retains original known close refusal even when diagnostic throws=%s',async diagnostic=>{
  const create=await implementation(),f=fixture(),close=f.api.closeHandle;let first=true;f.api.closeHandle=h=>{if(first){first=false;return 0}return close(h)};if(diagnostic)f.api.getLastError=()=>{throw undefined};const owner=create('C:\\store',f.api);expect(()=>owner.capture('C:\\store\\a.doc.jsonl')).toThrow();const before=f.calls.length;expect(()=>owner.capture('C:\\store\\a.doc.jsonl')).toThrow();expect(f.calls.length).toBe(before);owner.settleResources();expect(f.handles.size).toBe(0);expect(owner.capture('C:\\store\\a.doc.jsonl').kind).toBe('ready')
})
it.each([undefined,null,false])('pins consumed close %j without consuming reused handle',async cause=>{
  const create=await implementation(),f=fixture(),close=f.api.closeHandle;f.api.closeHandle=h=>{close(h);throw cause};const owner=create('C:\\store',f.api);let caught:unknown='not thrown';try{owner.capture('C:\\store\\a.doc.jsonl')}catch(e){caught=e}expect(caught).toBe(cause);f.handles.set(1n,{id:99,sensitive:false,final:'replacement'});let settled:unknown='not thrown';try{owner.settleResources()}catch(e){settled=e}expect(settled).toBe(cause);expect(f.closes).toEqual([1n]);expect(f.handles.get(1n)?.final).toBe('replacement');expect(()=>owner.capture('C:\\store\\a.doc.jsonl')).toThrow()
})
it.each([NaN,undefined,true,0x80000000])('pins invalid close BOOL %j without resubmission',async value=>{
  const create=await implementation(),f=fixture();let closes=0;f.api.closeHandle=()=>{closes++;return value as number};const owner=create('C:\\store',f.api);expect(()=>owner.capture('C:\\store\\a.doc.jsonl')).toThrow();expect(()=>owner.settleResources()).toThrow();expect(closes).toBe(1)
})
it('keeps falsey primary before close failure in the original aggregate',async()=>{
  const create=await implementation(),f=fixture();f.api.getFileInformationByHandleEx=()=>{throw null};f.failClose();const owner=create('C:\\store',f.api);let failure:any;try{owner.capture('C:\\store\\a.doc.jsonl')}catch(e){failure=e}expect(failure).toBeInstanceOf(AggregateError);expect(failure.errors[0]).toBeNull();expect(failure.cause).toBeNull();owner.settleResources();expect(f.handles.size).toBe(0)
})
it('bounds point opens by depth and retains source suffix, nested internal-dot and colon names',async()=>{
  const create=await implementation(),f=fixture(),owner=create('C:\\store',f.api);for(const leaf of ['a..doc.jsonl','name:stream.doc.jsonl','CON.doc.jsonl','😀.jsonl'])expect(owner.capture('C:\\store\\Mixed\\'+leaf).kind).toBe('ready');expect(f.calls.length).toBe(16);const before=f.calls.length;expect(()=>owner.capture('C:\\store\\nul\0.doc.jsonl')).toThrow();expect(f.calls.length).toBe(before)
})

it.each([1,2,3,4,5,6])('cleans earlier point opens when known prefix open%s fails',async index=>{
  const create=await implementation(),f=fixture();f.directories.set('C:\\store\\one',{id:10,sensitive:false,final:'\\Device\\Volume\\store\\one'});f.directories.set('C:\\store\\one\\two',{id:11,sensitive:false,final:'\\Device\\Volume\\store\\one\\two'});const open=f.api.createFileW;let count=0;f.api.createFileW=(...args)=>{if(++count===index){f.calls.push(args[0]);f.setError(5);return -1n}return open(...args)};const owner=create('C:\\store',f.api);expect(()=>owner.capture('C:\\store\\one\\two\\x.doc.jsonl')).toThrow();expect(f.handles.size).toBe(0);expect(owner.capture('C:\\store\\one\\two\\x.doc.jsonl').kind).toBe('ready')
})
it.each([1,2,3,4,5,6])('pins effect-then-falsey prefix open%s without guessing its raw handle',async index=>{
  const create=await implementation(),f=fixture();f.directories.set('C:\\store\\one',{id:10,sensitive:false,final:'\\Device\\Volume\\store\\one'});f.directories.set('C:\\store\\one\\two',{id:11,sensitive:false,final:'\\Device\\Volume\\store\\one\\two'});const open=f.api.createFileW;let count=0;f.api.createFileW=(...args)=>{const value=open(...args);if(++count===index)throw null;return value};const owner=create('C:\\store',f.api);let primary:unknown='not thrown';try{owner.capture('C:\\store\\one\\two\\x.doc.jsonl')}catch(e){primary=e}expect(primary).toBeNull();expect(f.handles.size).toBe(1);const before=f.calls.length;expect(()=>owner.capture('C:\\store\\one\\two\\x.doc.jsonl')).toThrow();let cleanup:unknown='not thrown';try{owner.settleResources()}catch(e){cleanup=e}expect(cleanup).toBeNull();expect(f.calls.length).toBe(before);expect(f.closes).not.toContain(BigInt(index))
})
it.each([null,0n,-1n,0xffffffffn,0xffffffffffffffffn])('handles known invalid open %s as native error without close',async value=>{
  const create=await implementation(),f=fixture();f.api.createFileW=()=>{f.setError(5);return value};const owner=create('C:\\store',f.api);expect(()=>owner.capture('C:\\store\\a.doc.jsonl')).toThrow('Win32 5');owner.settleResources();expect(f.closes).toEqual([])
})
it.each([8,24,4,512,2])('retains original handle ownership when Buffer allocation%s throws falsey',async size=>{
  const create=await implementation(),f=fixture(),owner=create('C:\\store',f.api),allocate=Buffer.alloc;let failed=false,caught:unknown='not thrown';const spy=vi.spyOn(Buffer,'alloc').mockImplementation(((bytes:number,...args:any[])=>{if(bytes===size&&!failed){failed=true;throw null}return Reflect.apply(allocate,Buffer,[bytes,...args])}) as any)
  try{owner.capture('C:\\store\\x')}catch(e){caught=e}finally{spy.mockRestore()}expect(caught).toBeNull();expect(failed).toBe(true);expect(f.handles.size).toBe(0);owner.settleResources();expect(owner.capture('C:\\store\\x').kind).toBe('ready')
})
it.each(['attributes','policy','identity','normalization','map'] as const)('retains native ownership across fallible %s read/decode',async cut=>{
  const create=await implementation(),f=fixture(),owner=create('C:\\store',f.api);let failed=false,caught:unknown='not thrown';const name=cut==='identity'?'subarray':cut==='normalization'||cut==='map'?'toString':'readUInt32LE';const original=(Buffer.prototype as any)[name];const spy=vi.spyOn(Buffer.prototype,name as any).mockImplementation(function(this:Buffer,...args:any[]){const hit=cut==='attributes'?this.length===8:cut==='policy'?this.length===4:cut==='identity'?this.length===24:cut==='normalization'?this.length===512&&args[0]==='utf16le':this.length===2&&args[0]==='utf16le';if(hit&&!failed){failed=true;throw false}return Reflect.apply(original,this,args)})
  try{owner.capture('C:\\store\\x')}catch(e){caught=e}finally{spy.mockRestore()}expect(failed).toBe(true);expect(caught).toBe(false);expect(f.handles.size).toBe(0);owner.settleResources()
})
it.each(['info','final','map'] as const)('preserves falsey throw from original %s boundary',async cut=>{
  const create=await implementation(),f=fixture();if(cut==='info')f.api.getFileInformationByHandleEx=()=>{throw undefined};if(cut==='final')f.api.getFinalPathNameByHandleW=()=>{throw undefined};if(cut==='map')f.api.lcMapStringEx=()=>{throw undefined};const owner=create('C:\\store',f.api);let caught:unknown='not thrown';try{owner.capture('C:\\store\\x')}catch(e){caught=e}expect(caught).toBeUndefined();expect(f.handles.size).toBe(0);owner.settleResources()
})
it('unrelated target prefix receives only root-only intent and never target-parent authority',async()=>{
  const create=await implementation(),f=fixture();f.directories.delete('C:\\store');const owner=create('C:\\store',f.api),c=owner.capture('C:\\other\\x.doc.jsonl');expect(c).toMatchObject({kind:'needs-root',preparation:{kind:'root-only',path:'C:\\store'}});expect(f.calls).not.toContain('C:\\other');f.directories.set('C:\\store',{id:1,sensitive:false,final:'\\Device\\Volume\\store'});f.directories.set('C:\\other',{id:8,sensitive:false,final:'\\Device\\Volume\\other'});expect(()=>c.assertCurrent()).toThrow();expect(()=>owner.capture('C:\\other\\x.doc.jsonl')).toThrow()
})
it('retains nearest existing original ancestor evidence when multiple root components are absent',async()=>{
  const create=await implementation(),f=fixture(),owner=create('C:\\missing\\root',f.api),c=owner.capture('C:\\missing\\root\\x.doc.jsonl');expect(c.kind).toBe('needs-root');c.assertCurrent();f.directories.get('C:\\')!.id=8;expect(()=>c.assertCurrent()).toThrow();expect(f.handles.size).toBe(0)
})
it('uses original API receivers and rejects reentry before opening another handle',async()=>{
  const create=await implementation(),f=fixture(),info=f.api.getFileInformationByHandleEx;let owner:ReturnType<typeof create>,checked=false;f.api.getFileInformationByHandleEx=function(...args){expect(this).toBe(f.api);if(!checked){checked=true;const before=f.calls.length;expect(()=>owner.capture('C:\\store\\x')).toThrow();expect(()=>owner.settleResources()).toThrow();expect(f.calls.length).toBe(before)}return info(...args)};owner=create('C:\\store',f.api);expect(owner.capture('C:\\store\\x').kind).toBe('ready')
})
it.each(['needs-root','needs-parents'])('exact pending receivers and immutable intent for %s',async phase=>{
  const create=await implementation(),f=fixture();if(phase==='needs-root')f.directories.delete('C:\\store');const owner=create('C:\\store',f.api),c=owner.capture('C:\\store\\missing\\a.doc.jsonl');expect(c.kind).toBe(phase);expect(Object.isFrozen(c)).toBe(true);if(c.kind==='needs-root')expect(Object.isFrozen(c.preparation)).toBe(true);const before=f.calls.length;expect(()=>c.assertCurrent.call({} as typeof c)).toThrow();expect(f.calls.length).toBe(before);c.assertCurrent();expect('key'in c).toBe(false)
})
it.each([NaN,undefined,true])('rejects malformed metadata BOOL %j without decoding output',async result=>{
  const create=await implementation(),f=fixture();f.api.getFileInformationByHandleEx=()=>result as number;expect(()=>create('C:\\store',f.api).capture('C:\\store\\a.doc.jsonl')).toThrow();expect(f.handles.size).toBe(0)
})
