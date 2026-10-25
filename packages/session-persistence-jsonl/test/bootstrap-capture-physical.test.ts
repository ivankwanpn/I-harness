import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, open, rename, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CURRENT_FORMAT_VERSION, append, canonicalJsonData, createSession, exportConversationSeed, isStrictFactData, freezeJsonData, legacyPrefixDigest, validateSubagentHeader } from '@i-harness/core-session'
import { PROVIDER_PROTOCOLS } from '@i-harness/settings'
import * as p from '@i-harness/session-persistence'
import { createJsonlBackend } from '../src/index.ts'
import { heldFactOwner } from '../../session-persistence/src/coordinator/fact-owner.ts'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'
import { buildBootstrapHeader } from '../../session-persistence/src/coordinator/bootstrap-header.ts'
import { createBootstrapOwner, type ManagedEntry } from '../../session-persistence/src/coordinator/bootstrap.ts'
import { createMutations } from '../../session-persistence/src/coordinator/mutations.ts'
import { acquireSessionLock } from '../../fs-lock/src/index.ts'
const roots: string[] = [], coordinators: p.SessionCoordinator[] = []
vi.mock('node:fs/promises', async original => { const fs = await original<typeof import('node:fs/promises')>(); return { ...fs, open: vi.fn(fs.open), rename: vi.fn(fs.rename) } })
vi.mock('../../fs-lock/src/index.ts',async original=>{const locks=await original<typeof import('../../fs-lock/src/index.ts')>();return {...locks,acquireSessionLock:vi.fn(locks.acquireSessionLock)}})
afterEach(async () => { vi.restoreAllMocks(); for (const c of coordinators.splice(0)) await c.close().catch(() => {}); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const guards: p.BootstrapGuards = { assertCurrent() {}, dependencies: { async confirm() { throw new Error('No artifacts expected') }, async reconcile() { throw new Error('No artifacts expected') } } }
function request(): p.BootstrapCaptureRequest {
  const core = p.readForkRequestCore({ version: 1, kind: 'session-fork-core', sourceSessionId: 'source', selection: { kind: 'completed' }, sourceCapture: 'first-authorized-capture', metadata: { title: 'original' } })
  const { intent, requestDigest } = p.createBootstrapRequestIntent(core, { kind: 'unmanaged' })
  return { invocation: { version: 1, operationId: 'capture-operation', targetSessionId: 'target', createdAt: '2026-10-26T00:00:00.000Z', requestDigest }, core, requestIntent: intent }
}
async function setup(root?: string) {
  root ??= await mkdtemp(join(tmpdir(), 'ih-capture-')); if (!roots.includes(root)) roots.push(root)
  const backend = createJsonlBackend(root), coordinator = p.createSessionCoordinator(backend, { lock: { enabled: true }, acquireDeadlineMs: 40, acquireRetryMs: 5 }); coordinators.push(coordinator)
  return { root, backend, coordinator }
}
function stagePath(root: string, r: p.BootstrapCaptureRequest) { return join(root, 'target.jsonl.bootstrap-' + createHash('sha256').update(canonicalJsonData(r.invocation)).digest('hex') + '.stage') }
function payload(r: p.BootstrapCaptureRequest): p.BootstrapRequest {
  const source = createSession(); append(source, { type: 'turn/start' }); append(source, { type: 'user/message', text: 'actual original source' }); append(source, { type: 'turn/end' })
  const exported = exportConversationSeed(source, { kind: 'session', sessionId: 'source' }, { kind: 'completed' })
  if (exported.kind !== 'seed') throw new Error('Actual B1 export refused')
  return { invocation: r.invocation, target: { kind: 'new' }, metadata: r.core.metadata, lineage: { origin: 'fork', parentSession: 'source' }, seed: p.compileSemanticSeed(exported) }
}
it('P02/P04 reserves seed-free literal bytes before actual export and joins one original flight', async () => {
  const { root, coordinator } = await setup(), r = request(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let captures = 0
  expect(await coordinator.inspectBootstrapCapture!(r)).toEqual({ kind: 'absent' })
  const first = coordinator.bootstrapSemanticTargetWithCapture!(r, guards, async () => {
    captures++; expect(JSON.parse(await readFile(stagePath(root, r), 'utf8'))).toEqual({ version: 1, kind: 'semantic-bootstrap-capture', request: r })
    await expect(readFile(join(root, 'target.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
    entered.resolve(); await release.promise; return payload(r)
  })
  await entered.promise
  const second = coordinator.bootstrapSemanticTargetWithCapture!(r, guards, async () => { captures++; throw new Error('duplicate') })
  release.resolve(); const [a, b] = await Promise.all([first, second]); expect(a.kind).toBe('ready'); expect(b).toBe(a); expect(captures).toBe(1)
  const full = JSON.parse(await readFile(stagePath(root, r), 'utf8')); expect(full.captureReservation.request).toEqual(r)
  expect(()=>parsePredecessorStage(p.encodeBootstrapCaptureReservation({version:1,kind:'semantic-bootstrap-capture',request:r}))).toThrow()
  expect(()=>parsePredecessorStage(Buffer.from(canonicalJsonData(full)+'\n'))).toThrow()
})
it('P05/P08 spent callback remains fenced and cold generic payload cannot fill it', async () => {
  const { root, coordinator } = await setup(), r = request(), fault = new Error('original callback fault'); let captures = 0
  await expect(coordinator.bootstrapSemanticTargetWithCapture!(r, guards, async () => { captures++; throw fault })).rejects.toBe(fault)
  await coordinator.close()
  const cold = await setup(root)
  expect(await cold.coordinator.bootstrapSemanticTargetWithCapture!(r, guards, async () => { captures++; return payload(r) })).toMatchObject({ kind: 'blocked', reason: 'payload-required' })
  expect(await cold.coordinator.bootstrapSemanticTarget(payload(r), guards)).toMatchObject({ kind: 'blocked', reason: 'payload-required' })
  expect(captures).toBe(1); expect(JSON.parse(await readFile(stagePath(root, r), 'utf8')).kind).toBe('semantic-bootstrap-capture')
})
const callbackFaults:readonly(readonly[string,unknown])[]=[
  ['coded-cancelled',Object.assign(new Error('local coded callback fault'),{code:'FACT_CANCELLED'})],
  ['coded-stale',Object.assign(new Error('local coded callback fault'),{code:'FACT_PRECONDITION_STALE'})],
  ['null',null],['undefined',undefined],['false',false],['zero',0],['empty-string',''],['NaN',NaN],['zero-bigint',0n],
]
it.each(callbackFaults)('R1-P05 preserves %s callback rejection identity and spends the marker on warm/cold retry',async(_label,fault)=>{
  const {root,coordinator}=await setup(),r=request();let captures=0
  const outcome=await coordinator.bootstrapSemanticTargetWithCapture!(r,guards,async()=>{captures++;throw fault}).then(value=>({kind:'resolved' as const,value}),error=>({kind:'rejected' as const,error}))
  expect(outcome.kind).toBe('rejected');if(outcome.kind==='rejected')expect(outcome.error).toBe(fault)
  const original=await readFile(stagePath(root,r));expect(original).toEqual(Buffer.from(p.encodeBootstrapCaptureReservation({version:1,kind:'semantic-bootstrap-capture',request:r})))
  expect(await coordinator.bootstrapSemanticTargetWithCapture!(r,guards,async()=>{captures++;return payload(r)})).toMatchObject({kind:'blocked',reason:'payload-required'})
  await coordinator.close();const cold=await setup(root)
  expect(await cold.coordinator.bootstrapSemanticTargetWithCapture!(r,guards,async()=>{captures++;return payload(r)})).toMatchObject({kind:'blocked',reason:'payload-required'})
  expect(await cold.coordinator.bootstrapSemanticTarget(payload(r),guards)).toMatchObject({kind:'blocked',reason:'payload-required'})
  expect(captures).toBe(1);expect(await readFile(stagePath(root,r))).toEqual(original)
})
it.each(callbackFaults)('R1-P05 retains original %s callback value beside actual same-owner cleanup failure',async(_label,fault)=>{
  const {root,backend}=await setup(),r=request(),ownership=createOwnership({lockRoot:root},{lock:{enabled:true}}),entries=new Map<string,ManagedEntry>(),native=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const owner=createBootstrapOwner(backend,ownership,entries,()=>{throw new Error('faulted capture must not attach a target')},createMutations(backend,ownership,200,()=>{}))
  const cleanupFault=new Error('original readback close failed'),originalFaults:unknown[]=[];let failClose=false,captures=0,closes=0
  vi.mocked(open).mockImplementation(async(...args)=>{const handle=await native.open(...args);if(!failClose||!String(args[0]).endsWith('.stage')||args[1]!=='r')return handle
    return new Proxy(handle,{get(target,name){if(name==='close')return async()=>{closes++;if(failClose)throw cleanupFault;return target.close()};const value=Reflect.get(target,name);return typeof value==='function'?value.bind(target):value}})})
  try{
    const outcome=await owner.bootstrapSemanticTargetWithCapture(r,guards,async()=>{
      captures++;const io=entries.get('target')!.captureIO!;expect(io.settled).toBe(true)
      // Inject a real outstanding read under this retained original owner. The
      // private-entry flag models the IO issue, without creating replacement
      // authority or a fake success from the backend.
      io.settled=false;failClose=true
      try{await backend.readBootstrapCapture!('target',io.held,r)}catch(error){originalFaults.push(error)}
      throw fault
    }).then(value=>({kind:'resolved' as const,value}),error=>({kind:'rejected' as const,error}))
    expect(outcome.kind).toBe('rejected')
    if(outcome.kind==='rejected'){expect(outcome.error).toBeInstanceOf(AggregateError);expect((outcome.error as AggregateError).errors).toHaveLength(2);expect((outcome.error as AggregateError).errors[0]).toBe(fault);expect((outcome.error as AggregateError).errors[1]).toBeInstanceOf(AggregateError);expect(((outcome.error as AggregateError).errors[1] as AggregateError).errors).toContain(cleanupFault)}
    expect(captures).toBe(1);expect(originalFaults).toEqual([cleanupFault]);expect(closes).toBeGreaterThanOrEqual(2)
    expect(JSON.parse(await readFile(stagePath(root,r),'utf8')).kind).toBe('semantic-bootstrap-capture')
  }finally{failClose=false;for(const entry of entries.values())await owner.releaseCapture(entry);await Promise.all(ownership.releaseHeldLocks());vi.mocked(open).mockImplementation(native.open)}
})
it.each(['invalid','stale','stop'] as const)('P05 %s callback result spends its original reservation permanently without callback2',async cut=>{
  const {root,coordinator}=await setup(),r=request(),controller=new AbortController();let fresh=true,captures=0
  const current={...guards,signal:controller.signal,assertCurrent(){if(!fresh)throw new Error('actual source changed')}}
  const first=await coordinator.bootstrapSemanticTargetWithCapture!(r,current,async()=>{captures++;if(cut==='stale')fresh=false;if(cut==='stop')controller.abort();return cut==='invalid'?{...payload(r),metadata:{title:'changed'}}:payload(r)})
  expect(first).toMatchObject(cut==='invalid'?{kind:'refused',reason:'manifest-invalid'}:{kind:'blocked'})
  fresh=true;expect(await coordinator.bootstrapSemanticTargetWithCapture!(r,guards,async()=>{captures++;return payload(r)})).toMatchObject({kind:'blocked',reason:'payload-required'})
  expect(captures).toBe(1);expect(JSON.parse(await readFile(stagePath(root,r),'utf8')).kind).toBe('semantic-bootstrap-capture');await coordinator.close()
})
it('P07 rejects a missing root before native claim mkdir and future namespace never becomes absent', async () => {
  const { root, coordinator } = await setup(), r = request(); await rm(root, { recursive: true })
  expect(await coordinator.inspectBootstrapCapture!(r)).toEqual({ kind: 'unavailable' }); await expect(readdir(root)).rejects.toMatchObject({ code: 'ENOENT' })
  const fresh = await setup(); await writeFile(stagePath(fresh.root, r).replace(/\.stage$/, '.future'), 'future')
  expect(await fresh.coordinator.inspectBootstrapCapture!(r)).toEqual({ kind: 'unavailable' })
  expect((await fresh.coordinator.bootstrapSemanticTarget(payload(r), guards)).kind).not.toBe('ready')
  await expect(fresh.coordinator.create({sessionId:'target'})).rejects.toThrow()
})
it('P11 generic predecessor bootstrap still creates a missing store root while new capture refuses it',async()=>{
  const {root,coordinator}=await setup(),r=request();await rm(root,{recursive:true})
  const original={...payload(r),seed:p.compileSemanticSeed({kind:'none'})}
  expect((await coordinator.bootstrapSemanticTarget(original,guards)).kind).toBe('ready')
})
async function copyStore(root:string) {
  const cold=await setup()
  for(const name of await readdir(root))if(name.includes('.jsonl'))await copyFile(join(root,name),join(cold.root,name))
  return cold
}
it('P03 zero-capture stale guard is retryable under the original resolved metadata',async()=>{
  const {root,coordinator}=await setup(),r=request();let captures=0
  expect(await coordinator.bootstrapSemanticTargetWithCapture!(r,{...guards,assertCurrent(){throw new Error('busy source')}},async()=>{captures++;return payload(r)})).toEqual({kind:'not-issued',reason:'stale-source'})
  expect((await readdir(root)).some(name=>name.includes('.stage'))).toBe(false)
  expect((await coordinator.bootstrapSemanticTargetWithCapture!(r,guards,async()=>{captures++;return payload(r)})).kind).toBe('ready');expect(captures).toBe(1)
})
it('P04 an actual second coordinator conflicts on native ownership during the original capture',async()=>{
  const {root,coordinator}=await setup(),other=await setup(root),r=request(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let captures=0
  const first=coordinator.bootstrapSemanticTargetWithCapture!(r,guards,async()=>{captures++;entered.resolve();await release.promise;return payload(r)})
  try{await entered.promise;expect(await other.coordinator.inspectBootstrapCapture!(r)).toEqual({kind:'conflict'});await expect(other.coordinator.bootstrapSemanticTargetWithCapture!(r,guards,async()=>{captures++;return payload(r)})).rejects.toThrow()}finally{release.resolve();await first}
  expect(captures).toBe(1)
})
it.each(['zero','partial','sync','readback','close'] as const)('P06/P18 required reservation %s failure never exports and cold reopen stays fenced',async cut=>{
  const {root,coordinator}=await setup(),r=request(),native=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');let captures=0,fail=true
  vi.mocked(open).mockImplementation(async(...args)=>{
    const h=await native.open(...args);if(!String(args[0]).endsWith('.stage'))return h
    return new Proxy(h,{get(target,name){
      if(name==='write'&&(cut==='zero'||cut==='partial'))return async(buffer:Uint8Array,offset:number,length:number,position:number)=>{if(fail){fail=false;if(cut==='zero')return {bytesWritten:0,buffer};await target.write(buffer,offset,13,position);throw new Error('actual partial reservation')}return target.write(buffer,offset,length,position)}
      if(name==='sync'&&cut==='sync')return async()=>{if(fail){fail=false;throw new Error('required sync failure')}return target.sync()}
      if(name==='readFile'&&cut==='readback')return async()=>{if(fail){fail=false;throw new Error('required readback failure')}return target.readFile()}
      if(name==='close'&&cut==='close')return async()=>{if(fail&&args[1]==='wx'){fail=false;throw new Error('close before native action')}return target.close()}
      const value=Reflect.get(target,name);return typeof value==='function'?value.bind(target):value
    }})
  })
  try{expect(await coordinator.bootstrapSemanticTargetWithCapture!(r,guards,async()=>{captures++;return payload(r)})).toMatchObject({kind:'blocked'});expect(captures).toBe(0)}finally{vi.mocked(open).mockImplementation(native.open)}
  const before=await readFile(stagePath(root,r)),cold=await copyStore(root)
  expect(await cold.coordinator.bootstrapSemanticTargetWithCapture!(r,guards,async()=>{captures++;return payload(r)})).toMatchObject({kind:'blocked'})
  expect(await readFile(stagePath(root,r))).toEqual(before);expect(captures).toBe(0)
})
it.each(['partial','rename-before','rename-after'] as const)('P09/P10 %s promotion cut preserves original fence, cold payload rules and warm exact continuation',async cut=>{
  const {root,coordinator}=await setup(),r=request(),original=payload(r),native=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');let captures=0,fail=true
  vi.mocked(open).mockImplementation(async(...args)=>{const h=await native.open(...args);if(!String(args[0]).endsWith('.promote')||cut!=='partial')return h;return new Proxy(h,{get(target,name){if(name==='write')return async(buffer:Uint8Array,offset:number,length:number,position:number)=>{if(fail){fail=false;await target.write(buffer,offset,19,position);throw new Error('partial original promote')}return target.write(buffer,offset,length,position)};const value=Reflect.get(target,name);return typeof value==='function'?value.bind(target):value}})})
  vi.mocked(rename).mockImplementation(async(...args)=>{if(String(args[0]).endsWith('.promote')&&fail){fail=false;if(cut==='rename-after')await native.rename(...args);throw new Error('original rename cut')}return native.rename(...args)})
  try{expect(await coordinator.bootstrapSemanticTargetWithCapture!(r,guards,async()=>{captures++;return original})).toMatchObject({kind:'blocked'})}finally{vi.mocked(open).mockImplementation(native.open);vi.mocked(rename).mockImplementation(native.rename)}
  const before=await readFile(stagePath(root,r)),cold=await copyStore(root)
  if(cut==='rename-after'){
    const stage=p.parseBootstrapHeaderStage(before)
    expect(buildBootstrapHeader(original,stage).operation.stageBytes).toEqual(before)
    expect(()=>buildBootstrapHeader(original,{...stage,captureReservation:undefined} as any)).toThrow()
    expect(()=>buildBootstrapHeader(original,stage,undefined,undefined)).toThrow()
    for(const captureReservation of [null,false,0])expect(()=>p.parseBootstrapHeaderStage(Buffer.from(canonicalJsonData({...stage,captureReservation})+'\n'))).toThrow()
    expect((await cold.coordinator.resumeSemanticTarget(r.invocation,guards,original)).kind).toBe('ready')
  }else{
    expect(JSON.parse(before.toString()).kind).toBe('semantic-bootstrap-capture')
    expect(await cold.coordinator.resumeSemanticTarget(r.invocation,guards,original)).toMatchObject({kind:'blocked',reason:'payload-required'})
    expect(await cold.coordinator.bootstrapSemanticTargetWithCapture!(r,guards,async()=>{captures++;return original})).toMatchObject({kind:'blocked'})
  }
  expect((await coordinator.bootstrapSemanticTargetWithCapture!(r,guards,async()=>{captures++;throw new Error('no callback2')})).kind).toBe('ready');expect(captures).toBe(1)
})
it.each(['sync','readback','close'] as const)('P09 required promotion %s failure leaves original stage and retries exact payload without callback2',async cut=>{
  const {root,coordinator}=await setup(),r=request(),native=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');let captures=0,fail=true
  vi.mocked(open).mockImplementation(async(...args)=>{const h=await native.open(...args);if(!String(args[0]).endsWith('.promote'))return h;return new Proxy(h,{get(target,name){
    if((name==='sync'&&cut==='sync')||(name==='readFile'&&cut==='readback')||(name==='close'&&cut==='close'))return async()=>{if(fail){fail=false;throw new Error('required promotion '+cut)}return name==='sync'?target.sync():name==='close'?target.close():target.readFile()}
    const value=Reflect.get(target,name);return typeof value==='function'?value.bind(target):value
  }})})
  try{expect(await coordinator.bootstrapSemanticTargetWithCapture!(r,guards,async()=>{captures++;return payload(r)})).toMatchObject({kind:'blocked'})}finally{vi.mocked(open).mockImplementation(native.open)}
  expect(JSON.parse(await readFile(stagePath(root,r),'utf8')).kind).toBe('semantic-bootstrap-capture')
  expect((await coordinator.bootstrapSemanticTargetWithCapture!(r,guards,async()=>{captures++;return payload(r)})).kind).toBe('ready');expect(captures).toBe(1)
})
it('P06 actual process interruption after confirmed reservation before callback keeps the original durable fence',async()=>{
  const {root,coordinator}=await setup(),r=request();await coordinator.close()
  const script=join(root,'capture-child.mjs'),persistenceURL=pathToFileURL(fileURLToPath(new URL('../../session-persistence/src/index.ts',import.meta.url))).href,backendURL=pathToFileURL(fileURLToPath(new URL('../src/index.ts',import.meta.url))).href
  await writeFile(script,`import {createSessionCoordinator} from ${JSON.stringify(persistenceURL)};import {createJsonlBackend} from ${JSON.stringify(backendURL)};
const request=${JSON.stringify(r)},backend=createJsonlBackend(${JSON.stringify(root)}),coordinator=createSessionCoordinator(backend,{lock:{enabled:true}});
await coordinator.create({sessionId:'source'});await coordinator.append('source',[{type:'turn/start'},{type:'user/message',text:'actual child source'},{type:'turn/end'}]);const source=await coordinator.openManagedDocument('source');
const prepare=backend.prepareBootstrapCapture;backend.prepareBootstrapCapture=async(...args)=>{const result=await prepare(...args);if(result.kind!=='committed-new')throw new Error('reservation did not commit');process.stdout.write('confirmed-reservation\\n');await new Promise(()=>{});return result};
await coordinator.bootstrapSemanticTargetWithCapture(request,{assertCurrent(){source.assertReady()},dependencies:{async confirm(){throw new Error('no artifacts')},async reconcile(){throw new Error('no artifacts')}}},async()=>{process.stdout.write('forbidden-callback\\n');throw new Error('callback must not enter')});`)
  const child=spawn(process.execPath,['--import','tsx',script],{cwd:process.cwd(),windowsHide:true,stdio:['ignore','pipe','pipe']}),confirmed=Promise.withResolvers<void>();let output='',errors=''
  child.stdout.on('data',bytes=>{output+=String(bytes);if(output.includes('confirmed-reservation\n'))confirmed.resolve()});child.stderr.on('data',bytes=>{errors+=String(bytes)})
  const exited=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',()=>{if(!output.includes('confirmed-reservation\n'))confirmed.reject(new Error('child exited before barrier: '+errors));resolve()})})
  try{await confirmed.promise;expect(output).not.toContain('forbidden-callback');child.kill();await exited}finally{if(child.exitCode===null)child.kill();await exited}
  const before=await readFile(stagePath(root,r)),cold=await setup(root);let captures=0
  expect(await cold.coordinator.bootstrapSemanticTargetWithCapture!(r,guards,async()=>{captures++;return payload(r)})).toMatchObject({kind:'blocked',reason:'payload-required'});expect(captures).toBe(0);expect(await readFile(stagePath(root,r))).toEqual(before)
  console.log(JSON.stringify({control:'P06 actual process cut',confirmedReservation:true,childCallback:0,coldCallback:captures}))
},20000)
it('P10 cold full promoted ready stage retains exact optional bytes and accepts ordinary metadata edits',async()=>{
  const {root,backend,coordinator}=await setup(),r=request(),original=payload(r)
  expect((await coordinator.bootstrapSemanticTargetWithCapture!(r,guards,async()=>original)).kind).toBe('ready')
  const before=await readFile(stagePath(root,r));await coordinator.close()
  await backend.updateMeta('target',{title:'later',workspaceId:'another',modelSelection:{provider:'p',model:'m'}})
  const cold=await setup(root);expect((await cold.coordinator.resumeSemanticTarget(r.invocation,guards,original)).kind).toBe('already-ready');expect(await readFile(stagePath(root,r))).toEqual(before)
})
it('P12 existing source ManagedDocument and exact outer F0 permit one capture without target profile',async()=>{
  const {coordinator}=await setup(),r=request()
  await coordinator.create({sessionId:'source'});await coordinator.append('source',[{type:'turn/start'},{type:'user/message',text:'physical source'},{type:'turn/end'}])
  const source=await coordinator.openManagedDocument('source')
  const result=await coordinator.withSessionBindingObservation!({existingSessionIds:['source'],target:r.invocation},async observation=>{
    return coordinator.bootstrapSemanticTargetWithCapture!(r,{...guards,assertCurrent(){observation.assertCurrent();source.assertReady()}},async()=>{
      await expect(coordinator.profile('target')).rejects.toThrow()
      const exported=exportConversationSeed(source.view,{kind:'session',sessionId:'source'},r.core.selection)
      if(exported.kind!=='seed')throw new Error('physical source refused')
      return {...payload(r),seed:p.compileSemanticSeed(exported)}
    })
  })
  expect(result.kind).toBe('ready')
})
it('P13 direct callback self-waits refuse before revoking its original current guard',async()=>{
  const {coordinator}=await setup(),r=request();let checks=0
  const actual={...guards,assertCurrent(){checks++}}
  const result=await coordinator.bootstrapSemanticTargetWithCapture!(r,actual,async()=>{
    expect(await coordinator.bootstrapSemanticTarget(payload(r),guards)).toEqual({kind:'refused',reason:'conflict'})
    expect(await coordinator.resumeSemanticTarget(r.invocation,guards)).toEqual({kind:'refused',reason:'conflict'})
    expect(await coordinator.bootstrapSemanticTargetWithCapture!(r,guards,async()=>payload(r))).toEqual({kind:'refused',reason:'conflict'})
    await expect(coordinator.close()).rejects.toMatchObject({reason:'conflict'})
    await expect(coordinator.closeManagedDocument('target')).rejects.toMatchObject({reason:'conflict'})
    await expect(coordinator.deleteOwnedSession!('target',{documents:[]})).rejects.toMatchObject({reason:'conflict'})
    actual.assertCurrent();return payload(r)
  })
  expect(result.kind).toBe('ready');expect(checks).toBeGreaterThan(1)
})
it('P14 original held.owner identity persists through promotion, settlement and close; equal tokens cannot settle',async()=>{
  const {root,backend,coordinator}=await setup(),r=request(),helds:p.HeldFactOwner[]=[],issuers:p.IssuingFactOwner[]=[]
  const read=backend.readBootstrapCapture!,settle=backend.settleBootstrapCaptureIO!,prepare=backend.prepareBootstrapCapture!,header=backend.prepareBootstrapHeader!
  backend.readBootstrapCapture=async(id,held,request)=>{helds.push(held);return read(id,held,request)}
  backend.settleBootstrapCaptureIO=async(id,held)=>{helds.push(held);return settle(id,held)}
  backend.prepareBootstrapCapture=async(id,issuer,bytes)=>{issuers.push(issuer);return prepare(id,issuer,bytes)}
  backend.prepareBootstrapHeader=async(id,issuer,op)=>{issuers.push(issuer);return header(id,issuer,op)}
  expect((await coordinator.bootstrapSemanticTargetWithCapture!(r,guards,async()=>payload(r))).kind).toBe('ready')
  const held=helds[0]!,ownership=createOwnership({lockRoot:root},{lock:{enabled:true}})
  // A separate constructor clones even equal owner values. Its forged cleanup
  // never reaches the original ledger, irrespective of equality.
  const replacement=heldFactOwner(held.owner,ownership,()=>{})
  expect(replacement.owner).not.toBe(held.owner)
  await expect(settle('target',replacement)).rejects.toThrow()
  expect(helds.every(value=>value===held)).toBe(true);expect(issuers.every(value=>value===issuers[0]&&value.owner===held.owner)).toBe(true)
  await coordinator.close();expect(()=>held.assertHeld()).toThrow()
})
it('P14/P15 external close joins late original open and never authorizes capture after revoke',async()=>{
  const {root,coordinator}=await setup(),r=request(),native=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let captures=0,closed=false,handles=0
  vi.mocked(open).mockImplementation(async(...args)=>{const h=await native.open(...args);if(!String(args[0]).endsWith('.stage')||args[1]!=='wx')return h;handles++;entered.resolve();await release.promise;return new Proxy(h,{get(target,name){if(name==='close')return async()=>{await target.close();handles--};const value=Reflect.get(target,name);return typeof value==='function'?value.bind(target):value}})})
  const running=coordinator.bootstrapSemanticTargetWithCapture!(r,guards,async()=>{captures++;return payload(r)})
  try{await entered.promise;const closing=coordinator.close().then(()=>{closed=true});await Promise.resolve();expect(closed).toBe(false);release.resolve();expect(await running).toMatchObject({kind:'blocked'});await closing;expect(handles).toBe(0);expect(captures).toBe(0);expect(await readFile(stagePath(root,r))).toBeDefined()}finally{release.resolve();vi.mocked(open).mockImplementation(native.open)}
})
it('P16 ready captured deletion inventories promote and leaves a tombstone that prevents replay',async()=>{
  const {root,backend,coordinator}=await setup(),r=request()
  expect((await coordinator.bootstrapSemanticTargetWithCapture!(r,guards,async()=>payload(r))).kind).toBe('ready')
  const pending=stagePath(root,r).replace(/\.stage$/,'.promote');await writeFile(pending,'retained pending bytes')
  await coordinator.deleteOwnedSession!('target',{documents:[]})
  const receipt=await backend.deletionReceipt!('target');expect(receipt!.manifest.files!.some(name=>name.endsWith('.promote'))).toBe(true)
  const cold=await setup(root);expect(await cold.coordinator.inspectBootstrapCapture!(r)).toEqual({kind:'unavailable'})
})
it('P13 external delete joins the whole original capture before backend deletion and keeps headerless fence',async()=>{
  const {root,backend,coordinator}=await setup(),r=request(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let backendDeletes=0,deleted=false
  const actual=backend.deleteOwnedSession!;backend.deleteOwnedSession=async(...args)=>{backendDeletes++;return actual(...args)}
  const running=coordinator.bootstrapSemanticTargetWithCapture!(r,guards,async()=>{entered.resolve();await release.promise;return payload(r)})
  await entered.promise
  const deletion=coordinator.deleteOwnedSession!('target',{documents:[]}).finally(()=>{deleted=true}),refused=expect(deletion).rejects.toThrow()
  try{await Promise.resolve();await Promise.resolve();expect(deleted).toBe(false);expect(backendDeletes).toBe(0)}finally{release.resolve()}
  expect(await running).toMatchObject({kind:'blocked'});await refused;expect(await readFile(stagePath(root,r))).toBeDefined()
})
it.each(['root','claim','read','settle'] as const)('P14 strict inspection close joins the original %s whole lifetime without target cache',async cut=>{
  const {root,backend,coordinator}=await setup(),r=request(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),native=await vi.importActual<typeof import('../../fs-lock/src/index.ts')>('../../fs-lock/src/index.ts');let closed=false,reads=0,acquires=0,releases=0,held:p.HeldFactOwner|undefined
  const rootCheck=backend.checkBootstrapCaptureRoot!,read=backend.readBootstrapCapture!,settle=backend.settleBootstrapCaptureIO!
  backend.checkBootstrapCaptureRoot=async()=>{await rootCheck();if(cut==='root'){entered.resolve();await release.promise}}
  vi.mocked(acquireSessionLock).mockImplementation(async options=>{const raw=await native.acquireSessionLock(options);acquires++;if(cut==='claim'){entered.resolve();await release.promise}return {get held(){return raw.held},async release(){await raw.release();releases++}}})
  backend.readBootstrapCapture=async(id,owner,request)=>{reads++;held=owner;if(cut==='read'){entered.resolve();await release.promise}return read(id,owner,request)}
  backend.settleBootstrapCaptureIO=async(id,owner)=>{expect(owner).toBe(held);owner.assertHeld();if(cut==='settle'){entered.resolve();await release.promise}return settle(id,owner)}
  const running=coordinator.inspectBootstrapCapture!(r)
  try{await entered.promise;const closing=coordinator.close().then(()=>{closed=true});await Promise.resolve();expect(closed).toBe(false);release.resolve();expect(await running).toEqual({kind:'unavailable'});await closing;expect(releases).toBe(acquires);expect(coordinator.ownerOf('target')).toBe(false);expect(await readdir(root)).not.toContain('target.jsonl');if(cut==='root')expect(reads).toBe(0)}finally{release.resolve();vi.mocked(acquireSessionLock).mockImplementation(native.acquireSessionLock)}
})
it('P14 close joins pending inspection even when independent original observation cleanup fails',async()=>{
  const {backend,coordinator}=await setup(),r=request(),native=await vi.importActual<typeof import('../../fs-lock/src/index.ts')>('../../fs-lock/src/index.ts')
  await coordinator.create({sessionId:'source'})
  const observationEntered=Promise.withResolvers<void>(),leaveObservation=Promise.withResolvers<void>(),rootEntered=Promise.withResolvers<void>(),leaveRoot=Promise.withResolvers<void>();let acquisitions=0,allowRelease=false,closed=false
  vi.mocked(acquireSessionLock).mockImplementation(async options=>{const raw=await native.acquireSessionLock(options),index=++acquisitions;return {get held(){return raw.held},async release(){if(index===2&&!allowRelease)throw new Error('original observation release debt');return raw.release()}}})
  const observing=coordinator.withSessionBindingObservation!({existingSessionIds:['source'],target:{...r.invocation,targetSessionId:'observed'}},async()=>{observationEntered.resolve();await leaveObservation.promise})
  const observationFailure=expect(observing).rejects.toThrow();await observationEntered.promise
  const root=backend.checkBootstrapCaptureRoot!;backend.checkBootstrapCaptureRoot=async()=>{await root();rootEntered.resolve();await leaveRoot.promise}
  const inspecting=coordinator.inspectBootstrapCapture!(r);await rootEntered.promise
  const closing=coordinator.close().finally(()=>{closed=true}),closeFailure=expect(closing).rejects.toThrow()
  try{leaveObservation.resolve();await observationFailure;expect(closed).toBe(false);leaveRoot.resolve();expect(await inspecting).toEqual({kind:'unavailable'});await closeFailure;expect(coordinator.ownerOf('target')).toBe(false);expect(coordinator.ownerOf('source')).toBe(true);allowRelease=true;await coordinator.close();expect(coordinator.ownerOf('source')).toBe(false)}finally{allowRelease=true;leaveRoot.resolve();leaveObservation.resolve();vi.mocked(acquireSessionLock).mockImplementation(native.acquireSessionLock)}
})
it('P14 inspection cleanup retries its exact original handle/held and does not release a live adopter',async()=>{
  const {root,backend,coordinator}=await setup(),r=request(),native=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');await coordinator.create({sessionId:'target'});await writeFile(stagePath(root,r),p.encodeBootstrapCaptureReservation({version:1,kind:'semantic-bootstrap-capture',request:r}))
  let closes=0,releaseClose=false,original:p.HeldFactOwner|undefined;const helds:p.HeldFactOwner[]=[],settle=backend.settleBootstrapCaptureIO!
  backend.settleBootstrapCaptureIO=async(id,held)=>{if(id==='target'){helds.push(held);original??=held;expect(held).toBe(original)}return settle(id,held)}
  vi.mocked(open).mockImplementation(async(...args)=>{const h=await native.open(...args);if(!String(args[0]).endsWith('.stage'))return h;return new Proxy(h,{get(target,name){if(name==='close')return async()=>{closes++;if(!releaseClose)throw new Error('original inspection close failure');return target.close()};const value=Reflect.get(target,name);return typeof value==='function'?value.bind(target):value}})})
  try{
    await expect(coordinator.inspectBootstrapCapture!(r)).rejects.toThrow('cleanup unresolved');expect(coordinator.ownerOf('target')).toBe(true);original!.assertHeld()
    // Separate ordinary inspection must not retry the retained debtor.
    const before=closes;expect(await coordinator.inspectBootstrapCapture!({...r,invocation:{...r.invocation,targetSessionId:'other'}})).toEqual({kind:'absent'});expect(closes).toBe(before)
    releaseClose=true;await coordinator.close();expect(closes).toBe(3);expect(coordinator.ownerOf('target')).toBe(false);expect(()=>original!.assertHeld()).toThrow()
  }finally{releaseClose=true;vi.mocked(open).mockImplementation(native.open)}
})
it('P14 original backend ledger refuses an equal valid held clone under the same real native claim',async()=>{
  const {root,backend}=await setup(),r=request(),ownership=createOwnership({lockRoot:root},{lock:{enabled:true}}),claim=await ownership.pinOwnership('target'),input={sessionId:'target',incarnation:'same-values'}
  const original=heldFactOwner(input,ownership,()=>claim.assertHeld()),replacement=heldFactOwner(input,ownership,()=>claim.assertHeld())
  try{expect(original.owner).not.toBe(input);expect(await backend.readBootstrapCapture!('target',original,r)).toEqual({kind:'absent'});await expect(backend.settleBootstrapCaptureIO!('target',replacement)).rejects.toThrow('Original capture IO owner required');await backend.settleBootstrapCaptureIO!('target',original)}finally{await claim.release()}
})
it('P14/P15 consumed native file close stays debt and capture never runs during explicit close retry',async()=>{
  const {root,coordinator}=await setup(),r=request(),native=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');let captures=0,closes=0
  vi.mocked(open).mockImplementation(async(...args)=>{const h=await native.open(...args);if(!String(args[0]).endsWith('.stage')||args[1]!=='wx')return h;return new Proxy(h,{get(target,name){if(name==='close')return async()=>{closes++;await target.close();throw new Error('consumed original close')};const value=Reflect.get(target,name);return typeof value==='function'?value.bind(target):value}})})
  try{await expect(coordinator.bootstrapSemanticTargetWithCapture!(r,guards,async()=>{captures++;return payload(r)})).rejects.toThrow('cleanup unresolved');await expect(coordinator.close()).rejects.toThrow();await expect(coordinator.close()).rejects.toThrow();expect(closes).toBe(1);expect(captures).toBe(0);expect(coordinator.ownerOf('target')).toBe(true);expect(await readFile(stagePath(root,r))).toBeDefined()}finally{vi.mocked(open).mockImplementation(native.open)}
})
it('P17 reservation invokes no target preparation, dependency or profile work before actual capture',async()=>{
  const {backend,coordinator}=await setup(),r=request();let preparing=0,profiles=0
  const profile=backend.profile;backend.profile=async(...args)=>{profiles++;return profile(...args)}
  const port={async confirm():Promise<never>{preparing++;throw new Error('actual target policy trap')},async reconcile():Promise<never>{preparing++;throw new Error('actual target policy trap')},assertTargetCurrent(){}}
  expect(await coordinator.bootstrapSemanticTargetWithCapture!(r,{...guards,targetPreparation:port},async()=>{expect(preparing).toBe(0);expect(profiles).toBe(0);return payload(r)})).toMatchObject({kind:'blocked',reason:'dependency-unavailable'});expect(preparing).toBe(1)
})
it('P18 new capture on Windows intentionally performs no optional directory open',async()=>{
  const {root,coordinator}=await setup(),r=request(),native=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');let directories=0
  vi.mocked(open).mockImplementation(async(...args)=>{if(String(args[0])===root)directories++;return native.open(...args)})
  expect((await coordinator.bootstrapSemanticTargetWithCapture!(r,guards,async()=>payload(r))).kind).toBe('ready');expect(directories).toBe(0)
  console.log(JSON.stringify({control:'P18 directory scope',platform:process.platform,optionalDirectoryAttempted:false,guarantee:'process-interruption/restart'}))
})
it('P01 new capture rejects accessor/proxy host arguments without evaluating them or IO',async()=>{
  const {root,coordinator}=await setup(),r=request();let reads=0,captures=0
  const accessor=Object.defineProperty({...guards},'assertCurrent',{enumerable:true,get(){reads++;return ()=>{}}})
  expect(await coordinator.bootstrapSemanticTargetWithCapture!(r,accessor,async()=>{captures++;return payload(r)})).toEqual({kind:'refused',reason:'manifest-invalid'})
  expect(await coordinator.bootstrapSemanticTargetWithCapture!(r,new Proxy(guards,{}),async()=>{captures++;return payload(r)})).toEqual({kind:'refused',reason:'manifest-invalid'})
  expect(reads).toBe(0);expect(captures).toBe(0);expect((await readdir(root)).filter(name=>name.includes('.stage'))).toEqual([])
})
it('P07 generic payload cannot complete an uncertain zero-byte stage or future promotion',async()=>{
  const {root,coordinator}=await setup(),r=request();await writeFile(stagePath(root,r),'')
  expect((await coordinator.bootstrapSemanticTarget(payload(r),guards)).kind).not.toBe('ready');expect(await readFile(stagePath(root,r))).toHaveLength(0)
  const other=await setup();expect((await other.coordinator.bootstrapSemanticTargetWithCapture!(r,guards,async()=>payload(r))).kind).toBe('ready')
  await other.coordinator.close();await writeFile(stagePath(other.root,r).replace(/\.stage$/,'.promote'),'{"version":2,"kind":"future"}\n')
  const cold=await setup(other.root);expect(await cold.coordinator.inspectBootstrapCapture!(r)).toEqual({kind:'unavailable'});expect((await cold.coordinator.resumeSemanticTarget(r.invocation,guards,payload(r))).kind).not.toBe('already-ready')
})
it('P14 capture claim release failure retains the exact entry release capability for explicit close retry',async()=>{
  const {coordinator}=await setup(),r=request(),native=await vi.importActual<typeof import('../../fs-lock/src/index.ts')>('../../fs-lock/src/index.ts');let releases=0
  vi.mocked(acquireSessionLock).mockImplementation(async options=>{const raw=await native.acquireSessionLock(options);return {get held(){return raw.held},async release(){if(++releases===1)throw new Error('original release before native');await raw.release()}}})
  try{
    await expect(coordinator.bootstrapSemanticTargetWithCapture!(r,guards,async()=>{throw new Error('spent')})).rejects.toThrow('spent')
    await expect(coordinator.close()).rejects.toThrow();expect(releases).toBe(1);await coordinator.close();expect(releases).toBe(2);expect(coordinator.ownerOf('target')).toBe(false)
  }finally{vi.mocked(acquireSessionLock).mockImplementation(native.acquireSessionLock)}
})
it('P14 consumed native capture claim release remains original debt across close retries without replacement',async()=>{
  const {coordinator}=await setup(),r=request(),native=await vi.importActual<typeof import('../../fs-lock/src/index.ts')>('../../fs-lock/src/index.ts');let releases=0,acquisitions=0
  vi.mocked(acquireSessionLock).mockImplementation(async options=>{acquisitions++;const raw=await native.acquireSessionLock(options);return {get held(){return raw.held},async release(){releases++;await raw.release();throw new Error('consumed original capture claim')}}})
  try{
    await expect(coordinator.bootstrapSemanticTargetWithCapture!(r,guards,async()=>{throw new Error('spent callback')})).rejects.toThrow('spent callback')
    await expect(coordinator.close()).rejects.toThrow();await expect(coordinator.close()).rejects.toThrow()
    expect(releases).toBe(1);expect(acquisitions).toBe(1);expect(coordinator.ownerOf('target')).toBe(false)
  }finally{vi.mocked(acquireSessionLock).mockImplementation(native.acquireSessionLock)}
})
const predecessorLiteral = {"stage":"{\"headerBase\":{\"createdAt\":\"2026-10-23T00:00:00.000Z\",\"formatVersion\":11,\"journal\":{\"legacyBodyBytes\":0,\"legacyEventCount\":0,\"legacyPrefixDigest\":\"1e9f8adb040e92789e005f089d72c73c7cc54d3f73fda753a381447798fd5868\",\"separatorBytes\":0,\"version\":1},\"origin\":\"fork\",\"parentSession\":\"source\",\"seedLength\":0,\"sessionId\":\"target\",\"title\":\"literal original\"},\"headerBytes\":\"{\\\"createdAt\\\":\\\"2026-10-23T00:00:00.000Z\\\",\\\"formatVersion\\\":11,\\\"journal\\\":{\\\"legacyBodyBytes\\\":0,\\\"legacyEventCount\\\":0,\\\"legacyPrefixDigest\\\":\\\"1e9f8adb040e92789e005f089d72c73c7cc54d3f73fda753a381447798fd5868\\\",\\\"separatorBytes\\\":0,\\\"version\\\":1},\\\"origin\\\":\\\"fork\\\",\\\"parentSession\\\":\\\"source\\\",\\\"seedLength\\\":0,\\\"semanticSeed\\\":{\\\"codec\\\":\\\"semantic-seed-v1\\\",\\\"dependencyDigest\\\":\\\"7fd4c9f0169abf80e5e11e8cab2e06d9e8bf8bf2cd3d9ee63e17ea0345c6a29c\\\",\\\"groupCount\\\":0,\\\"manifestDigest\\\":\\\"5a255899e40ddb1db47d6621805827e244998da2f1b73eb0944d7ce1e8a90b6b\\\",\\\"operationId\\\":\\\"literal-old\\\",\\\"requestDigest\\\":\\\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\\",\\\"seedDigest\\\":\\\"f682547f170c025d0519512768a13bd41a570527aa5aee1c3f69be82424f2498\\\",\\\"seedLength\\\":0,\\\"version\\\":1},\\\"sessionId\\\":\\\"target\\\",\\\"title\\\":\\\"literal original\\\"}\\n\",\"invocation\":{\"createdAt\":\"2026-10-23T00:00:00.000Z\",\"operationId\":\"literal-old\",\"requestDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"targetSessionId\":\"target\",\"version\":1},\"kind\":\"semantic-bootstrap-header\",\"lineage\":{\"origin\":\"fork\",\"parentSession\":\"source\"},\"metadata\":{\"title\":\"literal original\"},\"originalTarget\":{\"kind\":\"new\"},\"seed\":{\"dependencyDigest\":\"7fd4c9f0169abf80e5e11e8cab2e06d9e8bf8bf2cd3d9ee63e17ea0345c6a29c\",\"digest\":\"f682547f170c025d0519512768a13bd41a570527aa5aee1c3f69be82424f2498\",\"groupCount\":0,\"seedLength\":0,\"sourceObservation\":{\"kind\":\"none\"}},\"version\":1}\n","header":"{\"createdAt\":\"2026-10-23T00:00:00.000Z\",\"formatVersion\":11,\"journal\":{\"legacyBodyBytes\":0,\"legacyEventCount\":0,\"legacyPrefixDigest\":\"1e9f8adb040e92789e005f089d72c73c7cc54d3f73fda753a381447798fd5868\",\"separatorBytes\":0,\"version\":1},\"origin\":\"fork\",\"parentSession\":\"source\",\"seedLength\":0,\"semanticSeed\":{\"codec\":\"semantic-seed-v1\",\"dependencyDigest\":\"7fd4c9f0169abf80e5e11e8cab2e06d9e8bf8bf2cd3d9ee63e17ea0345c6a29c\",\"groupCount\":0,\"manifestDigest\":\"5a255899e40ddb1db47d6621805827e244998da2f1b73eb0944d7ce1e8a90b6b\",\"operationId\":\"literal-old\",\"requestDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"seedDigest\":\"f682547f170c025d0519512768a13bd41a570527aa5aee1c3f69be82424f2498\",\"seedLength\":0,\"version\":1},\"sessionId\":\"target\",\"title\":\"literal original\"}\n","frame":"{\"recordKind\":\"session/fact-batch\",\"version\":1,\"batchId\":\"bootstrap:literal-old:complete\",\"firstSeq\":0,\"count\":1,\"previousPrefixDigest\":\"1e9f8adb040e92789e005f089d72c73c7cc54d3f73fda753a381447798fd5868\",\"events\":[{\"type\":\"session/bootstrap\",\"version\":1,\"seq\":0,\"operationId\":\"literal-old\",\"manifestDigest\":\"5a255899e40ddb1db47d6621805827e244998da2f1b73eb0944d7ce1e8a90b6b\",\"dependencyClosureDigest\":\"7fd4c9f0169abf80e5e11e8cab2e06d9e8bf8bf2cd3d9ee63e17ea0345c6a29c\",\"seedLength\":0}],\"batchDigest\":\"1fa2421c19ed3bc9fd11ee6ad89c4a6b42a67e304b020d9159b155d0a24559e2\",\"prefixDigest\":\"ec7b724cce6bdee32b4572070a5edc0608da534058e747a4652b9d8806112725\"}\n"}
it('P11 literal old format11 stage/header/completion preserve birth and upgrade only writable storage',async()=>{
  const {root,backend,coordinator}=await setup(),stage=p.parseBootstrapHeaderStage(Buffer.from(predecessorLiteral.stage))
  expect(parsePredecessorStage(Buffer.from(predecessorLiteral.stage))).toEqual(stage)
  const r={...request(),invocation:stage.invocation},original:p.BootstrapRequest={invocation:stage.invocation,target:{kind:'new'},metadata:stage.metadata,lineage:stage.lineage,seed:p.compileSemanticSeed({kind:'none'})}
  await writeFile(stagePath(root,r),predecessorLiteral.stage);await writeFile(join(root,'target.jsonl'),predecessorLiteral.header+predecessorLiteral.frame)
  expect(stage).not.toHaveProperty('captureReservation');expect(buildBootstrapHeader(original,stage).operation.stageBytes).toEqual(Buffer.from(predecessorLiteral.stage))
  expect(()=>buildBootstrapHeader(original,stage,undefined,{version:1,kind:'semantic-bootstrap-capture',request:request()})).toThrow()
  const result=await coordinator.resumeSemanticTarget(stage.invocation,guards,original);expect(result.kind).toBe('already-ready')
  expect(await readFile(stagePath(root,r),'utf8')).toBe(predecessorLiteral.stage)
  const raw=await readFile(join(root,'target.jsonl'),'utf8');expect(JSON.parse(raw.slice(0,raw.indexOf('\n'))).formatVersion).toBe(CURRENT_FORMAT_VERSION);expect(raw.slice(raw.indexOf('\n')+1)).toBe(predecessorLiteral.frame)
  await coordinator.close();const loaded=await backend.read('target');await backend.replaceEvents!('target',loaded.events)
  expect((await readFile(join(root,'target.jsonl'),'utf8')).slice(raw.indexOf('\n')+1)).toBe(predecessorLiteral.frame)
})

// Frozen predecessor parser and validation helpers copied from BASE a4d8b971.
const parsePredecessorStage = (()=>{
type BootstrapInvocation=p.BootstrapInvocation;type BootstrapRequest=p.BootstrapRequest;type BootstrapHeaderStage=p.BootstrapHeaderStage;type SessionMeta=p.SessionMeta;
const bad = (): never => { throw new TypeError('Invalid bootstrap materialization') }
const digest = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x)
const id = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 256
const count = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0
const sameBootstrapData = (a: unknown, b: unknown): boolean => canonicalJsonData(a) === canonicalJsonData(b)
function bootstrapFields(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !isStrictFactData(value)
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(field => !field.enumerable)
    || required.some(key => !Object.hasOwn(value, key)) || Object.getOwnPropertyNames(value).some(key => !required.includes(key) && !optional.includes(key))
    || Object.values(value).some(x => x === undefined)) bad()
}
const fields: typeof bootstrapFields = bootstrapFields
function captureBootstrapInvocation(value: BootstrapInvocation): BootstrapInvocation {
  fields(value, ['version','operationId','targetSessionId','createdAt','requestDigest'])
  if (value.version !== 1 || typeof value.operationId !== 'string' || !/^[\x21-\x7e]{1,237}$/.test(value.operationId) || !id(value.targetSessionId)
    || !digest(value.requestDigest) || typeof value.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.createdAt) || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString()!==value.createdAt) bad()
  return freezeJsonData(JSON.parse(canonicalJsonData(value))) as BootstrapInvocation
}
function validateTarget(value: BootstrapRequest['target']) {
  if (value.kind === 'new') fields(value, ['kind'])
  else if (value.kind === 'resume') { fields(value,['kind','manifestDigest']); if (!digest(value.manifestDigest)) bad() }
  else if (value.kind === 'existing-empty') {
    fields(value,['kind','expectedHeaderDigest','expectedPrefix']); fields(value.expectedPrefix,['eventCount','bodyBytes','prefixDigest'])
    if (!digest(value.expectedHeaderDigest) || value.expectedPrefix.eventCount !== 0 || value.expectedPrefix.bodyBytes !== 0 || value.expectedPrefix.prefixDigest !== legacyPrefixDigest(0,new Uint8Array())) bad()
  } else bad()
}
function validateCreation(metadata: BootstrapRequest['metadata'], lineage: BootstrapRequest['lineage']) {
  fields(metadata,[],['title','workspaceId','modelSelection']); fields(lineage,['origin'],['parentSession','delegationDepth','subagentProtocolVersion'])
  if (metadata.title !== undefined && (typeof metadata.title !== 'string' || Buffer.byteLength(metadata.title) > 32768) || metadata.workspaceId !== undefined && !id(metadata.workspaceId)) bad()
  if (metadata.modelSelection !== undefined) {
    const m=metadata.modelSelection; fields(m,['provider','model'],['protocol','reasoningEffort'])
    if (!id(m.provider) || !id(m.model) || m.reasoningEffort !== undefined && !id(m.reasoningEffort) || m.protocol !== undefined && !(PROVIDER_PROTOCOLS as readonly string[]).includes(m.protocol)) bad()
  }
  if (!['subagent','approval-review','team','fork','import'].includes(lineage.origin) || lineage.parentSession !== undefined && !id(lineage.parentSession)
    || lineage.delegationDepth !== undefined && !count(lineage.delegationDepth) || (lineage.origin === 'subagent') !== (lineage.subagentProtocolVersion === 1)
    || lineage.origin === 'import' && lineage.parentSession !== undefined) bad()
}
function parseBootstrapHeaderStage(bytes: Uint8Array): BootstrapHeaderStage {
  if (bytes.length>262144) bad()
  const value=JSON.parse(Buffer.from(bytes).toString('utf8')) as BootstrapHeaderStage
  fields(value,['version','kind','invocation','originalTarget','metadata','lineage','headerBase','seed','headerBytes'],['initial'])
  if (value.version!==1 || value.kind!=='semantic-bootstrap-header' || typeof value.headerBytes!=='string' || Buffer.byteLength(value.headerBytes)>65536 || !value.headerBytes.endsWith('\n')) bad()
  captureBootstrapInvocation(value.invocation); validateTarget(value.originalTarget); if ((value.originalTarget as BootstrapRequest['target']).kind==='resume') bad()
  validateCreation(value.metadata,value.lineage)
  fields(value.seed,['digest','dependencyDigest','sourceObservation','seedLength','groupCount'])
  if (![value.seed.digest,value.seed.dependencyDigest].every(digest) || !count(value.seed.seedLength) || !count(value.seed.groupCount)) bad()
  fields(value.seed.sourceObservation,value.seed.sourceObservation.kind==='none' ? ['kind']:['kind','digest'])
  if (!['none','semantic'].includes(value.seed.sourceObservation.kind) || value.seed.sourceObservation.kind==='semantic' && !digest(value.seed.sourceObservation.digest)) bad()
  if (value.initial) { fields(value.initial,['inputId','digest','startedAt','expiresAt']); if (!id(value.initial.inputId)||!digest(value.initial.digest)||!count(value.initial.startedAt)||!count(value.initial.expiresAt)||value.initial.expiresAt<=value.initial.startedAt) bad() }
  const header=JSON.parse(value.headerBytes) as SessionMeta, s=header.semanticSeed
  validateSubagentHeader(header)
  if (!s || ![11,12].includes(header.formatVersion) || header.journal?.version!==1 || header.journal.legacyBodyBytes!==0 || header.journal.legacyEventCount!==0 || header.journal.separatorBytes!==0 || header.journal.legacyPrefixDigest!==legacyPrefixDigest(0,new Uint8Array())
    || header.sessionId!==value.invocation.targetSessionId || header.createdAt!==value.invocation.createdAt || s.operationId!==value.invocation.operationId || s.requestDigest!==value.invocation.requestDigest
    || s.seedDigest!==value.seed.digest || s.dependencyDigest!==value.seed.dependencyDigest || s.seedLength!==value.seed.seedLength || s.groupCount!==value.seed.groupCount || header.seedLength!==s.seedLength
    || s.initialInputId!==value.initial?.inputId || s.initialInputDigest!==value.initial?.digest || s.initialStartedAt!==value.initial?.startedAt || s.initialExpiresAt!==value.initial?.expiresAt) bad()
  const {semanticSeed:_,...base}=header
  if (!sameBootstrapData(base,value.headerBase) || !sameBootstrapData({...base,...value.metadata,...value.lineage},base)) bad()
  if (!Buffer.from(canonicalJsonData(value)+'\n').equals(Buffer.from(bytes))) bad()
  return value
}

return parseBootstrapHeaderStage
})()
