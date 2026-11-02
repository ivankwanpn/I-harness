import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {registerExec} from '@i-harness/exec'
import {createContextOutputService} from '@i-harness/context-output'
import {SHIPPING_REPORT_POLICY} from '@i-harness/subagent'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {createGenerationLifecycle} from '../src/lifecycle/generation-actions.ts'
import {createUnmanagedTaskChildHost} from '../src/lifecycle/task-child-host.ts'
import {createTaskResultRetention} from '../src/lifecycle/task-result-retention.ts'
import {createSessionService} from '../src/service.ts'

it('wakes the original private service for a background Task receipt and reads its result',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'service-task-wake-')),backend=createJsonlBackend(join(root,'sessions')),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'parent'})
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),woken=Promise.withResolvers<void>()
 const wire=(delta:unknown,finish_reason:string)=>`data: ${JSON.stringify({choices:[{delta,finish_reason}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const call=(name:string,args:unknown,id:string)=>({tool_calls:[{index:0,id,function:{name,arguments:JSON.stringify(args)}}]})
 const childServer=await createLoopbackProvider('/v1/chat/completions',[async response=>{entered.resolve();await release.promise;response.end(wire({content:'original child result'},'stop'))}]),child=createOpenAICompatibleClient({apiKey:'loopback',model:'child',baseUrl:childServer.baseUrl})
 const server=await createLoopbackProvider('/v1/chat/completions',[async r=>{r.end(wire(call('spawn_agent',{message:'do work',task_name:'child',background:true},'task-call'),'tool_calls'))},async r=>{r.end(wire({content:'parent returned'},'stop'))},async(r,request)=>{expect(JSON.stringify(request.body)).toContain('task-1');r.end(wire(call('get_task_output',{task_ids:['task-1']},'read-task'),'tool_calls'))},async r=>{woken.resolve();r.end(wire({content:'done'},'stop'))}])
 const output=createContextOutputService({root:join(root,'output'),workspaceId:'task-fixture'}),service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],ownedTask:{async options(original){const exec=registerExec(original.ctx);original.retain(()=>exec.dispose());original.retain(()=>output.close());return {parentModel:child,exec,resolveModel:async()=>({status:'unconfigured' as const,reason:'unused'}),prepareTaskChild:createUnmanagedTaskChildHost({coordinator,policy:'unmanaged'}),generationFactoryFor:(owner,id,selected)=>(owned,deps)=>createGenerationLifecycle(owner.view,id,owned,{enabled:false,selectedClient:selected},deps),reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(output,undefined,'parent'),persist:{coordinator,stateId:'parent',parentSessionId:'parent'}}}}},model:createOpenAICompatibleClient({apiKey:'loopback',model:'parent',baseUrl:server.baseUrl}),contextWindow:32000,maxOutputTokens:128})
 try{const turn=service.submit('parent','delegate work',new AbortController().signal);await Promise.race([entered.promise,turn.then(()=>{throw Error('parent returned before child started')},error=>{throw error})]);await turn;expect(server.requests).toHaveLength(2);release.resolve();await Promise.race([woken.promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('Task receipt did not wake parent')),120000))]);expect(server.requests).toHaveLength(4);expect(JSON.stringify(server.requests[3]!.body)).toContain('original child result');const events=(await backend.read('parent')).events;expect(events.filter(event=>event.type==='agent/delivery-received'&&event.key.kind==='subagent')).toHaveLength(1)}finally{release.resolve();await service.close();await coordinator.close();await server.close();await childServer.close()}
},180000)
