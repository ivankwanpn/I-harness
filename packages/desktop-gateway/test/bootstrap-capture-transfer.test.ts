import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { exportConversationSeed, managedResultRefs, semanticSeedResultRefs, type ManagedArtifactRef, type ResultDependency } from '@i-harness/core-session'
import { createSessionCoordinator, readForkRequestCore, createBootstrapRequestIntent, compileSemanticSeed, type BootstrapRequest, type SessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionService } from '@i-harness/session-executor'
import { createNativeContextRuntime } from '../src/context-runtime.ts'
import { createProjectScopeBroker } from '../src/project-scope.ts'

const cleanup:(()=>Promise<void>)[]=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()})
const sha=(value:string)=>createHash('sha256').update(value).digest('hex')
it('P17 actual reserved managed-source capture transfers real native text/catalog membership and cold passive service reads',async()=>{
  const root=await mkdtemp(join(tmpdir(),'bc11-native-')),workspace=join(root,'workspace'),sessions=join(root,'sessions'),storageRoot=join(root,'native')
  cleanup.push(()=>rm(root,{recursive:true,force:true}));await mkdir(workspace)
  const coordinator=createSessionCoordinator(createJsonlBackend(sessions),{lock:{enabled:true}});cleanup.push(()=>coordinator.close())
  await coordinator.create({sessionId:'source'})
  const project={id:'capture-project',name:'Capture Project',roots:[workspace],primaryRoot:workspace}
  const broker=createProjectScopeBroker(coordinator,workspace);cleanup.push(()=>broker.close());await broker.configure(project);await broker.bind('source',project.id)
  let sourceAlive=true,sourceReads=0,targetProfiles=0
  const openRuntime=async(c:SessionCoordinator,b:ReturnType<typeof createProjectScopeBroker>,passive=false)=>{
    const runtime=await createNativeContextRuntime({workspace,storageRoot,coordinator:{...c,async profile(id){if(id==='source'){sourceReads++;if(passive)throw new Error('cold source profile forbidden')}else targetProfiles++;return c.profile(id)}},
      projectFor:b.nativeScopeFor,resultReadScopeFor:b.resultReadScopeFor,prepareBootstrapInheritance:b.prepareBootstrapInheritance,
      visibleRefsFor:async id=>{if(id==='source'){sourceReads++;if(passive)throw new Error('cold source visibility forbidden')}
        const session=(await c.snapshot(id)).session;return [...semanticSeedResultRefs(session),...session.events.flatMap(managedResultRefs)]}})
    cleanup.push(()=>runtime.close());return runtime
  }
  const runtime=await openRuntime(coordinator,broker),owner=runtime.contextOutput,source=await runtime.sourceFor('source')
  const save=async(operationId:string,body:string,codec:ManagedArtifactRef['codec']='text-utf8-v1')=>{
    const scope=owner.registerResultScope({operationId,sessionId:'source',callId:operationId,source},()=>sourceAlive)
    const sink=await owner.beginResult(scope,codec);await sink.write(Buffer.from(body));const result=await sink.finish('complete')
    if(result.kind!=='committed')throw new Error('actual source artifact publication failed');return result.ref
  }
  const text=await save('text-original','reserved managed source text')
  const member=await save('member-original','IHEXEC01\n{"channel":"stdout","frame":0,"offset":0,"end":true,"data":"eA=="}\n','exec-frames-v1')
  const entries:ResultDependency[]=[{kind:'exec-frames',sourceId:'member',retention:{kind:'artifact',ref:member}},{kind:'exec-frames',sourceId:'missing',retention:{kind:'unavailable',reason:'quota'}}]
  const catalogScope=owner.registerResultDependencyScope({operationId:'catalog-original',sessionId:'source',callId:'observe',source},()=>sourceAlive,entries)
  const catalogSink=await owner.beginResult(catalogScope,'json-utf8-v1');await catalogSink.write(Buffer.from(JSON.stringify({version:1,kind:'result-dependencies',entries})))
  const saved=await catalogSink.finish('complete');if(saved.kind!=='committed')throw new Error('actual source catalog publication failed')
  const catalog=saved.ref;expect(await owner.settleResultDependencyMembership(catalogScope,catalog)).toBe('ready')
  // The source authority is the persisted, completed ManagedDocument below.
  await coordinator.append('source',[{type:'turn/start'},{type:'step/start'},{type:'tool/call',callId:'observe',name:'read',args:{}},{type:'assistant/message',text:''},
    {type:'tool/result',callId:'observe',name:'read',envelope:{version:1,execution:{outcome:'succeeded',dispatch:'dispatched'},preview:'retained',media:[],retention:{kind:'artifact',ref:text},dependencies:{kind:'artifact-set',ref:catalog,count:entries.length}}},
    {type:'step/end'},{type:'turn/end'}])
  const sourceDocument=await coordinator.openManagedDocument('source');sourceDocument.assertReady()
  const core=readForkRequestCore({version:1,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{title:'resolved original'}})
  const {intent,requestDigest}=createBootstrapRequestIntent(core,{kind:'project',projectId:project.id})
  const invocation={version:1 as const,operationId:'native-capture-operation',targetSessionId:'target',createdAt:'2026-10-26T00:00:00.000Z',requestDigest},request={invocation,core,requestIntent:intent}
  const capture={invocation,requestIntent:intent,sourceSessionId:'source',sourceAvailable:()=>sourceAlive,assertNewWorkCurrent(){if(!sourceAlive)throw new Error('source closed');sourceDocument.assertReady()},targetAvailable:()=>true}
  const transfer=runtime.prepareBootstrapTransfer(capture,{sessionId:'source'});cleanup.push(async()=>transfer.close())
  const preparation=vi.spyOn(transfer.targetPreparation,'confirm'),dependencies=vi.spyOn(transfer.dependencies,'confirm'),nativeConfirm=vi.spyOn(owner,'confirmSeedDependencies')
  const directory=(ref:ManagedArtifactRef)=>join(storageRoot,'context-output','context-output',sha(runtime.workspaceId),'managed-v1',ref.id)
  let captures=0,original:BootstrapRequest|undefined
  const ready=await coordinator.bootstrapSemanticTargetWithCapture!(request,{assertCurrent(){capture.assertNewWorkCurrent()},...transfer},async()=>{
    captures++;expect(preparation).not.toHaveBeenCalled();expect(dependencies).not.toHaveBeenCalled();expect(nativeConfirm).not.toHaveBeenCalled();expect(targetProfiles).toBe(0)
    await expect(readFile(join(sessions,'target.jsonl'))).rejects.toMatchObject({code:'ENOENT'})
    expect(await coordinator.getDocument('desktop-session-project-'+sha('target'))).toBeUndefined()
    for(const ref of [text,member,catalog])await expect(readFile(join(directory(ref),'pins',sha('target')+'.json'))).rejects.toMatchObject({code:'ENOENT'})
    const key=sha((await import('@i-harness/core-session')).canonicalJsonData(invocation)),literal=JSON.parse(await readFile(join(sessions,`target.jsonl.bootstrap-${key}.stage`),'utf8'))
    expect(literal).toEqual({version:1,kind:'semantic-bootstrap-capture',request});expect(literal).not.toHaveProperty('seed')
    capture.assertNewWorkCurrent()
    const exported=exportConversationSeed(sourceDocument.view,{kind:'session',sessionId:'source'},core.selection)
    if(exported.kind!=='seed')throw new Error('actual managed completed export refused')
    original={invocation,target:{kind:'new'},metadata:core.metadata,lineage:{origin:'fork',parentSession:'source'},seed:compileSemanticSeed(exported)}
    return original
  })
  expect(ready.kind).toBe('ready');expect(captures).toBe(1);expect(preparation).toHaveBeenCalledTimes(1);expect(dependencies).toHaveBeenCalledTimes(1);expect(nativeConfirm).toHaveBeenCalledTimes(1);expect(targetProfiles).toBe(0)
  const preReadyTargetProfiles=targetProfiles
  sourceAlive=false;await coordinator.closeManagedDocument('source');await coordinator.updateMeta('source',{archived:true});transfer.close();await runtime.close();await broker.close();await coordinator.close()
  const coldCoordinator=createSessionCoordinator(createJsonlBackend(sessions),{lock:{enabled:true}});cleanup.push(()=>coldCoordinator.close())
  const coldBroker=createProjectScopeBroker(coldCoordinator,workspace);cleanup.push(()=>coldBroker.close());await coldBroker.configure(project)
  const cold=await openRuntime(coldCoordinator,coldBroker,true),beforeReads=sourceReads
  const passive=cold.prepareBootstrapTransfer({...capture,sourceAvailable(){throw new Error('passive source hook')},assertNewWorkCurrent(){throw new Error('passive source action')}},undefined);cleanup.push(async()=>passive.close())
  const adopted=await coldCoordinator.resumeSemanticTarget(invocation,{assertCurrent(){throw new Error('passive source guard')},...passive},original)
  expect(adopted.kind).toBe('already-ready');expect(sourceReads).toBe(beforeReads)
  const service=createSessionService({workspace,coordinator:coldCoordinator,contextOutput:cold.contextOutput,resultReadScopeFor:coldBroker.resultReadScopeFor});cleanup.push(()=>service.close())
  expect(await service.readResultPage!('target',{ref:text})).toMatchObject({data:{text:'reserved managed source text'}})
  expect(await service.readResultPage!('target',{ref:member,viaCatalog:catalog})).toMatchObject({frames:[{data:'eA=='}]})
  expect(service.hasAssembly('target')).toBe(false);expect(sourceReads).toBe(beforeReads)
  console.log(JSON.stringify({control:'P17 actual host capture transfer',captures,preReadyTargetProfiles,coldTargetProfiles:targetProfiles-preReadyTargetProfiles,preparation:preparation.mock.calls.length,dependencyConfirm:nativeConfirm.mock.calls.length,coldSourceReads:sourceReads-beforeReads,assembly:service.hasAssembly('target')}))
})
