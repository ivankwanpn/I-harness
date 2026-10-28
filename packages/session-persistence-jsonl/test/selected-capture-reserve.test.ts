import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, readdir, open } from 'node:fs/promises'
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

vi.mock('node:fs/promises',async original=>{const fs=await original<typeof import('node:fs/promises')>();return {...fs,open:vi.fn(fs.open)}})
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
