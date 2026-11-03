import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createSessionService} from '../../session-executor/src/service.ts'
import {controlledModel} from '../../session-executor/test/controlled-model.ts'
import {createDesktopInput} from '../src/input.ts'

it('uses original managed preparation once while keeping complete callback for complete route',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-input-prep-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 let transforms=0,complete=0,request='';const model=controlledModel(async function*(input){request=JSON.stringify(input);yield {type:'text/chunk',text:'done'};yield {type:'end'}})
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],async mountDefaultSurface(original,live){return {systemPrompt:()=> 'system',modelToolSchemas:live.modelToolSchemas,modelOverheadTokens:()=>10,async prepareInput(text){transforms++;return 'expanded '+text},async reconcileAuthority(){original.assertCurrent()}}}},model,contextWindow:4096,maxOutputTokens:128})
 const input=createDesktopInput(coordinator,service,{managedPreparation:true,async prepare(_id,text){complete++;return text}})
 try{await input.admit('main',{text:'hello',delivery:'queue'});await input.drain();expect(transforms).toBe(1);expect(complete).toBe(0);expect(request).toContain('expanded hello');expect((await input.state('main')).items).toEqual([])}finally{await input.close();await service.close();await coordinator.close()}
},30000)

it('keeps the complete preparation callback when the service selects compatibility',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'complete-input-prep-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 let calls=0,request='';const model=controlledModel(async function*(input){request=JSON.stringify(input);yield {type:'text/chunk',text:'done'};yield {type:'end'}})
 const service=createSessionService({workspace:root,coordinator,codeMode:{mode:'off'},model,contextWindow:32000,maxOutputTokens:128})
 let failure='';const input=createDesktopInput(coordinator,service,{managedPreparation:true,onStatus(_id,_running,error){if(error)failure=error},async prepare(_id,text){calls++;return 'complete '+text}})
 try{await input.admit('main',{text:'hello',delivery:'queue'});await input.drain();expect(calls).toBe(1);expect(failure).toBe('');expect(request).toContain('complete hello')}finally{await input.close();await service.close();await coordinator.close()}
},30000)

it('resumes a durably queued managed input through the same retained preparation',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-input-resume-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 let transforms=0,complete=0,request='';const model=controlledModel(async function*(value){request=JSON.stringify(value);yield {type:'text/chunk',text:'done'};yield {type:'end'}})
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],async mountDefaultSurface(original,live){return {systemPrompt:()=> 'system',modelToolSchemas:live.modelToolSchemas,modelOverheadTokens:()=>10,async prepareInput(text){transforms++;return 'resumed '+text},async reconcileAuthority(){original.assertCurrent()}}}},model,contextWindow:4096,maxOutputTokens:128})
 const input=createDesktopInput(coordinator,service,{managedPreparation:true,async prepare(_id,text){complete++;return text}})
 try{const first=await input.admit('main',{text:'later',delivery:'queue',start:false,clientToken:'same-token-123'});const second=await input.admit('main',{text:'later',delivery:'queue',start:false,clientToken:'same-token-123'});expect(second.inputId).toBe(first.inputId);const queued=await input.state('main');expect(queued.resumable).toBe(true);expect(queued.items.some(row=>row.text==='later')).toBe(true);await input.resume('main');await input.drain();expect(transforms).toBe(1);expect(complete).toBe(0);expect(request).toContain('resumed later')}finally{await input.close();await service.close();await coordinator.close()}
},30000)
