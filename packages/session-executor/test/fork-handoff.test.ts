import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionCoordinator, createForkSessionController, createForkOperation, forkSession } from '@i-harness/session-persistence'
import { createContextOutputTools } from '@i-harness/context-output'
import { createCliForkHost } from '../src/lifecycle/fork-handoff.ts'
import { acquireResultReadStore } from '../src/lifecycle/result-store.ts'
import * as resultStoreOwner from '../src/lifecycle/result-store.ts'
it('real CLI host transfers managed and legacy selected results and cold nested targets retain them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-fh-')), settings = join(root, 'settings.json')
  await writeFile(settings, JSON.stringify({ contextSubsystems: { contextOutput: { enabled: true } } }))
  let c = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  let lease: Awaited<ReturnType<typeof acquireResultReadStore>> | undefined
  try {
    await c.create({ sessionId: 'source' })
    lease = await acquireResultReadStore({ workspace: root, coordinator: c, sessionId: 'source', contextOutputSettingsPath: settings, readCallerAvailable: () => true })
    const owner = lease.service!, source = await lease.sourceFor!('source')
    const legacy = await owner.capture({ sessionId: 'source', callId: 'call', label: 'original', text: 'VISIBLE legacy inherited', complete: true, source })
    if (!legacy) throw new Error('Actual legacy capture unavailable')
    const scope = owner.registerResultScope({ operationId: 'managed', sessionId: 'source', callId: 'call', source }, () => true)
    const sink = await owner.beginResult(scope, 'text-utf8-v1'); await sink.write(Buffer.from('VISIBLE managed inherited'))
    const saved = await sink.finish('complete'); if (saved.kind !== 'committed') throw new Error('Managed commit unavailable')
    await c.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'retain results' }, { type: 'step/start' }, { type: 'tool/call', callId: 'call', name: 'read', args: {} },
      { type: 'assistant/message', text: '' }, { type: 'tool/dispatch', callId: 'call', eventSeq: 3 },
      { type: 'tool/result', callId: 'call', name: 'read', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: 'retained', media: [], retention: { kind: 'artifact', ref: saved.ref } } },
      { type: 'step/end' }, { type: 'turn/end' }, { type: 'context/result-ref', ref: legacy }])
    const controller = createForkSessionController(c, createCliForkHost({ workspace: root, coordinator: c, contextOutputSettingsPath: settings }))
    const child = await forkSession(c, 'source', { controller })
    const grandchild = await forkSession(c, child.sessionId, { controller })
    await owner.clear('source'); await owner.clear(child.sessionId)
    await lease.release(); lease = undefined; await c.close()
    c = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
    lease = await acquireResultReadStore({ workspace: root, coordinator: c, sessionId: grandchild.sessionId, contextOutputSettingsPath: settings, readCallerAvailable: () => true })
    const fresh = lease.service!
    expect(await fresh.readResult({ sessionId: grandchild.sessionId }, { ref: saved.ref })).toMatchObject({ data: { text: 'VISIBLE managed inherited' } })
    const tools = createContextOutputTools(fresh, { withLegacyReadObservation: lease.withLegacyReadObservation! })
    expect(await tools.find(tool => tool.name === 'context_output_read')!.execute({ refId: legacy.id }, { sessionId: grandchild.sessionId } as any)).toMatchObject({ text: 'VISIBLE legacy inherited' })
    expect(await tools.find(tool => tool.name === 'context_output_search')!.execute({ query: 'VISIBLE' }, { sessionId: grandchild.sessionId } as any)).toMatchObject({ hits: [{ ref: { id: legacy.id } }] })
    const coldController = createForkSessionController(c, createCliForkHost({ workspace: root, coordinator: c, contextOutputSettingsPath: settings }))
    const profile = vi.spyOn(c, 'profile').mockImplementation(async id => { if (id === child.sessionId || id === 'source') throw new Error('passive source trap'); return createJsonlBackend(root).profile(id) })
    expect((await coldController.execute({ operation: grandchild.operation, mode: 'retry' })).kind).toBe('adopted')
    expect(profile).not.toHaveBeenCalled()
  } finally { await lease?.release(); await c.close(); await rm(root, { recursive: true, force: true }) }
}, 15000)

it.each(['prepare','late-reader','target'] as const)('actual CLI host close joins original %s lifetime before dependency teardown',async phase=>{
  const root=await mkdtemp(join(tmpdir(),'ih-fhl-')),settings=join(root,'settings.json')
  await writeFile(settings,JSON.stringify({contextSubsystems:{contextOutput:{enabled:true}}}))
  const c=createSessionCoordinator(createJsonlBackend(root),{lock:{enabled:true}})
  await c.create({sessionId:'source'});await c.append('source',[{type:'turn/start'},{type:'user/message',text:'actual lifetime source'},{type:'turn/end'}])
  const host=createCliForkHost({workspace:root,coordinator:c,contextOutputSettingsPath:settings}),controller=createForkSessionController(c,host),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
  let external:Awaited<ReturnType<typeof acquireResultReadStore>>|undefined,restore:(()=>void)|undefined,running:Promise<unknown>|undefined
  try{
    if(phase==='prepare'){
      const observe=c.withExistingSessionBindingObservation!.bind(c)
      c.withExistingSessionBindingObservation=(request,use)=>observe(request,async observation=>{entered.resolve();await release.promise;return use(observation)})
      running=controller.prepare({version:1,sourceSessionId:'source'}).catch(error=>error)
    }else{
      const prepared=await controller.prepare({version:1,sourceSessionId:'source'});if(prepared.kind!=='prepared')throw new Error('Actual prepare unavailable')
      const operation=createForkOperation(prepared.prepared,{operationId:'lifetime-'+phase,targetSessionId:'target',createdAt:new Date().toISOString()})
      if(phase==='late-reader'){
        external=await acquireResultReadStore({workspace:root,coordinator:c,sessionId:'source',contextOutputSettingsPath:settings,readCallerAvailable:()=>true})
        const acquire=resultStoreOwner.acquireResultReadStore,spy=vi.spyOn(resultStoreOwner,'acquireResultReadStore').mockImplementation(async(...args)=>{const lease=await acquire(...args);entered.resolve();await release.promise;return lease})
        restore=()=>spy.mockRestore()
      }else{
        const target=host.withReadyTarget.bind(host);host.withReadyTarget=async(...args)=>{entered.resolve();await release.promise;return target(...args)}
      }
      running=controller.execute({operation,mode:'begin'}).catch(error=>error)
    }
    await entered.promise
    const service=external?.service,serviceClose=service?vi.spyOn(service,'close'):undefined
    await external?.release()
    let closed=false;const closing=controller.close().then(()=>{closed=true})
    await Promise.resolve();expect(closed).toBe(false);expect(serviceClose?.mock.calls.length??0).toBe(0)
    if(phase==='target')expect(c.ownerOf('target')).toBe(true)
    release.resolve();const outcome=await running;await closing
    if(phase==='target')expect(outcome).toMatchObject({kind:'ready',sessionId:'target'})
    else if(phase==='prepare')expect(outcome).toMatchObject({reason:'revoked'})
    else{expect(outcome).toMatchObject({name:'ForkOperationError'});expect(serviceClose).toHaveBeenCalledTimes(1);expect(await c.list()).toEqual(['source'])}
  }finally{release.resolve();await running?.catch(()=>{});restore?.();await external?.release();await controller.close();await c.close();await rm(root,{recursive:true,force:true})}
},15000)

it('retains real L1 close debt and its reader service until the original scope cleanup acknowledges', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-fhc-')), settings = join(root, 'settings.json')
  await writeFile(settings, JSON.stringify({ contextSubsystems: { contextOutput: { enabled: true } } }))
  const c = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  await c.create({ sessionId: 'source' }); await c.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'real empty closure' }, { type: 'turn/end' }])
  const lease = await acquireResultReadStore({ workspace: root, coordinator: c, sessionId: 'source', contextOutputSettingsPath: settings, readCallerAvailable: () => true })
  const owner = lease.service!, entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  const confirm = owner.confirmLegacyForkTransfer.bind(owner), originalClose = owner.closeLegacyForkTransfer.bind(owner)
  let fault = true, callbacks = 0
  const scopes: unknown[] = [], closing = vi.spyOn(owner, 'close')
  owner.confirmLegacyForkTransfer = async (...args) => { entered.resolve(); await resume.promise; return confirm(...args) }
  owner.closeLegacyForkTransfer = async scope => { scopes.push(scope); if (fault) throw new Error('actual original L1 close before action'); return originalClose(scope) }
  const controller = createForkSessionController(c, createCliForkHost({ workspace: root, coordinator: c, contextOutputSettingsPath: settings }))
  const prepared = await controller.prepare({ version: 1, sourceSessionId: 'source' })
  if (prepared.kind !== 'prepared') throw new Error('Actual preparation unavailable')
  const operation = createForkOperation(prepared.prepared, { operationId: 'real-l1-close', targetSessionId: 'target', createdAt: new Date().toISOString() })
  const capture = c.bootstrapSemanticTargetWithCapture!.bind(c)
  c.bootstrapSemanticTargetWithCapture = (request, guards, use) => capture(request, guards, async () => { callbacks++; return use() })
  try {
    const running = controller.execute({ operation, mode: 'begin' }).catch(error => error)
    await entered.promise; await lease.release(); resume.resolve()
    const error = await running
    expect(error).toMatchObject({ kind: 'cleanup', hostError: { reason: 'cleanup-incomplete', lastOutcome: { kind: 'ready', sessionId: 'target' } } })
    expect(closing).not.toHaveBeenCalled()
    await expect(controller.close()).rejects.toThrow('Fork cleanup unresolved')
    expect(closing).not.toHaveBeenCalled(); expect(callbacks).toBe(1)
    fault = false; await controller.close()
    expect(scopes.length).toBe(3); expect(scopes.every(scope => scope === scopes[0])).toBe(true)
    expect(closing).toHaveBeenCalledTimes(1); expect(callbacks).toBe(1)
  } finally {
    fault = false; resume.resolve(); await lease.release()
    await controller.execute({ operation, mode: 'retry' }).catch(() => {})
    await controller.close(); await c.close(); await rm(root, { recursive: true, force: true })
  }
}, 15000)
