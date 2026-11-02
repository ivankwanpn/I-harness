import {expect,it,vi} from 'vitest'
const probe=vi.hoisted(()=>({gate:undefined as undefined|{entered():void;wait:Promise<void>},failClose:false}))
vi.mock('../src/execution-internal.ts',async load=>{const original=await load<typeof import('../src/execution-internal.ts')>();return {...original,associateExecutionDependencies(backend:object,open:Parameters<typeof original.associateExecutionDependencies>[1]){original.associateExecutionDependencies(backend,(...args)=>{const scope=open(...args);return Object.freeze({assertCurrent:scope.assertCurrent.bind(scope),async readEvent(ordinal:number){const value=await scope.readEvent(ordinal),gate=probe.gate;if(gate){probe.gate=undefined;gate.entered();await gate.wait}return value},async close(){if(probe.failClose)throw Error('controlled admission cleanup');await scope.close()}})})}}})
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../src/execution-internal.ts'

it.each(['commit','cleanup-failure'] as const)('joins only the original finite image admission read before writer %s',async mode=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'image-read-writer-')),backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'parent'});const execution=await acquireManagedExecution(coordinator,'parent'),source=execution.owner.registerReceivedInputSource(async()=>{}),action=execution.owner.beginAction()
 try{
  const admitted=await source.captureAdmitted({type:'agent/input/admitted',version:1,inputId:'image',text:'inspect',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'},images:[{mediaType:'image/png',dataBase64:'AQID'}]}).admit();expect(admitted.kind).toBe('committed')
  const promoted=await action.captureInputPromotion({kind:'input-start',turn:{type:'turn/start'},message:{type:'user/message',text:'inspect',imageInputId:'image'}},()=>true).admit();expect(promoted.kind).toBe('committed')
  const observation=execution.observe(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();probe.gate={entered:entered.resolve,wait:release.promise}
  const reading=observation.inbox.admitted('image');void reading.catch(()=>{});await entered.promise
  const capture=action.captureLifecycle!({type:'step/start',actionId:'step',attemptId:'attempt'}),writing=capture.admit();let settled=false;void writing.finally(()=>{settled=true}).catch(()=>{});await Promise.resolve();expect(settled).toBe(false)
  if(mode==='cleanup-failure')probe.failClose=true;release.resolve()
  if(mode==='commit'){expect((await reading)?.images).toHaveLength(1);expect((await writing).kind).toBe('committed')}
  else {await expect(reading).rejects.toThrow('controlled admission cleanup');expect((await writing).kind).not.toBe('committed');probe.failClose=false}
  const events=(await backend.read('parent')).events;expect(events.filter(event=>event.type==='step/start')).toHaveLength(mode==='commit'?1:0)
 }finally{probe.failClose=false;probe.gate=undefined;await source.close();action.finish();await coordinator.close()}
},20000)
