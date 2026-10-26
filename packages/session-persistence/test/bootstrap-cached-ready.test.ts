import { mkdtemp, rm, readFile, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { exportConversationSeed } from '@i-harness/core-session'
import { createSessionCoordinator, compileSemanticSeed, forkSession, retryForkSession, type BootstrapRequest, type ForkOperation, type SessionCoordinator } from '../src/index.ts'
import { bootstrapPaths } from '../../session-persistence-jsonl/src/backend/bootstrap-header.ts'
import { captureManagedReadyObservation } from '../src/coordinator/managed-document.ts'
import { createOwnership } from '../src/coordinator/ownership.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ih-bcr-')), original = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  await original.create({ sessionId: 'source', title: 'original' })
  await original.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'cached original observation' }, { type: 'turn/end' }])
  const fork = await forkSession(original, 'source'); await original.close()
  const backend = createJsonlBackend(root), c = createSessionCoordinator(backend, { lock: { enabled: true } })
  const document = await c.openManagedDocument(fork.sessionId)
  return { root, backend, c, document, fork, async close() { await c.close(); await rm(root, { recursive: true, force: true }) } }
}
const never = async (): Promise<never> => { throw new Error('Empty actual artifact closure must not call dependencies') }
function resume(c: SessionCoordinator, operation: ForkOperation) {
  return c.withSessionBindingObservation!({ existingSessionIds: [], target: operation.invocation }, async () => c.resumeSemanticTarget(operation.invocation,
    { assertCurrent() { throw new Error('Passive recovery cannot issue source-derived writes') }, dependencies: { confirm: never, reconcile: never } }))
}
it('ordinary cold READY read preserves exact cached document and original native receipt owner on passive retry', async () => {
  const f = await fixture()
  try {
    await f.c.updateMeta(f.fork.sessionId, { title: 'latest mutable title' })
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
    expect((await f.backend.profile(f.fork.sessionId)).meta.title).toBe('latest mutable title')
  } finally { await f.close() }
})
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
it.each(['append', 'revoke', 'metadata', 'metadata-aba'] as const)('cached original %s race never returns an old successful qualification', async mode => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    const read = f.backend.readBootstrapState!.bind(f.backend)
    f.backend.readBootstrapState = async invocation => { const value = await read(invocation); entered.resolve(); await release.promise; return value }
    const recovering = resume(f.c, f.fork.operation).catch(error => error)
    await entered.promise
    let metadata: Promise<unknown> | undefined
    if (mode === 'append') await f.document.metadata.admit({ type: 'plan/mode', mode: 'on' })
    else if (mode === 'revoke') f.c.revokeManagedDocumentNewWork(f.fork.sessionId)
    else if(mode==='metadata')metadata = f.c.updateMeta(f.fork.sessionId, { title: 'latest title' })
    else metadata=Promise.all([f.c.updateMeta(f.fork.sessionId,{title:'away'}),f.c.updateMeta(f.fork.sessionId,{title:'original'})])
    release.resolve()
    const outcome = await recovering
    if(mode==='metadata'||mode==='metadata-aba')expect(outcome).toMatchObject({reason:'revoked'})
    else expect(outcome).toMatchObject({kind:'refused',reason:'wrong-view'})
    await metadata
    if (mode === 'metadata') expect((await f.backend.profile(f.fork.sessionId)).meta.title).toBe('latest title')
    if(mode==='metadata-aba')expect((await f.backend.profile(f.fork.sessionId)).meta.title).toBe('original')
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
it('unproved raw cached documents and active capture/payload calls retain cached-unprepared',async()=>{
  const f=await fixture()
  try{
    await f.c.create({sessionId:'raw'});await f.c.append('raw',[{type:'turn/start'},{type:'user/message',text:'not bootstrap'},{type:'turn/end'}]);await f.c.openManagedDocument('raw')
    const rawOperation={...f.fork.operation,invocation:{...f.fork.operation.invocation,targetSessionId:'raw'}}
    expect(await resume(f.c,rawOperation)).toMatchObject({kind:'refused',reason:'cached-unprepared'})
    const request={invocation:f.fork.operation.invocation,core:f.fork.operation.prepared.core,requestIntent:f.fork.operation.prepared.requestIntent}
    let captures=0
    const active=await f.c.withSessionBindingObservation!({existingSessionIds:[],target:request.invocation},()=>f.c.bootstrapSemanticTargetWithCapture!(request,
      {assertCurrent(){throw new Error('No new work allowed')},dependencies:{confirm:never,reconcile:never}},async()=>{captures++;throw new Error('must not capture')}))
    expect(active).toMatchObject({kind:'refused',reason:'cached-unprepared'});expect(captures).toBe(0)
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
    const read=f.backend.readBootstrapState!.bind(f.backend)
    f.backend.readBootstrapState=async invocation=>{const state=await read(invocation);entered.resolve();await release.promise;return state}
    const recovering=resume(f.c,f.fork.operation).catch(error=>error)
    await entered.promise
    let closed=false;const closing=f.c.close().then(()=>{closed=true})
    await Promise.resolve();expect(closed).toBe(false);expect(f.c.ownerOf(f.fork.sessionId)).toBe(true)
    release.resolve();expect(await recovering).toMatchObject({reason:'revoked'});await closing
    expect(f.c.ownerOf(f.fork.sessionId)).toBe(false)
  }finally{release.resolve();await f.close()}
})
