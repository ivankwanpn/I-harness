import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createSessionService} from '../../session-executor/src/service.ts'
import {controlledModel} from '../../session-executor/test/controlled-model.ts'
import {createManagedEventBridge} from '../../sdk/src/managed-event-bridge.ts'

it('publishes actual managed runtime events and retires the transport subscription',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'sdk-owned-events-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const model=controlledModel(async function*(){yield {type:'text/chunk',text:'done'};yield {type:'end'}})
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[]},model,contextWindow:4096,maxOutputTokens:128})
 const sent:any[]=[],bridge=createManagedEventBridge(value=>sent.push(value)),off=service.onManagedRuntimeLifecycle!(event=>{if(event.kind==='published')bridge.attach(event.sessionId,event.owner);else if(event.kind==='retiring')bridge.retire(event.sessionId)})
 try {const input=await service.managedInputFor!('main');expect(input).toBeDefined();await input!.inbox.admit({inputId:'image-input',text:'hello',images:[{mediaType:'image/png',dataBase64:'aGVsbG8='}],delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}});await service.submit('main','hello',new AbortController().signal,{admittedInputId:'image-input'});await new Promise(resolve=>setTimeout(resolve,0));expect(sent.some(value=>value.method==='session/event'&&value.params.event.type==='turn/end')).toBe(true);expect(sent.some(value=>value.method==='session/event'&&value.params.event.type==='user/message'&&value.params.event.images?.[0]?.dataBase64==='aGVsbG8=')).toBe(true);await service.close();const count=sent.length;await bridge.close();expect(sent).toHaveLength(count)}finally{off();await bridge.close();await service.close().catch(()=>{});await coordinator.close().catch(()=>{})}
},30000)

it('publishes the original image after the committed journal advances during the live lookup', async () => {
 const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'sdk-image-append-'))
 const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), {lock:{enabled:true}}, taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const model = controlledModel(async function* () { yield {type:'text/chunk',text:'done'}; yield {type:'end'} })
 const service = createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[]},model,contextWindow:4096,maxOutputTokens:128})
 const firstRead = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
 const sent: any[] = [], bridge = createManagedEventBridge(frame => sent.push(frame))
 let held = false
 const off = service.onManagedRuntimeLifecycle!(event => {
   if (event.kind !== 'published') return bridge.retire(event.sessionId)
   const owner = event.owner
   bridge.attach(event.sessionId, {subscribe: fn => owner.subscribe(fn), observe() {
     const original = owner.observe()
     async function hold<T>(read: Promise<T>) {
       const result = await read
       if (!held) { held = true; firstRead.resolve(); await resume.promise }
       return result
     }
     return {identity: original.identity, eventCount: original.eventCount, assertCurrent: () => original.assertCurrent(),
       readHistoryPage: options => hold(original.readHistoryPage(options)),
       inbox: { admitted: (id: string) => hold(original.inbox.admitted(id)) },
     } as typeof original
   }})
 })
 const image = {mediaType:'image/png' as const,dataBase64:'QUJD'}
 try {
   const input = await service.managedInputFor!('main')
   await input!.inbox.admit({inputId:'img',text:'look',images:[image],delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
   const run = service.submit('main','look',new AbortController().signal,{admittedInputId:'img'})
   await Promise.all([run, firstRead.promise])
   resume.resolve()
   await bridge.flush('main')
   expect(sent.filter(x => x.method === 'session/status' && x.params.status === 'error')).toEqual([])
   expect(sent.filter(x => x.params?.event?.type === 'user/message').map(x => x.params.event.images)).toEqual([[image]])
   const types = sent.map(frame => frame.params?.event?.type)
   expect(types.indexOf('turn/end')).toBeGreaterThan(types.indexOf('user/message'))
 } finally { resume.resolve(); off(); await bridge.close(); await service.close(); await coordinator.close() }
},30000)
