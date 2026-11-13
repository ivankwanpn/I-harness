import {expect,it,vi,onTestFinished} from 'vitest'
import {mkdir,mkdtemp,rm,realpath} from 'node:fs/promises'
import {join,resolve,dirname,basename} from 'node:path'
import {append,createSession,rewindCuts,deriveMessages} from '@i-harness/core-session'
import {createSessionCoordinator,createForkSessionController,createForkOperation} from '@i-harness/session-persistence'
import {createJsonlBackend} from '@i-harness/session-persistence-jsonl'
import {createNativeContextRuntime} from '../src/context-runtime.ts'
import {createProjectScopeBroker} from '../src/project-scope.ts'
import {createGatewayForkHost} from '../src/fork-session.ts'

it('grants only the real fork seed, survives disabled fork and origin clear, and excludes rewound/future results',async()=>{
  // Actual capture/fork/source-clear/read/retry pipeline measured 8.989s.
  const pending = new Set<Promise<unknown>>()
  let retired = false, complete = false, preserveRoot = false
  let ownedRoot: string | undefined, ownedBase: string | undefined
  let ownedCoordinator: ReturnType<typeof createSessionCoordinator> | undefined
  let ownedProjects: ReturnType<typeof createProjectScopeBroker> | undefined
  let ownedRuntime: Awaited<ReturnType<typeof createNativeContextRuntime>> | undefined
  let ownedController: ReturnType<typeof createForkSessionController> | undefined
  let closing: Promise<void> | undefined
  let primary: { cause: unknown } | undefined
  const setupFinished = Promise.withResolvers<void>()
  const runOwned = <T,>(run: () => Promise<T>): Promise<T> => {
    if (retired) throw Error('Original native fork fixture retired')
    const original = run()
    pending.add(original)
    void original.then(() => pending.delete(original), () => pending.delete(original))
    return original
  }
  const close = (): Promise<void> => {
    retired = true
    if (complete) return Promise.resolve()
    if (closing) return closing
    const attempt = Promise.resolve().then(async () => {
      await setupFinished.promise
      const joined = await Promise.allSettled([...pending])
      const failures = joined.flatMap(result => result.status === 'rejected' && (!primary || result.reason !== primary.cause) ? [result.reason] : [])
      // Keep dependent owners alive if their original prerequisite cleanup
      // cannot acknowledge. Do not turn raw descriptor hygiene into an ACK.
      for (const dispose of [() => ownedController?.close(), () => ownedRuntime?.close(), () => ownedProjects?.close(), () => ownedCoordinator?.close()]) {
        try { await dispose() }
        catch (cause) { failures.push(cause); break }
      }
      if (!primary && !failures.length && !preserveRoot && ownedRoot && ownedBase) {
        const target = await realpath(ownedRoot), base = await realpath(ownedBase)
        if (dirname(target) !== base || !basename(target).startsWith('fork-')) throw Error('Unexpected native fork fixture root')
        await rm(target, { recursive: true, force: true })
      }
      if (failures.length) throw new AggregateError([...(primary ? [primary.cause] : []), ...failures], 'Original native fork cleanup failed', { cause: primary?.cause })
      complete = true
    })
    closing = attempt
    void attempt.finally(() => { if (closing === attempt) closing = undefined }).catch(() => {})
    return attempt
  }
  onTestFinished(context => { preserveRoot ||= context.task.result?.state === 'fail'; return close() })
  try {
  const base=process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT??resolve('build/native-fork-tests');await mkdir(base,{recursive:true});const root=ownedRoot=await mkdtemp(join(ownedBase=base,'fork-'))
  const coordinator=ownedCoordinator=createSessionCoordinator(createJsonlBackend(join(root,'sessions')),{lock:{enabled:true}})
  await runOwned(() => coordinator.create({sessionId:'parent'}))
  const projects=ownedProjects=createProjectScopeBroker(coordinator,root)
  await runOwned(() => projects.configure({id:'p',name:'Project',roots:[root],primaryRoot:root}));await runOwned(() => projects.bind('parent','p'))
  const runtime=ownedRuntime=await createNativeContextRuntime({workspace:root,storageRoot:join(root,'native'),coordinator,projectFor:projects.nativeScopeFor,
    resultReadScopeFor:projects.resultReadScopeFor,withBindingObservation:projects.withBindingObservation,prepareBootstrapInheritance:projects.prepareBootstrapInheritance,
    visibleRefsFor:async id=>{const session=(await coordinator.snapshot!(id)).session;const cuts=rewindCuts(session);return session.events.flatMap(event=>event.type==='context/result-ref'&&!cuts.some(cut=>event.seq!>=cut.cutFrom&&event.seq!<cut.markerSeq)?[event.ref]:[])}})
  const controller=ownedController=createForkSessionController(coordinator,createGatewayForkHost({workspace:root,coordinator,projects,nativeContext:runtime}))
  const originalPrepare=runtime.prepareBootstrapTransfer.bind(runtime),transfers:ReturnType<typeof runtime.prepareBootstrapTransfer>[]=[]
  vi.spyOn(runtime,'prepareBootstrapTransfer').mockImplementation((...args)=>{const transfer=originalPrepare(...args);expect(()=>transfer.targetScope()).toThrow();transfers.push(transfer);return transfer})
  setupFinished.resolve()
    await runOwned(() => runtime.contextOutput.configure({enabled:true}))
    const session=createSession()
    const capture=async(label:string)=>runtime.contextOutput.capture({sessionId:'parent',callId:label,label,text:label,complete:true,source:await runtime.sourceFor('parent')})
    const visible=(await runOwned(() => capture('VISIBLE')))!,hidden=(await runOwned(() => capture('HIDDEN')))!,future=(await runOwned(() => capture('FUTURE')))!
    append(session,{type:'turn/start'});append(session,{type:'user/message',text:'first'});append(session,{type:'context/result-ref',ref:visible});append(session,{type:'turn/end'})
    append(session,{type:'turn/start'});append(session,{type:'user/message',text:'rewound'});append(session,{type:'context/result-ref',ref:hidden});append(session,{type:'turn/end'})
    append(session,{type:'rewind/point',version:1,targetTurn:2,anchorSeq:5,mode:'all',fileOps:[]})
    append(session,{type:'turn/start'});append(session,{type:'user/message',text:'new branch'});append(session,{type:'turn/end'})
    await runOwned(() => coordinator.append('parent',session.events))
    await runOwned(() => runtime.contextOutput.configure({enabled:false}))
    const prepared=await runOwned(() => controller.prepare({version:1,sourceSessionId:'parent'}))
    if(prepared.kind!=='prepared')throw new Error('Actual Gateway native preparation refused')
    const operation=createForkOperation(prepared.prepared,{operationId:'original-native',targetSessionId:'target',createdAt:new Date().toISOString()})
    const fork=await runOwned(() => controller.execute({mode:'begin',operation}))
    expect(fork.kind).toBe('ready')
    if(fork.kind!=='ready')throw new Error('Actual Gateway native fork refused: '+JSON.stringify(fork))
    const child=await runOwned(() => coordinator.openManagedDocument(fork.sessionId))
    expect(deriveMessages(child.view)).toEqual(deriveMessages(session))
    expect(child.view.events[0]?.type).toBe('conversation/seed-manifest')
    expect(child.view.events.some(event=>event.type==='session/bootstrap')).toBe(true)
    for(const transfer of transfers)expect(()=>transfer.targetScope()).toThrow()
    await runOwned(() => coordinator.closeManagedDocument('parent'))
    await runOwned(() => coordinator.append('parent',[{type:'turn/start',seq:12},{type:'context/result-ref',ref:future,seq:13},{type:'turn/end',seq:14}]))
    await runOwned(() => runtime.contextOutput.clear('parent'));await runOwned(() => runtime.contextOutput.configure({enabled:true}))
    await runOwned(() => runtime.withLegacyReadObservation({sessionId:fork.sessionId},async observation=>{
      expect((await runtime.contextOutput.readLegacyObserved({sessionId:fork.sessionId},{refId:visible.id},observation)).text).toBe('VISIBLE')
      for(const ref of [hidden,future])await expect(runtime.contextOutput.readLegacyObserved({sessionId:fork.sessionId},{refId:ref.id},observation)).rejects.toThrow()
      expect((await runtime.contextOutput.searchLegacyObserved({sessionId:fork.sessionId},{query:'VISIBLE'},observation)).hits.map(hit=>hit.ref.id)).toEqual([visible.id])
    }))
    await expect(runtime.contextOutput.read({sessionId:fork.sessionId},{refId:visible.id})).rejects.toThrow()
    expect((await runOwned(() => controller.execute({mode:'retry',operation}))).kind).toBe('adopted')
  } catch (cause) { primary = { cause }; throw cause }
  finally { setupFinished.resolve(); await close() }
}, 20000)
