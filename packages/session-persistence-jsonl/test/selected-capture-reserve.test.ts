import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, readdir, open, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBootstrapCaptureBackend } from '../src/backend/bootstrap-capture.ts'
import { selectedBootstrapPaths } from '../src/backend/selected-results-route-path.ts'
import { createSelectedResultsIntent, readSelectedResultsCore } from '../../session-persistence/src/selected-results-fork-contract.ts'
import { encodeSelectedResultsReservation } from '../../session-persistence/src/coordinator/selected-results-intent.ts'
import { heldFactOwner, issuingFactOwner } from '../../session-persistence/src/coordinator/fact-owner.ts'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'
import { codecSeed } from '../../core-session/test/fixtures/selected-results.ts'
import { compileSelectedResultsSemanticSeed } from '../../session-persistence/src/semantic-seed.ts'
import { buildSelectedResultsHeader } from '../../session-persistence/src/coordinator/selected-results-header.ts'

vi.mock('node:fs/promises',async original=>{const fs=await original<typeof import('node:fs/promises')>();return {...fs,open:vi.fn(fs.open),stat:vi.fn(fs.stat),readdir:vi.fn(fs.readdir)}})
afterEach(()=>vi.restoreAllMocks())
function fixture(){
 const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{title:'test'},results:'selected-results-v1'})
 const {intent,requestDigest}=createSelectedResultsIntent(core,{kind:'unmanaged'}),invocation={version:1 as const,operationId:'op',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest}
 const route={protocol:'public-results-v1' as const,request:{invocation,core,requestIntent:intent}},reservation={version:1,kind:'semantic-bootstrap-selected-results-capture',request:route.request}
 const built=buildSelectedResultsHeader({invocation,target:{kind:'new'},metadata:core.metadata,lineage:{origin:'fork',parentSession:'source'},seed:compileSelectedResultsSemanticSeed(codecSeed('public-completed'))},reservation)
 return {route,reservation,built,bytes:encodeSelectedResultsReservation(reservation)}
}
async function setup(before:()=>void=()=>{}){
 const root=await mkdtemp(join(tmpdir(),'ih-reserve-')),ownership=createOwnership({lockRoot:root},{lock:{enabled:true}}),claim=await ownership.pinOwnership('target')
 const held=heldFactOwner({sessionId:'target',incarnation:'original'},ownership,()=>claim.assertHeld()),issuer=issuingFactOwner(held,before),backend=createBootstrapCaptureBackend(id=>join(root,id+'.jsonl'),async()=>{},root)
 return {root,held,issuer,backend,async close(){await claim.release();await rm(root,{recursive:true,force:true})}}
}
it('issues exact selected bytes once with original owner and snapshots mutable inputs',async()=>{
 const x=await setup(),f=fixture(),route=structuredClone(f.route),bytes=Buffer.from(f.bytes),expected=Buffer.from(bytes),paths=selectedBootstrapPaths(join(x.root,'target.jsonl'),route)
 try{
  const pending=x.backend.reserveSelectedCapture('target',x.issuer,route,bytes)
  route.request.invocation.operationId='changed';bytes.fill(0)
  expect(await pending).toEqual({kind:'committed-new'});expect(await readFile(paths.stage)).toEqual(expected)
  expect(await x.backend.readSelectedCapture('target',x.held,f.route)).toMatchObject({kind:'reserved',reservation:f.reservation})
  expect(await x.backend.reserveSelectedCapture('target',x.issuer,f.route,f.bytes)).toEqual({kind:'present'})
  await expect(x.backend.settleBootstrapCaptureIO('target',{...x.held})).rejects.toThrow();await x.backend.settleBootstrapCaptureIO('target',x.held)
 }finally{await x.close()}
})
it.each(['target','materialized','foreign','publication','partial'] as const)('refuses %s without mutation',async mode=>{
 const x=await setup(),f=fixture(),path=join(x.root,'target.jsonl'),paths=selectedBootstrapPaths(path,f.route)
 try{
  if(mode==='target')await writeFile(path,'existing')
  if(mode==='materialized')await writeFile(paths.stage,f.built.stageBytes)
  if(mode==='foreign')await writeFile(path+'.bootstrap-'+ 'a'.repeat(64)+'.stage','foreign')
  if(mode==='publication')await writeFile(paths.publish,'publication')
  if(mode==='partial')await writeFile(paths.stage,'{')
  const names=await readdir(x.root),before=await Promise.all(names.map(n=>readFile(join(x.root,n)).catch(()=>undefined)))
  if(mode==='materialized')expect((await x.backend.readSelectedCapture('target',x.held,f.route)).kind).toBe('materialized')
  if(mode==='target')expect(await x.backend.readSelectedCapture('target',x.held,f.route)).toEqual({kind:'unavailable'})
  const result=await x.backend.reserveSelectedCapture('target',x.issuer,f.route,f.bytes)
  expect(result.kind).toBe(mode==='materialized'||mode==='foreign'||mode==='publication'?'conflict':'unknown')
  expect(await readdir(x.root)).toEqual(names);expect(await Promise.all(names.map(n=>readFile(join(x.root,n)).catch(()=>undefined)))).toEqual(before)
  await x.backend.settleBootstrapCaptureIO('target',x.held)
 }finally{await x.close()}
})
it.each([['FACT_CANCELLED','cancelled'],['FACT_PRECONDITION_STALE','stale-source']] as const)('maps %s before issue',async(code,reason)=>{
 const x=await setup(()=>{throw Object.assign(new Error(code),{code})}),f=fixture()
 try{expect(await x.backend.reserveSelectedCapture('target',x.issuer,f.route,f.bytes)).toEqual({kind:'not-issued',reason});expect(await x.backend.readSelectedCapture('target',x.held,f.route)).toEqual({kind:'absent'});await x.backend.settleBootstrapCaptureIO('target',x.held)}finally{await x.close()}
})
it.each([null,undefined,false,0,''])('falsey beforeIssue failure stays unknown: %s',async fault=>{
 const x=await setup(()=>{throw fault}),f=fixture()
 try{expect(await x.backend.reserveSelectedCapture('target',x.issuer,f.route,f.bytes)).toEqual({kind:'unknown'});expect(await x.backend.readSelectedCapture('target',x.held,f.route)).toEqual({kind:'absent'});await x.backend.settleBootstrapCaptureIO('target',x.held)}finally{await x.close()}
})
it('fault injection: lost sync acknowledgement retains issued file and original close debt',async()=>{
 const x=await setup(),f=fixture(),native=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');let failClose=true
 vi.mocked(open).mockImplementation(async(...args)=>{const handle=await native.open(...args);if(args[1]!=='wx')return handle;return new Proxy(handle,{get(target,key){if(key==='sync')return async()=>{throw Error('lost sync')};if(key==='close')return async()=>{if(failClose)throw Error('close debt');return target.close()};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v}})})
 try{expect(await x.backend.reserveSelectedCapture('target',x.issuer,f.route,f.bytes)).toEqual({kind:'unknown'});await expect(x.backend.settleBootstrapCaptureIO('target',x.held)).rejects.toThrow();failClose=false;await x.backend.settleBootstrapCaptureIO('target',x.held);expect(await x.backend.readSelectedCapture('target',x.held,f.route)).toMatchObject({kind:'reserved'});await x.backend.settleBootstrapCaptureIO('target',x.held)}finally{failClose=false;vi.mocked(open).mockImplementation(native.open);await x.close()}
})
it('fault injection: EEXIST at exclusive open inspects the captured route',async()=>{
 const x=await setup(),f=fixture(),native=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');let once=true
 vi.mocked(open).mockImplementation(async(...args)=>{if(once&&args[1]==='wx'){once=false;await writeFile(String(args[0]),f.bytes);throw Object.assign(new Error('collision'),{code:'EEXIST'})}return native.open(...args)})
 try{expect(await x.backend.reserveSelectedCapture('target',x.issuer,f.route,f.bytes)).toEqual({kind:'present'});await x.backend.settleBootstrapCaptureIO('target',x.held)}finally{vi.mocked(open).mockImplementation(native.open);await x.close()}
})
it('fault injection: EEXIST after open is uncertain even when bytes are complete',async()=>{
 const x=await setup(),f=fixture(),native=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
 vi.mocked(open).mockImplementation(async(...args)=>{const h=await native.open(...args);if(args[1]!=='wx')return h;return new Proxy(h,{get(t,k){if(k==='sync')return async()=>{throw Object.assign(new Error('sync collision'),{code:'EEXIST'})};const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v}})})
 try{expect(await x.backend.reserveSelectedCapture('target',x.issuer,f.route,f.bytes)).toEqual({kind:'unknown'});await x.backend.settleBootstrapCaptureIO('target',x.held);expect((await x.backend.readSelectedCapture('target',x.held,f.route)).kind).toBe('reserved');await x.backend.settleBootstrapCaptureIO('target',x.held)}finally{vi.mocked(open).mockImplementation(native.open);await x.close()}
})
it('rejects mismatched reservation, target and copied issuer before mutation',async()=>{
 const x=await setup(),f=fixture(),other=structuredClone(f.route);other.request.invocation.operationId='other'
 try{await expect(x.backend.reserveSelectedCapture('target',x.issuer,other,f.bytes)).rejects.toThrow();await expect(x.backend.reserveSelectedCapture('other',x.issuer,f.route,f.bytes)).rejects.toThrow();await expect(x.backend.reserveSelectedCapture('target',{...x.issuer},f.route,f.bytes)).rejects.toThrow();expect((await x.backend.readSelectedCapture('target',x.held,f.route)).kind).toBe('absent');await x.backend.settleBootstrapCaptureIO('target',x.held)}finally{await x.close()}
})

it('prepares and reconciles selected header from original captured bytes',async()=>{
 const x=await setup(),f=fixture(),path=join(x.root,'target.jsonl'),paths=selectedBootstrapPaths(path,f.route),stage=Buffer.from(f.built.stageBytes),header=Buffer.from(f.built.headerBytes),expectedStage=Buffer.from(stage),expectedHeader=Buffer.from(header)
 try{
  await x.backend.reserveSelectedCapture('target',x.issuer,f.route,f.bytes)
  const pending=x.backend.prepareSelectedHeader('target',x.issuer,f.route,{invocation:f.route.request.invocation,target:{kind:'new'},stageBytes:stage,headerBytes:header});stage.fill(0);header.fill(0)
  expect((await pending).kind).toBe('committed');expect(await readFile(paths.stage)).toEqual(expectedStage);expect(await readFile(path)).toEqual(expectedHeader)
  expect((await x.backend.reconcileSelectedHeader('target',x.held,f.route,{invocation:f.route.request.invocation,target:{kind:'new'},stageBytes:expectedStage,headerBytes:expectedHeader})).kind).toBe('committed')
  await x.backend.settleBootstrapCaptureIO('target',x.held)
 }finally{await x.close()}
})
it('does not repair partial promotion or header during reconciliation',async()=>{
 const x=await setup(),f=fixture(),path=join(x.root,'target.jsonl'),paths=selectedBootstrapPaths(path,f.route),op={invocation:f.route.request.invocation,target:{kind:'new' as const},stageBytes:Buffer.from(f.built.stageBytes),headerBytes:Buffer.from(f.built.headerBytes)}
 try{
  await x.backend.reserveSelectedCapture('target',x.issuer,f.route,f.bytes);const prefix=op.stageBytes.subarray(0,10);await writeFile(paths.promote,prefix)
  expect((await x.backend.reconcileSelectedHeader('target',x.held,f.route,op)).kind).toBe('unknown');expect(await readFile(paths.promote)).toEqual(prefix)
  expect((await x.backend.prepareSelectedHeader('target',x.issuer,f.route,op)).kind).toBe('committed')
  await writeFile(path,op.headerBytes.subarray(0,10));expect((await x.backend.reconcileSelectedHeader('target',x.held,f.route,op)).kind).toBe('unknown');expect(await readFile(path)).toEqual(op.headerBytes.subarray(0,10))
  await x.backend.settleBootstrapCaptureIO('target',x.held)
 }finally{await x.close()}
})

it('preserves typed cancellation before selected promotion issue',async()=>{
 const x=await setup(),f=fixture(),op={invocation:f.route.request.invocation,target:{kind:'new' as const},stageBytes:Buffer.from(f.built.stageBytes),headerBytes:Buffer.from(f.built.headerBytes)}
 try{
  await x.backend.reserveSelectedCapture('target',x.issuer,f.route,f.bytes)
  const cancelled=issuingFactOwner(x.held,()=>{throw Object.assign(new Error('cancelled'),{code:'FACT_CANCELLED'})})
  expect(await x.backend.prepareSelectedHeader('target',cancelled,f.route,op)).toEqual({kind:'not-issued',reason:'cancelled'})
  await x.backend.settleBootstrapCaptureIO('target',x.held)
 }finally{await x.close()}
})

function headerOperation(f:ReturnType<typeof fixture>){return {invocation:f.route.request.invocation,target:{kind:'new' as const},stageBytes:Buffer.from(f.built.stageBytes) as Uint8Array,headerBytes:Buffer.from(f.built.headerBytes) as Uint8Array}}
it.each(['prepareSelectedHeader','reconcileSelectedHeader'] as const)('%s rejects hostile operation containers before caller code or IO',async method=>{
 const x=await setup(),f=fixture()
 try{
  await x.backend.reserveSelectedCapture('target',x.issuer,f.route,f.bytes)
  const before=await diskSnapshot(x.root)
  for(const container of ['operation','invocation','target'] as const)for(const shape of ['proxy','getter','inherited','missing','extra','symbol','nonenumerable','prototype'] as const){
   const op=headerOperation(f),base=container==='operation'?op:op[container],key=container==='operation'?'stageBytes':container==='target'?'kind':'operationId'
   let calls=0
   const value=Object.getOwnPropertyDescriptor(base,key)!.value
   let bad:object={...base}
   if(shape==='proxy')bad=new Proxy(base,{get(){calls++;throw Error('proxy get')},ownKeys(){calls++;throw Error('proxy ownKeys')},getPrototypeOf(){calls++;throw Error('proxy prototype')}})
   if(shape==='getter')Object.defineProperty(bad,key,{enumerable:true,get(){calls++;return container==='operation'&&calls>=4?Uint8Array.of(0):value}})
   if(shape==='inherited'){delete (bad as any)[key];Object.setPrototypeOf(bad,{[key]:value})}
   if(shape==='missing')delete (bad as any)[key]
   if(shape==='extra')Object.assign(bad,{sourceCallback(){calls++}})
   if(shape==='symbol')Object.assign(bad,{[Symbol('extra')]:true})
   if(shape==='nonenumerable')Object.defineProperty(bad,key,{value,enumerable:false})
   if(shape==='prototype')Object.setPrototypeOf(bad,{})
   const input=container==='operation'?bad:{...op,[container]:bad}
   vi.mocked(open).mockClear();vi.mocked(stat).mockClear();vi.mocked(readdir).mockClear()
   await expect(x.backend[method]('target',x.issuer,f.route,input as typeof op),`${container}/${shape}`).rejects.toThrow()
   expect(calls,`${container}/${shape}`).toBe(0)
   expect(open).not.toHaveBeenCalled();expect(stat).not.toHaveBeenCalled();expect(readdir).not.toHaveBeenCalled()
   expect(await diskSnapshot(x.root)).toEqual(before)
  }
  await x.backend.settleBootstrapCaptureIO('target',x.held)
 }finally{await x.close()}
})
it.each(['prepareSelectedHeader','reconcileSelectedHeader'] as const)('%s rejects accessor header bytes and byte proxies without calls or IO',async method=>{
 const x=await setup(),f=fixture()
 try{
  for(const key of ['stageBytes','headerBytes'] as const)for(const proxy of [false,true]){
   const op=headerOperation(f),value=op[key];let calls=0
   if(proxy)op[key]=new Proxy(value,{get(){calls++;throw Error('byte proxy')}})
   else Object.defineProperty(op,key,{enumerable:true,get(){calls++;return calls<4?value:Uint8Array.of(0)}})
   vi.mocked(open).mockClear();vi.mocked(stat).mockClear();vi.mocked(readdir).mockClear()
   await expect(x.backend[method]('target',x.issuer,f.route,op)).rejects.toThrow()
   expect(calls).toBe(0);expect(open).not.toHaveBeenCalled();expect(stat).not.toHaveBeenCalled();expect(readdir).not.toHaveBeenCalled()
  }
 }finally{await x.close()}
})
it.each(['stageBytes','headerBytes'] as const)('bounds intrinsic %s size before copying despite shadowed lengths',async key=>{
 const x=await setup(),f=fixture(),op=headerOperation(f),limit=key==='stageBytes'?262144:65536;let calls=0
 try{
  const bytes=new Uint8Array(limit+1)
  for(const field of ['length','byteLength'])Object.defineProperty(bytes,field,{get(){calls++;return 1}})
  op[key]=bytes
  for(const method of ['prepareSelectedHeader','reconcileSelectedHeader'] as const){
   vi.mocked(open).mockClear();vi.mocked(stat).mockClear();vi.mocked(readdir).mockClear()
   await expect(x.backend[method]('target',x.issuer,f.route,op)).rejects.toThrow()
   expect(calls).toBe(0);expect(open).not.toHaveBeenCalled();expect(stat).not.toHaveBeenCalled();expect(readdir).not.toHaveBeenCalled()
  }
 }finally{await x.close()}
})
it('accepts real Uint8Array views with intrinsic snapshots and no byte property hooks',async()=>{
 const x=await setup(),f=fixture(),op=headerOperation(f),path=join(x.root,'target.jsonl');let calls=0
 try{
  await x.backend.reserveSelectedCapture('target',x.issuer,f.route,f.bytes)
  for(const key of ['stageBytes','headerBytes'] as const){
   const backing=new Uint8Array(op[key].length+4);backing.set(op[key],2);const view=backing.subarray(2,-2)
   for(const field of ['length','byteLength','buffer','byteOffset','valueOf'])Object.defineProperty(view,field,{get(){calls++;throw Error('byte hook')}})
   op[key]=view
  }
  const pending=x.backend.prepareSelectedHeader('target',x.issuer,f.route,op)
  Uint8Array.prototype.fill.call(op.stageBytes,0);Uint8Array.prototype.fill.call(op.headerBytes,0)
  expect((await pending).kind).toBe('committed');expect(await readFile(path)).toEqual(Buffer.from(f.built.headerBytes));expect(calls).toBe(0)
  expect((await x.backend.reconcileSelectedHeader('target',x.held,f.route,{...headerOperation(f),stageBytes:new Uint8Array(Buffer.from(f.built.stageBytes)),headerBytes:new Uint8Array(Buffer.from(f.built.headerBytes))})).kind).toBe('committed')
  await x.backend.settleBootstrapCaptureIO('target',x.held)
 }finally{await x.close()}
})
async function diskSnapshot(root:string){const names=(await readdir(root)).sort();return Promise.all(names.map(async name=>[name,await readFile(join(root,name)).catch(()=>undefined)] as const))}
it('repeats exact preparation and snapshots route as well as byte inputs',async()=>{
 const x=await setup(),f=fixture(),route=structuredClone(f.route),op=headerOperation(f),original=headerOperation(f)
 try{await x.backend.reserveSelectedCapture('target',x.issuer,f.route,f.bytes);const flight=x.backend.prepareSelectedHeader('target',x.issuer,route,op);route.request.invocation.operationId='changed';op.stageBytes.fill(0);op.headerBytes.fill(0)
 const first=await flight;expect(first.kind).toBe('committed');const before=await diskSnapshot(x.root);expect(await x.backend.prepareSelectedHeader('target',x.issuer,f.route,original)).toEqual(first);expect(await diskSnapshot(x.root)).toEqual(before);await x.backend.settleBootstrapCaptureIO('target',x.held)
 }finally{await x.close()}
})
it('missing original stage refuses preparation and reconciliation without mutation',async()=>{
 const x=await setup(),f=fixture(),op=headerOperation(f)
 try{const before=await diskSnapshot(x.root);expect((await x.backend.prepareSelectedHeader('target',x.issuer,f.route,op)).kind).toBe('unknown');expect((await x.backend.reconcileSelectedHeader('target',x.held,f.route,op)).kind).toBe('unknown');expect(await diskSnapshot(x.root)).toEqual(before);await x.backend.settleBootstrapCaptureIO('target',x.held)}finally{await x.close()}
})
it('refuses changed promotion prefix without repair',async()=>{
 const x=await setup(),f=fixture(),op=headerOperation(f),paths=selectedBootstrapPaths(join(x.root,'target.jsonl'),f.route)
 try{await x.backend.reserveSelectedCapture('target',x.issuer,f.route,f.bytes);await writeFile(paths.promote,'bad prefix');const before=await diskSnapshot(x.root);expect((await x.backend.prepareSelectedHeader('target',x.issuer,f.route,op)).kind).toBe('conflict');expect((await x.backend.reconcileSelectedHeader('target',x.held,f.route,op)).kind).toBe('conflict');expect(await diskSnapshot(x.root)).toEqual(before);await x.backend.settleBootstrapCaptureIO('target',x.held)}finally{await x.close()}
})
it('refuses changed header prefix without repair',async()=>{
 const x=await setup(),f=fixture(),op=headerOperation(f),path=join(x.root,'target.jsonl')
 try{await x.backend.reserveSelectedCapture('target',x.issuer,f.route,f.bytes);expect((await x.backend.prepareSelectedHeader('target',x.issuer,f.route,op)).kind).toBe('committed');await writeFile(path,'wrong');const before=await diskSnapshot(x.root);expect((await x.backend.prepareSelectedHeader('target',x.issuer,f.route,op)).kind).toBe('conflict');expect((await x.backend.reconcileSelectedHeader('target',x.held,f.route,op)).kind).toBe('conflict');expect(await diskSnapshot(x.root)).toEqual(before);await x.backend.settleBootstrapCaptureIO('target',x.held)}finally{await x.close()}
})
it('rejects wrong request, route and header before any mutation',async()=>{
 const x=await setup(),f=fixture(),op=headerOperation(f),route=structuredClone(f.route),request=structuredClone(op.invocation);route.request.invocation.operationId='other';request.operationId='other'
 try{await x.backend.reserveSelectedCapture('target',x.issuer,f.route,f.bytes);const before=await diskSnapshot(x.root)
 for(const [r,o] of [[route,op],[f.route,{...op,invocation:request}],[f.route,{...op,headerBytes:Buffer.from('wrong')}]] as const){await expect(x.backend.prepareSelectedHeader('target',x.issuer,r,o)).rejects.toThrow();await expect(x.backend.reconcileSelectedHeader('target',x.held,r,o)).rejects.toThrow()}
 expect(await diskSnapshot(x.root)).toEqual(before);await x.backend.settleBootstrapCaptureIO('target',x.held)}finally{await x.close()}
})
it('refuses publication artifact with reservation unchanged',async()=>{
 const x=await setup(),f=fixture(),op=headerOperation(f),paths=selectedBootstrapPaths(join(x.root,'target.jsonl'),f.route)
 try{await x.backend.reserveSelectedCapture('target',x.issuer,f.route,f.bytes);await writeFile(paths.publish,'foreign publication');const before=await diskSnapshot(x.root);expect((await x.backend.prepareSelectedHeader('target',x.issuer,f.route,op)).kind).toBe('conflict');expect((await x.backend.reconcileSelectedHeader('target',x.held,f.route,op)).kind).toBe('conflict');expect(await diskSnapshot(x.root)).toEqual(before);await x.backend.settleBootstrapCaptureIO('target',x.held)}finally{await x.close()}
})
it.each([null,undefined,false,0,''])('falsey selected header beforeIssue remains unknown: %s',async fault=>{
 const x=await setup(),f=fixture(),op=headerOperation(f)
 try{await x.backend.reserveSelectedCapture('target',x.issuer,f.route,f.bytes);const before=await diskSnapshot(x.root),issuer=issuingFactOwner(x.held,()=>{throw fault});expect((await x.backend.prepareSelectedHeader('target',issuer,f.route,op)).kind).toBe('unknown');expect(await diskSnapshot(x.root)).toEqual(before);await x.backend.settleBootstrapCaptureIO('target',x.held)}finally{await x.close()}
})
it('retains falsey sync and retryable close debt on original selected header ledger',async()=>{
 const x=await setup(),f=fixture(),op=headerOperation(f),native=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');let failClose=true
 try{await x.backend.reserveSelectedCapture('target',x.issuer,f.route,f.bytes)
 vi.mocked(open).mockImplementation(async(...args)=>{const h=await native.open(...args);if(args[1]!=='wx'||!String(args[0]).endsWith('.promote'))return h;return new Proxy(h,{get(t,k){if(k==='sync')return async()=>{throw false};if(k==='close')return async()=>{if(failClose)throw false;return t.close()};const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v}})})
 expect((await x.backend.prepareSelectedHeader('target',x.issuer,f.route,op)).kind).toBe('unknown');await expect(x.backend.settleBootstrapCaptureIO('target',{...x.held})).rejects.toThrow();await expect(x.backend.settleBootstrapCaptureIO('target',x.held)).rejects.toThrow();failClose=false;await x.backend.settleBootstrapCaptureIO('target',x.held)
 }finally{failClose=false;vi.mocked(open).mockImplementation(native.open);await x.close()}
})
