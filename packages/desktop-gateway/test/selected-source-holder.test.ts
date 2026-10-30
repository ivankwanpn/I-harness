import { join } from 'node:path'
import { it,expect,vi } from 'vitest'
import { createGatewayForkFixture } from './helpers/fork-fixture.ts'
import { createSelectedResultsIntent,readSelectedResultsCore,readSelectedResultsOperation } from '../../session-persistence/src/selected-results-fork-contract.ts'
it('retains the original native source across first and warm and never accesses it in passive',async()=>{
 const f=await createGatewayForkFixture();try{
 const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'project',projectId:'p'}),operation=readSelectedResultsOperation({version:2,kind:'session-fork-operation',prepared:{version:2,kind:'session-fork-prepared',core,requestIntent:intent,requestDigest},invocation:{version:1,operationId:'op',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest}})
 const holder=f.runtime.createSelectedSourceHolder(operation),flush=vi.spyOn(f.coordinator,'flush');let source:unknown,reader:unknown,escaped!:()=>void,reads=0;const badSignal=Object.defineProperty({},'aborted',{get(){reads++;return false}});await expect(holder.first(async()=>{},badSignal as AbortSignal)).rejects.toThrow();expect(reads).toBe(0)
 await holder.first(async h=>{source=h.source;reader=h.source.inherited;escaped=h.assertCurrent;h.assertCurrent()});expect(flush).toHaveBeenCalledTimes(1);expect(()=>escaped()).toThrow('expired');await expect(holder.first(async()=>{})).rejects.toThrow();flush.mockClear()
 await holder.warm(async h=>{expect(h.source).toBe(source);expect(h.source.inherited).toBe(reader);h.assertCurrent()});await expect(holder.warm(async h=>{expect(h.source).toBe(source);throw Error('handoff failed')})).rejects.toThrow('handoff failed');await holder.warm(async h=>{expect(h.source).toBe(source);expect(h.source.inherited).toBe(reader)});await holder.passive(async h=>{expect('source' in h).toBe(false);expect(()=>h.assertCurrent()).toThrow()});expect(flush).not.toHaveBeenCalled();expect(()=>f.runtime.createSelectedSourceHolder(operation)).toThrow();await holder.close();flush.mockRestore()
 }finally{await f.close()}
})


it('joins an in-flight first acquisition on holder close',async()=>{
 const f=await createGatewayForkFixture();try{
 const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'project',projectId:'p'}),operation=readSelectedResultsOperation({version:2,kind:'session-fork-operation',prepared:{version:2,kind:'session-fork-prepared',core,requestIntent:intent,requestDigest},invocation:{version:1,operationId:'closing',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest}}),holder=f.runtime.createSelectedSourceHolder(operation),entered=Promise.withResolvers<void>(),leave=Promise.withResolvers<void>(),flush=f.coordinator.flush.bind(f.coordinator),spy=vi.spyOn(f.coordinator,'flush').mockImplementation(async id=>{entered.resolve();await leave.promise;return flush(id)})
 let callbacks=0;const first=holder.first(async()=>{callbacks++}).catch(error=>error);await entered.promise;let closed=false;const closing=holder.close().then(()=>{closed=true});await Promise.resolve();expect(closed).toBe(false);leave.resolve();expect(await first).toBeInstanceOf(Error);await closing;expect(callbacks).toBe(0);expect(closed).toBe(true);spy.mockRestore()
 }finally{await f.close()}
})

import { createCompletedPassiveContext } from '@i-harness/core-session/internal/bootstrap'
import { exportSelectedResultsConversationSeed } from '../../core-session/src/conversation/seed-export.ts'
it('exports an actual selected public seed with passive code store inside the held handoff',async()=>{
 const f=await createGatewayForkFixture();try{await f.coordinator.append('source',[{type:'turn/start'},{type:'user/message',text:'original'},{type:'turn/end'}]);const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'project',projectId:'p'}),operation=readSelectedResultsOperation({version:2,kind:'session-fork-operation',prepared:{version:2,kind:'session-fork-prepared',core,requestIntent:intent,requestDigest},invocation:{version:1,operationId:'export',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest}}),holder=f.runtime.createSelectedSourceHolder(operation)
 await holder.first(async handoff=>{const context=createCompletedPassiveContext({kind:'held-public-fork',sourceSessionId:'source',view:handoff.source.view,factOwner:handoff.source.document,assertCurrent:handoff.assertCurrent},core.selection);expect(context.kind).toBe('ready');if(context.kind!=='ready')throw Error('passive context unavailable');const selected=await exportSelectedResultsConversationSeed(context.context,handoff.source.inherited);expect(selected.kind).toBe('seed');if(selected.kind==='seed')expect(selected.seed.passive.codeStore.version).toBe(1)});await holder.close()
 }finally{await f.close()}
})
it('captures the original selected source once under the existing target owner',async()=>{
 const f=await createGatewayForkFixture();try{await f.coordinator.append('source',[{type:'turn/start'},{type:'user/message',text:'original'},{type:'turn/end'}]);const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'project',projectId:'p'}),operation=readSelectedResultsOperation({version:2,kind:'session-fork-operation',prepared:{version:2,kind:'session-fork-prepared',core,requestIntent:intent,requestDigest},invocation:{version:1,operationId:'capture-real',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest}}),holder=f.runtime.createSelectedSourceHolder(operation),flush=vi.spyOn(f.coordinator,'flush')
 const injected=vi.fn();await expect(holder.captureFirst(injected as unknown as AbortSignal)).rejects.toThrow();expect(injected).not.toHaveBeenCalled();const first=await holder.captureFirst();expect(first.kind).toBe('captured');if(first.kind==='captured'){const {readFile}=await import('node:fs/promises');expect((await readFile(join(f.sessions,'target.jsonl'))).toString()).toBe(first.headerBytes)}flush.mockClear();const second=await holder.captureWarm();expect(second).toBe(first);expect(flush).not.toHaveBeenCalled();await expect(f.coordinator.openManagedDocument('target')).rejects.toThrow();const sourceDocument=await f.coordinator.openManagedDocument('source');await sourceDocument.metadata.enterPlan('changed');await expect(holder.captureWarm()).rejects.toThrow();flush.mockClear();expect((await holder.reconcilePassive()).kind).toBe('committed');expect(flush).not.toHaveBeenCalled();await holder.close();flush.mockRestore()
 }finally{await f.close()}
})

it('captures selected nonempty legacy metadata from the original native reader',async()=>{
 const f=await createGatewayForkFixture();try{await f.runtime.contextOutput.configure({enabled:true});const source=await f.runtime.sourceFor('source'),ref=await f.runtime.contextOutput.capture({sessionId:'source',callId:'legacy',label:'real',text:'retained',complete:true,source});if(!ref)throw Error('capture unavailable');await f.coordinator.append('source',[{type:'turn/start'},{type:'user/message',text:'original'},{type:'step/start'},{type:'tool/call',callId:'legacy',name:'read',args:{}},{type:'assistant/message',text:''},{type:'tool/result',callId:'legacy',name:'read',output:'done'},{type:'step/end'},{type:'context/result-ref',ref},{type:'turn/end'}])
 const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'project',projectId:'p'}),operation=readSelectedResultsOperation({version:2,kind:'session-fork-operation',prepared:{version:2,kind:'session-fork-prepared',core,requestIntent:intent,requestDigest},invocation:{version:1,operationId:'capture-legacy',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest}}),holder=f.runtime.createSelectedSourceHolder(operation)
 const captured=await holder.captureFirst();expect(captured.kind).toBe('captured');if(captured.kind==='captured')expect(captured.seed.records.some(record=>record.type==='conversation/seed-results')).toBe(true);await holder.close()
 }finally{await f.close()}
})

it('cannot bypass original project mismatch by retrying the retained source',async()=>{
 const f=await createGatewayForkFixture();try{const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'project',projectId:'other'}),operation=readSelectedResultsOperation({version:2,kind:'session-fork-operation',prepared:{version:2,kind:'session-fork-prepared',core,requestIntent:intent,requestDigest},invocation:{version:1,operationId:'wrong-project',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest}}),holder=f.runtime.createSelectedSourceHolder(operation)
 await expect(holder.captureFirst()).rejects.toThrow('project mismatch');await expect(holder.captureWarm()).rejects.toThrow('project mismatch');const {readdir}=await import('node:fs/promises');expect((await readdir(f.sessions)).some(name=>name.startsWith('target.jsonl'))).toBe(false);await holder.close()
 }finally{await f.close()}
})



import { mkdtemp,mkdir,writeFile } from 'node:fs/promises'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createProjectScopeBroker } from '../src/project-scope.ts'
import { createNativeContextRuntime } from '../src/context-runtime.ts'
import { selectedBootstrapPaths } from '../../session-persistence-jsonl/src/backend/selected-results-route-path.ts'
it('does not confirm a byte-equal foreign header when original header issue never began',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'selected-no-header-issue-')),workspace=join(root,'w'),sessions=join(root,'s');await mkdir(workspace);const backend=createJsonlBackend(sessions),actual=backend.selectedCapture;backend.selectedCapture={...actual,async prepareSelectedHeader(){return {kind:'conflict'}}};const coordinator=createSessionCoordinator(backend,{lock:{enabled:true}}),projects=createProjectScopeBroker(coordinator,workspace);await coordinator.create({sessionId:'source'});await coordinator.append('source',[{type:'turn/start'},{type:'user/message',text:'original'},{type:'turn/end'}]);const runtime=await createNativeContextRuntime({workspace,storageRoot:join(root,'n'),coordinator,projectFor:projects.nativeScopeFor,resultReadScopeFor:projects.resultReadScopeFor,withBindingObservation:projects.withBindingObservation,retainSelectedProjectRead:projects.retainSelectedBindingRead,contextConfig:{enabled:true}})
 try{const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'unassigned'}),invocation={version:1 as const,operationId:'foreign-header',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest},operation=readSelectedResultsOperation({version:2,kind:'session-fork-operation',prepared:{version:2,kind:'session-fork-prepared',core,requestIntent:intent,requestDigest},invocation}),holder=runtime.createSelectedSourceHolder(operation),captured=await holder.captureFirst();if(captured.kind!=='captured')throw Error('capture unavailable');const route={protocol:'public-results-v1' as const,request:{invocation,core,requestIntent:intent}};await writeFile(selectedBootstrapPaths(join(sessions,'target.jsonl'),route).stage,captured.stageBytes);await writeFile(join(sessions,'target.jsonl'),captured.headerBytes);expect((await holder.reconcilePassive()).kind).toBe('unknown');await holder.close()
 }finally{await runtime.close();await projects.close();await coordinator.close()}
})


it('confirms the selected target through the original captured operation and project broker',async()=>{
 const f=await createGatewayForkFixture();try{
  await f.coordinator.append('source',[{type:'turn/start'},{type:'user/message',text:'selected'},{type:'turn/end'}])
  const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'project',projectId:'p'}),operation=readSelectedResultsOperation({version:2,kind:'session-fork-operation',prepared:{version:2,kind:'session-fork-prepared',core,requestIntent:intent,requestDigest},invocation:{version:1,operationId:'selected-project',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest}}),holder=f.runtime.createSelectedSourceHolder(operation)
  const captured=await holder.captureFirst();if(captured.kind!=='captured')throw Error('Selected capture unavailable')
  const {selectedResultsPreparationFacts}=await import('../../session-persistence/src/coordinator/selected-results-preparation.ts')
  const forged=f.projects.prepareSelectedInheritance({operation,target:{},sourceAvailable:()=>true,assertNewWorkCurrent:()=>{},targetAvailable:()=>true})
  expect((await forged.confirm(selectedResultsPreparationFacts(captured.stage,captured.seed.records),()=>true)).kind).toBe('blocked');forged.close()
  expect(await holder.confirmTarget()).toEqual({kind:'confirmed'})
  const {createHash}=await import('node:crypto');const bindingKey='desktop-session-project-'+createHash('sha256').update('target').digest('hex')
  expect(await f.coordinator.getDocument(bindingKey)).toEqual({version:1,projectId:'p'})
  await (await f.coordinator.openManagedDocument('source')).metadata.enterPlan('revoke')
  await expect(holder.confirmTarget()).rejects.toThrow()
  await holder.close()
 }finally{await f.close()}
})

it('confirms the selected managed artifacts through the original result store',async()=>{
 const f=await createGatewayForkFixture();try{
  await f.runtime.contextOutput.configure({enabled:true});await f.coordinator.adoptOwnership('source')
  const source=await f.runtime.sourceFor('source'),current=(await f.projects.resultReadScopeFor('source'))!,scope=f.runtime.contextOutput.registerResultScope({operationId:'selected-producer',sessionId:'source',callId:'retained',source},()=>{current();return !!f.coordinator.ownerOf('source')}),sink=await f.runtime.contextOutput.beginResult(scope,'text-utf8-v1')
  await sink.write(Buffer.from('selected managed'));const saved=await sink.finish('complete');if(saved.kind!=='committed')throw Error('Original artifact unavailable')
  await f.coordinator.append('source',[{type:'turn/start'},{type:'user/message',text:'selected'},{type:'step/start'},{type:'tool/call',callId:'retained',name:'read',args:{}},{type:'assistant/message',text:''},{type:'tool/result',callId:'retained',name:'read',envelope:{version:1,execution:{outcome:'succeeded',dispatch:'dispatched'},preview:'',media:[],retention:{kind:'artifact',ref:saved.ref}}},{type:'step/end'},{type:'turn/end'}])
  const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'project',projectId:'p'}),operation=readSelectedResultsOperation({version:2,kind:'session-fork-operation',prepared:{version:2,kind:'session-fork-prepared',core,requestIntent:intent,requestDigest},invocation:{version:1,operationId:'selected-managed',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest}}),holder=f.runtime.createSelectedSourceHolder(operation)
  const captured=await holder.captureFirst();if(captured.kind!=='captured')throw Error('Selected capture unavailable');expect(captured.seed.records[0]).toMatchObject({type:'conversation/seed-manifest',artifacts:[{ref:saved.ref}]})
  expect((await holder.confirmTarget()).kind).toBe('confirmed');const flush=vi.spyOn(f.coordinator,'flush');const first=await holder.confirmManagedDependencies();expect(first.kind).toBe('confirmed');expect(await holder.confirmManagedDependencies()).toEqual(first);expect(flush).not.toHaveBeenCalled();await (await f.coordinator.openManagedDocument('source')).metadata.enterPlan('revoke');await expect(holder.confirmManagedDependencies()).rejects.toThrow();await holder.close();flush.mockRestore()
 }finally{await f.close()}
},30000)

it('drains an active selected project confirmation before releasing its original target claim',async()=>{
 const f=await createGatewayForkFixture();try{
  await f.coordinator.append('source',[{type:'turn/start'},{type:'user/message',text:'selected'},{type:'turn/end'}])
  const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'project',projectId:'p'}),operation=readSelectedResultsOperation({version:2,kind:'session-fork-operation',prepared:{version:2,kind:'session-fork-prepared',core,requestIntent:intent,requestDigest},invocation:{version:1,operationId:'selected-close-flight',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest}}),holder=f.runtime.createSelectedSourceHolder(operation)
  expect((await holder.captureFirst()).kind).toBe('captured');expect(f.coordinator.ownerOf('target')).toBe(true)
  const entered=Promise.withResolvers<void>(),leave=Promise.withResolvers<void>(),original=f.coordinator.putDocument.bind(f.coordinator),spy=vi.spyOn(f.coordinator,'putDocument').mockImplementation(async(key,value)=>{entered.resolve();await leave.promise;return original(key,value)})
  const confirmation=holder.confirmTarget().catch(error=>error);await entered.promise
  let closed=false;const closing=holder.close().then(()=>{closed=true});try{await new Promise(resolve=>setTimeout(resolve,75));expect(closed).toBe(false);expect(f.coordinator.ownerOf('target')).toBe(true)}finally{leave.resolve();await confirmation;await closing;spy.mockRestore()}
 }finally{await f.close()}
})

it('confirms exact selected legacy rows through the original store without a synthetic group',async()=>{
 const f=await createGatewayForkFixture();try{
  await f.runtime.contextOutput.configure({enabled:true});const source=await f.runtime.sourceFor('source'),ref=await f.runtime.contextOutput.capture({sessionId:'source',callId:'legacy',label:'selected',text:'legacy body',complete:true,source});if(!ref)throw Error('Legacy capture unavailable')
  await f.coordinator.append('source',[{type:'turn/start'},{type:'user/message',text:'selected'},{type:'step/start'},{type:'tool/call',callId:'legacy',name:'read',args:{}},{type:'assistant/message',text:''},{type:'tool/result',callId:'legacy',name:'read',output:'done'},{type:'step/end'},{type:'context/result-ref',ref},{type:'turn/end'}])
  const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'project',projectId:'p'}),operation=readSelectedResultsOperation({version:2,kind:'session-fork-operation',prepared:{version:2,kind:'session-fork-prepared',core,requestIntent:intent,requestDigest},invocation:{version:1,operationId:'selected-legacy-v2',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest}}),holder=f.runtime.createSelectedSourceHolder(operation)
  expect((await holder.captureFirst()).kind).toBe('captured');expect((await holder.confirmTarget()).kind).toBe('confirmed');expect((await holder.confirmLegacyDependencies()).kind).toBe('confirmed')
  await (await f.coordinator.openManagedDocument('source')).metadata.enterPlan('revoke');const flush=vi.spyOn(f.coordinator,'flush');expect((await holder.reconcilePassive()).kind).toBe('committed');expect(flush).not.toHaveBeenCalled();flush.mockRestore();await holder.close()
 }finally{await f.close()}
},60000)

it('publishes and adopts the selected target only after both original dependency confirmations',async()=>{
 const f=await createGatewayForkFixture();try{
  await f.coordinator.append('source',[{type:'turn/start'},{type:'user/message',text:'selected'},{type:'turn/end'}])
  const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'project',projectId:'p'}),operation=readSelectedResultsOperation({version:2,kind:'session-fork-operation',prepared:{version:2,kind:'session-fork-prepared',core,requestIntent:intent,requestDigest},invocation:{version:1,operationId:'selected-publish',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest}}),holder=f.runtime.createSelectedSourceHolder(operation)
  expect((await holder.captureFirst()).kind).toBe('captured');const result=await holder.publishWarm();expect(result.kind).toBe('ready')
  const document=await f.coordinator.openManagedDocument('target');document.assertReady();expect((await document.metadata.admit({type:'plan/mode',mode:'on'})).kind).toBe('committed')
  await holder.close();document.assertReady()
 }finally{await f.close()}
},60000)

it('transfers a real selected legacy result through A to B to C exactly once',async()=>{
 const f=await createGatewayForkFixture();try{
  await f.runtime.contextOutput.configure({enabled:true});const source=await f.runtime.sourceFor('source'),ref=await f.runtime.contextOutput.capture({sessionId:'source',callId:'legacy',label:'selected',text:'nested legacy',complete:true,source});if(!ref)throw Error('Legacy capture unavailable')
  await f.coordinator.append('source',[{type:'turn/start'},{type:'user/message',text:'selected'},{type:'step/start'},{type:'tool/call',callId:'legacy',name:'read',args:{}},{type:'assistant/message',text:''},{type:'tool/result',callId:'legacy',name:'read',output:'done'},{type:'step/end'},{type:'context/result-ref',ref},{type:'turn/end'}])
  function operation(sourceSessionId:string,targetSessionId:string,operationId:string){const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId,selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'project',projectId:'p'});return readSelectedResultsOperation({version:2,kind:'session-fork-operation',prepared:{version:2,kind:'session-fork-prepared',core,requestIntent:intent,requestDigest},invocation:{version:1,operationId,targetSessionId,createdAt:'2026-10-28T00:00:00.000Z',requestDigest}})}
  const first=f.runtime.createSelectedSourceHolder(operation('source','target','selected-ab'));expect((await first.captureFirst()).kind).toBe('captured');const firstReady=await first.publishWarm();expect(firstReady.kind).toBe('ready');const flush=vi.spyOn(f.coordinator,'flush');const warm=await first.publishWarm();expect(warm.kind).toBe('ready');if(firstReady.kind==='ready'&&warm.kind==='ready')expect(warm.receipt).toEqual(firstReady.receipt);expect(flush).not.toHaveBeenCalled();flush.mockRestore();await first.close()
  const second=f.runtime.createSelectedSourceHolder(operation('target','next','selected-bc')),captured=await second.captureFirst();expect(captured.kind).toBe('captured');if(captured.kind!=='captured')throw Error('Nested capture unavailable')
  const rows=captured.seed.records.filter(record=>record.type==='conversation/seed-results').flatMap(record=>record.type==='conversation/seed-results'?record.page.rows:[]);expect(rows.filter(row=>row.protocol==='legacy')).toHaveLength(1)
  expect((await second.publishWarm()).kind).toBe('ready');await second.close()
  await f.runtime.contextOutput.clear('source');await f.runtime.contextOutput.clear('target')
  await f.runtime.withLegacyReadObservation({sessionId:'next'},async observation=>{const result=await f.runtime.contextOutput.readLegacyObserved({sessionId:'next'},{refId:ref.id},observation);expect(result.text).toBe('nested legacy')})
 }finally{await f.close()}
},120000)

it.each(['expiry','clear'] as const)('fences selected seed issuance after original legacy %s',async(mode)=>{
 const f=await createGatewayForkFixture();try{
  await f.runtime.contextOutput.configure({enabled:true});const source=await f.runtime.sourceFor('source'),ref=await f.runtime.contextOutput.capture({sessionId:'source',callId:'legacy',label:'selected',text:'expiring legacy',complete:true,source});if(!ref)throw Error('Legacy capture unavailable')
  await f.coordinator.append('source',[{type:'turn/start'},{type:'user/message',text:'selected'},{type:'step/start'},{type:'tool/call',callId:'legacy',name:'read',args:{}},{type:'assistant/message',text:''},{type:'tool/result',callId:'legacy',name:'read',output:'done'},{type:'step/end'},{type:'context/result-ref',ref},{type:'turn/end'}])
  const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'project',projectId:'p'}),operation=readSelectedResultsOperation({version:2,kind:'session-fork-operation',prepared:{version:2,kind:'session-fork-prepared',core,requestIntent:intent,requestDigest},invocation:{version:1,operationId:'selected-expiry',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest}}),holder=f.runtime.createSelectedSourceHolder(operation),captured=await holder.captureFirst();if(captured.kind!=='captured')throw Error('Selected capture unavailable')
  const entered=Promise.withResolvers<void>(),leave=Promise.withResolvers<void>(),append=f.backend.selectedJournal.appendOwnedBatch.bind(f.backend.selectedJournal),spy=vi.spyOn(f.backend.selectedJournal,'appendOwnedBatch').mockImplementation(async(...args)=>{entered.resolve();await leave.promise;return append(...args)})
  const publishing=holder.publishWarm();await entered.promise;const now=mode==='expiry'?vi.spyOn(Date,'now').mockReturnValue(ref.expiresAt+1):undefined
  try{if(mode==='clear')await f.runtime.contextOutput.clear('source');leave.resolve();const outcome=await publishing.catch(error=>error);expect(outcome instanceof Error||outcome.kind==='blocked').toBe(true)}finally{now?.mockRestore();leave.resolve();spy.mockRestore()}
  const {readFile}=await import('node:fs/promises');expect((await readFile(join(f.sessions,'target.jsonl'))).toString()).toBe(captured.headerBytes);await holder.close()
 }finally{await f.close()}
},60000)
