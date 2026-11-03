import {expect,it,vi} from 'vitest'
import {mkdir,mkdtemp,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {append,createSession,rewindCuts,deriveMessages} from '@i-harness/core-session'
import {createSessionCoordinator,createForkSessionController,createForkOperation} from '@i-harness/session-persistence'
import {createJsonlBackend} from '@i-harness/session-persistence-jsonl'
import {createNativeContextRuntime} from '../src/context-runtime.ts'
import {createProjectScopeBroker} from '../src/project-scope.ts'
import {createGatewayForkHost} from '../src/fork-session.ts'

it('grants only the real fork seed, survives disabled fork and origin clear, and excludes rewound/future results',async()=>{
  const base=process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT??resolve('build/native-fork-tests');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'fork-'))
  const coordinator=createSessionCoordinator(createJsonlBackend(join(root,'sessions')),{lock:{enabled:true}})
  await coordinator.create({sessionId:'parent'})
  const projects=createProjectScopeBroker(coordinator,root)
  await projects.configure({id:'p',name:'Project',roots:[root],primaryRoot:root});await projects.bind('parent','p')
  const runtime=await createNativeContextRuntime({workspace:root,storageRoot:join(root,'native'),coordinator,projectFor:projects.nativeScopeFor,
    resultReadScopeFor:projects.resultReadScopeFor,withBindingObservation:projects.withBindingObservation,prepareBootstrapInheritance:projects.prepareBootstrapInheritance,
    visibleRefsFor:async id=>{const session=(await coordinator.snapshot!(id)).session;const cuts=rewindCuts(session);return session.events.flatMap(event=>event.type==='context/result-ref'&&!cuts.some(cut=>event.seq!>=cut.cutFrom&&event.seq!<cut.markerSeq)?[event.ref]:[])}})
  const controller=createForkSessionController(coordinator,createGatewayForkHost({workspace:root,coordinator,projects,nativeContext:runtime}))
  const originalPrepare=runtime.prepareBootstrapTransfer.bind(runtime),transfers:ReturnType<typeof runtime.prepareBootstrapTransfer>[]=[]
  vi.spyOn(runtime,'prepareBootstrapTransfer').mockImplementation((...args)=>{const transfer=originalPrepare(...args);expect(()=>transfer.targetScope()).toThrow();transfers.push(transfer);return transfer})
  try {
    await runtime.contextOutput.configure({enabled:true})
    const session=createSession()
    const capture=async(label:string)=>runtime.contextOutput.capture({sessionId:'parent',callId:label,label,text:label,complete:true,source:await runtime.sourceFor('parent')})
    const visible=(await capture('VISIBLE'))!,hidden=(await capture('HIDDEN'))!,future=(await capture('FUTURE'))!
    append(session,{type:'turn/start'});append(session,{type:'user/message',text:'first'});append(session,{type:'context/result-ref',ref:visible});append(session,{type:'turn/end'})
    append(session,{type:'turn/start'});append(session,{type:'user/message',text:'rewound'});append(session,{type:'context/result-ref',ref:hidden});append(session,{type:'turn/end'})
    append(session,{type:'rewind/point',version:1,targetTurn:2,anchorSeq:5,mode:'all',fileOps:[]})
    append(session,{type:'turn/start'});append(session,{type:'user/message',text:'new branch'});append(session,{type:'turn/end'})
    await coordinator.append('parent',session.events)
    await runtime.contextOutput.configure({enabled:false})
    const prepared=await controller.prepare({version:1,sourceSessionId:'parent'})
    if(prepared.kind!=='prepared')throw new Error('Actual Gateway native preparation refused')
    const operation=createForkOperation(prepared.prepared,{operationId:'original-native',targetSessionId:'target',createdAt:new Date().toISOString()})
    const fork=await controller.execute({mode:'begin',operation})
    expect(fork.kind).toBe('ready')
    if(fork.kind!=='ready')throw new Error('Actual Gateway native fork refused: '+JSON.stringify(fork))
    const child=await coordinator.openManagedDocument(fork.sessionId)
    expect(deriveMessages(child.view)).toEqual(deriveMessages(session))
    expect(child.view.events[0]?.type).toBe('conversation/seed-manifest')
    expect(child.view.events.some(event=>event.type==='session/bootstrap')).toBe(true)
    for(const transfer of transfers)expect(()=>transfer.targetScope()).toThrow()
    await coordinator.closeManagedDocument('parent')
    await coordinator.append('parent',[{type:'turn/start',seq:12},{type:'context/result-ref',ref:future,seq:13},{type:'turn/end',seq:14}])
    await runtime.contextOutput.clear('parent');await runtime.contextOutput.configure({enabled:true})
    await runtime.withLegacyReadObservation({sessionId:fork.sessionId},async observation=>{
      expect((await runtime.contextOutput.readLegacyObserved({sessionId:fork.sessionId},{refId:visible.id},observation)).text).toBe('VISIBLE')
      for(const ref of [hidden,future])await expect(runtime.contextOutput.readLegacyObserved({sessionId:fork.sessionId},{refId:ref.id},observation)).rejects.toThrow()
      expect((await runtime.contextOutput.searchLegacyObserved({sessionId:fork.sessionId},{query:'VISIBLE'},observation)).hits.map(hit=>hit.ref.id)).toEqual([visible.id])
    })
    await expect(runtime.contextOutput.read({sessionId:fork.sessionId},{refId:visible.id})).rejects.toThrow()
    expect((await controller.execute({mode:'retry',operation})).kind).toBe('adopted')
  } finally {await controller.close();await runtime.close();await projects.close();await coordinator.close();await rm(root,{recursive:true,force:true})}
})
