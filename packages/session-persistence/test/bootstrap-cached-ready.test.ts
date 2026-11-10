import { createSessionCoordinator } from './helpers/composed.ts'
import { mkdtemp, rm, readFile, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { exportConversationSeed, legacyPrefixDigest, deriveSessionTitle } from '@i-harness/core-session'
import { compileSemanticSeed, createForkOperation, readForkRequestCore, createBootstrapRequestIntent, retryForkSession, parseBootstrapHeaderStage, encodeBootstrapCaptureReservation, rawHeaderDigest, type BootstrapRequest, type ForkOperation, type SessionCoordinator } from '../src/index.ts'
import { bootstrapPaths } from '../../session-persistence-jsonl/src/backend/bootstrap-header.ts'
import { captureManagedReadyObservation } from '../src/coordinator/managed-document.ts'
import { createOwnership } from '../src/coordinator/ownership.ts'

const originalOwners = vi.hoisted(() => new WeakMap<object, unknown>())
vi.mock('../src/coordinator/ownership.ts', async load => {
  const api = await load<typeof import('../src/coordinator/ownership.ts')>()
  return { ...api, createOwnership: (...args: Parameters<typeof api.createOwnership>) => {
    const owner = api.createOwnership(...args); originalOwners.set(args[0], owner); return owner
  } }
})
const readCuts = vi.hoisted(() => new Map<string, () => Promise<void>>())
// Pause after the actual original route read settles its tracked IO. Public
// backend methods are not the warm owned-reader path and must stay unchanged.
vi.mock('../../session-persistence-jsonl/src/backend/bootstrap-header.ts', async load => {
  const api = await load<typeof import('../../session-persistence-jsonl/src/backend/bootstrap-header.ts')>()
  return { ...api, createBootstrapHeaderBackend: (...args: Parameters<typeof api.createBootstrapHeaderBackend>) => {
    const backend = api.createBootstrapHeaderBackend(...args)
    const pause = async (id: string) => {
      const path = args[0](id), cut = readCuts.get(path)
      if (cut) { readCuts.delete(path); await cut() }
    }
    const read = backend.readBootstrapState!
    backend.readBootstrapState = async invocation => { const result = await read(invocation); await pause(invocation.targetSessionId); return result }
    const tracked = backend.readTrackedState
    backend.readTrackedState = async (route, owner) => { const result = await tracked(route, owner); await pause(route.protocol === 'public' ? route.invocation.targetSessionId : route.request.invocation.targetSessionId); return result }
    const routed = backend.bootstrapRoutes.readState
    backend.bootstrapRoutes.readState = async route => { const result = await routed(route); await pause(route.protocol === 'public' ? route.invocation.targetSessionId : route.request.invocation.targetSessionId); return result }
    return backend
  } }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ih-bcr-')), original = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  await original.create({ sessionId: 'source', title: 'original' })
  await original.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'cached original observation' }, { type: 'turn/end' }])
  // Cache qualification tests need a real published birth, not the separate
  // policy/controller pipeline (covered by fork-controller and gateway tests).
  const core = readForkRequestCore({ version: 1, kind: 'session-fork-core', sourceSessionId: 'source', selection: { kind: 'completed' }, sourceCapture: 'first-authorized-capture', metadata: { title: 'original' } })
  const intent = createBootstrapRequestIntent(core, { kind: 'unmanaged' })
  const operation = createForkOperation({ version: 1, kind: 'session-fork-prepared', core, requestIntent: intent.intent, requestDigest: intent.requestDigest }, { operationId: 'cached-birth', targetSessionId: 'cached-child', createdAt: '2026-10-26T00:00:00.000Z' })
  const exported = exportConversationSeed((await original.snapshot!('source')).session, { kind: 'session', sessionId: 'source' }, { kind: 'completed' })
  if (exported.kind !== 'seed') throw new Error('Original durable source seed required')
  const payload: BootstrapRequest = { invocation: operation.invocation, target: { kind: 'new' }, metadata: core.metadata, lineage: { origin: 'fork', parentSession: 'source' }, seed: compileSemanticSeed(exported) }
  const ready = await original.bootstrapSemanticTargetWithCapture!({ invocation: operation.invocation, core, requestIntent: intent.intent }, { assertCurrent() {}, dependencies: { confirm: never, reconcile: never } }, async () => payload)
  if (ready.kind !== 'ready') throw new Error('Original target birth did not commit')
  const fork = { sessionId: operation.invocation.targetSessionId, operation }
  await original.close()
  const routeControl: { profileForbidden: boolean } = { profileForbidden: false }
  const probes = { profile: vi.fn(), capture: vi.fn() }
  const backend = createJsonlBackend(root, { wrap(original) {
    const profile = original.profile!, prepare = original.prepareBootstrapCapture!
    original.profile = (...args) => { if (routeControl.profileForbidden && args[0] === 'source') { probes.profile(); throw new Error('Source profile forbidden') }; return Reflect.apply(profile, original, args) }
    original.prepareBootstrapCapture = (...args) => { probes.capture(); return Reflect.apply(prepare, original, args) }
  } }), c = createSessionCoordinator(backend, { lock: { enabled: true } })
  const document = await c.openManagedDocument(fork.sessionId)
  return { root, backend, c, document, fork, routeControl, probes, ownership: originalOwners.get(backend) as ReturnType<typeof createOwnership>, async close() { await c.close(); await rm(root, { recursive: true, force: true }) } }
}
const never = async (): Promise<never> => { throw new Error('Empty actual artifact closure must not call dependencies') }
function resume(c: SessionCoordinator, operation: Pick<ForkOperation,'invocation'>) {
  return c.withSessionBindingObservation!({ existingSessionIds: [], target: operation.invocation }, async () => c.resumeSemanticTarget(operation.invocation,
    { assertCurrent() { throw new Error('Passive recovery cannot issue source-derived writes') }, dependencies: { confirm: never, reconcile: never } }))
}
async function existingEmptyFixture(){
  const root=await mkdtemp(join(tmpdir(),'ih-bcep-')),original=createSessionCoordinator(createJsonlBackend(root),{lock:{enabled:true}})
  const invocation={version:1 as const,operationId:'cached-existing-empty',targetSessionId:'target',createdAt:new Date().toISOString(),requestDigest:'a'.repeat(64)}
  await original.create({sessionId:'target',createdAt:invocation.createdAt,title:'unrelated'})
  const bytes=await readFile(join(root,'target.jsonl'))
  const request:BootstrapRequest={invocation,target:{kind:'existing-empty',expectedHeaderDigest:rawHeaderDigest(bytes),expectedPrefix:{eventCount:0,bodyBytes:0,prefixDigest:legacyPrefixDigest(0,new Uint8Array())}},metadata:{title:'created'},lineage:{origin:'import'},seed:compileSemanticSeed({kind:'none'})}
  expect((await original.bootstrapSemanticTarget(request,{assertCurrent(){},dependencies:{confirm:never,reconcile:never}})).kind).toBe('ready')
  await original.close()
  const backend=createJsonlBackend(root),c=createSessionCoordinator(backend,{lock:{enabled:true}}),document=await c.openManagedDocument('target')
  return{root,backend,c,document,invocation,async close(){await c.close();await rm(root,{recursive:true,force:true})}}
}
it.each(['foreign-stage','promotion','publication-new','foreign-and-corrupt'] as const)('cached READY preserves original %s namespace fence',async mode=>{
  const f=await fixture(),target=join(f.root,f.fork.sessionId+'.jsonl'),paths=bootstrapPaths(target,f.fork.operation.invocation),stage=await readFile(paths.stage)
  let extra:string|undefined
  try{
    if(mode==='foreign-stage'||mode==='foreign-and-corrupt')extra=bootstrapPaths(target,{...f.fork.operation.invocation,operationId:'foreign-sibling'}).stage
    else extra=mode==='promotion'?paths.promote:paths.publish
    await writeFile(extra,mode==='publication-new'?parseBootstrapHeaderStage(stage).headerBytes:stage)
    if(mode==='foreign-and-corrupt')await writeFile(paths.stage,'partial current stage')
    const state=await f.backend.readBootstrapState!(f.fork.operation.invocation)
    if(mode!=='publication-new')expect(state.foreign).toBe(true)
    expect(await resume(f.c,f.fork.operation)).toMatchObject({kind:'refused',reason:'conflict'})
    expect(await readFile(extra)).toEqual(Buffer.from(mode==='publication-new'?parseBootstrapHeaderStage(stage).headerBytes:stage))
  }finally{if(extra)await unlink(extra);await writeFile(paths.stage,stage);await f.close()}
})
it.each(['partial','foreign','complete'] as const)('cached existing-empty publication keeps original %s disposition',async mode=>{
  const f=await existingEmptyFixture(),paths=bootstrapPaths(join(f.root,'target.jsonl'),f.invocation),stage=parseBootstrapHeaderStage(await readFile(paths.stage))
  const publication=mode==='partial'?Buffer.from(stage.headerBytes).subarray(0,13):Buffer.from(mode==='foreign'?'FOREIGN publication':stage.headerBytes)
  try{
    await writeFile(paths.publish,publication)
    const state=await f.backend.readBootstrapState!(f.invocation);expect(state.publicationPresent).toBe(true);expect(state.foreign).toBe(false)
    const result=await resume(f.c,{invocation:f.invocation})
    if(mode==='partial')expect(result).toMatchObject({kind:'blocked',reason:'unknown'})
    else if(mode==='foreign')expect(result).toMatchObject({kind:'refused',reason:'conflict'})
    else {expect(result.kind).toBe('already-ready');if(result.kind==='already-ready')expect(result.document).toBe(f.document)}
    expect(await readFile(paths.publish)).toEqual(publication)
  }finally{await unlink(paths.publish);await f.close()}
})
it('cached READY preserves an actual original reservation-only payload-required fence',async()=>{
  const f=await fixture(),paths=bootstrapPaths(join(f.root,f.fork.sessionId+'.jsonl'),f.fork.operation.invocation),bytes=await readFile(paths.stage),stage=parseBootstrapHeaderStage(bytes)
  try{
    if(!stage.captureReservation||stage.captureReservation.kind!=='semantic-bootstrap-capture')throw new Error('Actual captured stage has no original reservation')
    await writeFile(paths.stage,encodeBootstrapCaptureReservation(stage.captureReservation))
    expect((await f.backend.readBootstrapState!(f.fork.operation.invocation)).captureReservation).toEqual(stage.captureReservation)
    expect(await resume(f.c,f.fork.operation)).toMatchObject({kind:'blocked',reason:'payload-required'})
  }finally{await writeFile(paths.stage,bytes);await f.close()}
})
it('cached READY keeps the original header invocation identity conflict disposition',async()=>{
  const f=await fixture(),path=join(f.root,f.fork.sessionId+'.jsonl'),bytes=await readFile(path)
  try{
    const newline=bytes.indexOf(10),header=JSON.parse(bytes.subarray(0,newline).toString())
    header.semanticSeed.requestDigest='f'.repeat(64)
    await writeFile(path,Buffer.concat([Buffer.from(JSON.stringify(header)+'\n'),bytes.subarray(newline+1)]))
    expect(await resume(f.c,f.fork.operation)).toMatchObject({kind:'refused',reason:'conflict'})
  }finally{await writeFile(path,bytes);await f.close()}
})
// Includes durable source/child births, cold ownership, two native qualifications and a metadata append.
it('ordinary cold READY read preserves exact cached document and original native receipt owner on passive retry', async () => {
  const f = await fixture()
  try {
    const title = f.document.beginAction()
    await title.facts.metadata.admit({ type: 'session/title', title: 'latest mutable title', source: 'user', messageSeqs: [] }); title.finish()
    const profile = vi.spyOn(f.c, 'profile').mockRejectedValue(new Error('Source profile forbidden'))
    const capture = vi.fn(f.c.bootstrapSemanticTargetWithCapture!); f.c.bootstrapSemanticTargetWithCapture = capture
    const outcome = await resume(f.c, f.fork.operation)
    expect(outcome.kind).toBe('already-ready')
    if (outcome.kind !== 'ready' && outcome.kind !== 'already-ready') throw new Error('Real cached READY not adopted')
    expect(outcome.document).toBe(f.document)
    expect(outcome.receipt.invocation).toEqual(f.fork.operation.invocation)
    const appended = await f.document.metadata.admit({ type: 'plan/mode', mode: 'on' })
    if (appended.kind !== 'committed') throw new Error('Original cached document no longer writable')
    expect(outcome.receipt.completion.owner).toEqual(appended.receipt.owner)
    expect((await retryForkSession(f.c, f.fork.operation)).kind).toBe('adopted')
    expect(profile).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled()
    expect(f.document.view.events.filter(event => event.type === 'session/bootstrap')).toHaveLength(1)
    expect(deriveSessionTitle((await f.c.snapshot!(f.fork.sessionId)).session)).toMatchObject({ title: 'latest mutable title' })
  } finally { await f.close() }
}, 10000)
it.each(['stage-missing', 'body-corrupt'] as const)('cached READY never replaces original %s proof with header authority', async mode => {
  const f = await fixture(), target = join(f.root, f.fork.sessionId + '.jsonl'), originalBytes = await readFile(target)
  const stagePath = bootstrapPaths(target, f.fork.operation.invocation).stage, stage = await readFile(stagePath)
  try {
    if (mode === 'stage-missing') await unlink(stagePath)
    else await writeFile(target, Buffer.from(originalBytes.toString().replace('cached original observation', 'corrupt original observation')))
    const outcome = await resume(f.c, f.fork.operation)
    expect(['ready','already-ready']).not.toContain(outcome.kind)
    expect(f.document.view.events.filter(event => event.type === 'session/bootstrap')).toHaveLength(1)
  } finally { await writeFile(target, originalBytes); await writeFile(stagePath, stage); await f.close() }
})
it.each(['append', 'revoke', 'metadata', 'metadata-aba'] as const)('original cached qualification serializes the %s boundary without stale publication', async mode => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    const witness = captureManagedReadyObservation(f.document, f.ownership)
    const path = join(f.root, f.fork.sessionId + '.jsonl')
    const before = await readFile(path)
    readCuts.set(path, async () => { entered.resolve(); await release.promise })
    const recovering = resume(f.c, f.fork.operation).catch(error => error)
    await entered.promise
    if (mode === 'append') {
      let committed = false
      const appending = f.document.metadata.admit({ type: 'plan/mode', mode: 'on' }).then(value => { committed = true; return value })
      await Promise.resolve(); expect(committed).toBe(false)
      release.resolve()
      const ready = await recovering
      expect(ready).toMatchObject({ kind: 'refused', reason: 'wrong-view' })
      const appended = await appending
      expect(appended.kind).toBe('committed')
      if (appended.kind !== 'committed') throw new Error('Original serialized append did not commit')
      const fresh = await resume(f.c, f.fork.operation)
      expect(fresh).toMatchObject({ kind: 'already-ready', document: f.document })
      if (fresh.kind !== 'already-ready') throw new Error('Fresh current receipt required')
      expect(fresh.receipt.completion.owner).toEqual(appended.receipt.owner)
      expect(() => witness.assertCurrent()).toThrow()
      expect((await f.backend.read(f.fork.sessionId)).events.filter(event => event.type === 'plan/mode')).toEqual([expect.objectContaining({ mode: 'on' })])
    } else if (mode === 'revoke') {
      f.c.revokeManagedDocumentNewWork(f.fork.sessionId)
      expect(() => witness.assertCurrent()).toThrow()
      release.resolve()
      expect(await recovering).toMatchObject({ kind: 'blocked', reason: 'unknown' })
      expect(await readFile(path)).toEqual(before)
    } else {
      const changes = mode === 'metadata' ? [{ title: 'latest title' }] : [{ title: 'away' }, { title: 'original' }]
      const results = await Promise.all(changes.map(patch => f.c.updateMeta(f.fork.sessionId, patch).catch(error => error)))
      for (const failure of results) expect(failure).toMatchObject({ reason: 'conflict' })
      expect(await readFile(path)).toEqual(before)
      witness.assertCurrent()
      release.resolve()
      expect(await recovering).toMatchObject({ kind: 'already-ready', document: f.document })
      expect((await f.backend.profile(f.fork.sessionId)).meta.title).toBe('original')
    }
  } finally { release.resolve(); await f.close() }
})

it('only the exact factory document and its actual original Ownership can issue a ready observation', async () => {
  const f=await fixture()
  try{
    const foreign=createOwnership(f.backend,{lock:{enabled:true}})
    expect(()=>captureManagedReadyObservation(f.document,foreign)).toThrow('reconciliation')
    expect(()=>captureManagedReadyObservation({...f.document},foreign)).toThrow('reconciliation')
    expect(foreign.ownerOf(f.fork.sessionId)).toBe(false)
    expect((await resume(f.c,f.fork.operation)).kind).toBe('already-ready')
  }finally{await f.close()}
})
it.each(['raw', 'capture', 'payload'] as const)('unproved %s cached authority retains cached-unprepared',async mode=>{
  const f=await fixture()
  try{
    if (mode === 'raw') {
    await f.c.create({sessionId:'raw'});await f.c.append('raw',[{type:'turn/start'},{type:'user/message',text:'not bootstrap'},{type:'turn/end'}]);await f.c.openManagedDocument('raw')
    const rawOperation={...f.fork.operation,invocation:{...f.fork.operation.invocation,targetSessionId:'raw'}}
    expect(await resume(f.c,rawOperation)).toMatchObject({kind:'refused',reason:'cached-unprepared'}); return
    }
    const request={invocation:f.fork.operation.invocation,core:f.fork.operation.prepared.core,requestIntent:f.fork.operation.prepared.requestIntent}
    let captures=0
    if (mode === 'capture') {
    const active=await f.c.withSessionBindingObservation!({existingSessionIds:[],target:request.invocation},()=>f.c.bootstrapSemanticTargetWithCapture!(request,
      {assertCurrent(){throw new Error('No new work allowed')},dependencies:{confirm:never,reconcile:never}},async()=>{captures++;throw new Error('must not capture')}))
    expect(active).toMatchObject({kind:'refused',reason:'cached-unprepared'});expect(captures).toBe(0); return
    }
    const source=await f.c.openManagedDocument('source'),exported=exportConversationSeed(source.view,{kind:'session',sessionId:'source'},{kind:'completed'})
    if(exported.kind==='refused')throw new Error('Actual negative-control source export refused')
    const payload:BootstrapRequest={invocation:request.invocation,target:{kind:'new'},metadata:request.core.metadata,lineage:{origin:'fork',parentSession:'source'},seed:compileSemanticSeed(exported)}
    const guards={assertCurrent(){throw new Error('No new source work allowed')},dependencies:{confirm:never,reconcile:never}}
    expect(await f.c.resumeSemanticTarget(request.invocation,guards,payload)).toMatchObject({kind:'refused',reason:'cached-unprepared'})
    expect(await f.c.bootstrapSemanticTarget(payload,guards)).toMatchObject({kind:'refused',reason:'cached-unprepared'})
  }finally{await f.close()}
})
it('coordinator retirement joins the original cached adoption and invalidates it before disposal',async()=>{
  const f=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
  try{
    readCuts.set(join(f.root, f.fork.sessionId + '.jsonl'), async () => { entered.resolve(); await release.promise })
    const recovering=resume(f.c,f.fork.operation).catch(error=>error)
    await entered.promise
    let closed=false;const closing=f.c.close().then(()=>{closed=true})
    await Promise.resolve();expect(closed).toBe(false);expect(f.c.ownerOf(f.fork.sessionId)).toBe(true)
    release.resolve();expect(await recovering).toMatchObject({reason:'revoked'});await closing
    expect(f.c.ownerOf(f.fork.sessionId)).toBe(false)
  }finally{release.resolve();await f.close()}
})
