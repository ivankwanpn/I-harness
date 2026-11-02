import {expect,it,vi} from 'vitest'
import * as auditApi from '../../core-session/src/managed/approval-audit.ts'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext,captureExecutionHookChannel,waterfallExecutionEvent} from '@i-harness/core-plugin'
import {createToolRegistryWithModelOrigin} from '@i-harness/core-tools/model-origin'
import {createManagedAgent} from '@i-harness/core-agent'
import {createManagedAgentModelOriginOwner} from '@i-harness/core-agent/model-origin'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {createExecutionGenerationLifecycle} from '../../session-executor/src/lifecycle/generation-actions.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {registerGuardian,type GuardianConfig} from '../src/guardian/index.ts'

it.each([false,true])('reviews the managed caller and rejects unrelated same-action writes (%s)',async(intervene)=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-guardian-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'parent'});const execution=await acquireManagedExecution(coordinator,'parent'),ctx=createContext(),origin=createManagedAgentModelOriginOwner(ctx,execution),pair=createToolRegistryWithModelOrigin(ctx,{executionOwner:{kind:'managed-execution',domain:origin.domain,context:ctx,sessionId:'parent'}},origin.verifier)
 let parentAction:ReturnType<typeof execution.owner.beginAction>|undefined,calls=0,actualAudit:auditApi.OriginalManagedApprovalAudit|undefined;const originalAudit=auditApi.createOriginalManagedApprovalAudit;const auditSpy=vi.spyOn(auditApi,'createOriginalManagedApprovalAudit').mockImplementation((...args)=>{actualAudit=originalAudit(...args);return actualAudit});pair.registry.register({name:'write_probe',description:'controlled write',inputSchema:{type:'object'},async execute(){calls++;return 'done'}})
 waterfallExecutionEvent(ctx,'tools/pre-execute',async(payload,next)=>{const result=await next(payload);return (payload as {name?:string}).name==='write_probe'?{kind:'ask',reason:'controlled review'}:result})
 let prompt='';const reviewerServer=await createLoopbackProvider('/v1/chat/completions',[async(response,request)=>{prompt=JSON.stringify(request.body.messages);expect(request.body.tools??[]).toEqual([]);if(!parentAction||!actualAudit)throw Error('original approval witness missing');const action=parentAction,witness=actualAudit;expect(()=>auditApi.assertOriginalManagedApprovalAudit(origin.domain,action,{...witness},0,0)).toThrow();expect(()=>auditApi.assertOriginalManagedApprovalAudit({} as typeof origin.domain,action,witness,0,0)).toThrow();if(intervene){expect((await parentAction.facts.metadata.admit({type:'sandbox/mode',mode:'read-only'})).kind).toBe('committed')}response.end('data: '+JSON.stringify({choices:[{delta:{content:'{"outcome":"approve","rationale":"allowed","risk_level":"none"}'},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:1}})+'\n\ndata: [DONE]\n\n')}]),reviewer=createOpenAICompatibleClient({apiKey:'loopback',model:'reviewer',baseUrl:reviewerServer.baseUrl})
 const frame=(tool:boolean)=>`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'call',function:{name:'write_probe',arguments:'{}'}}]}:{content:'complete'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:4,completion_tokens:1}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async r=>{r.end(frame(true))},async r=>{r.end(frame(false))}]),model=createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl})
 try{
  await registerGuardian(ctx,{managedParent:{domain:origin.domain},execution:'isolated',parentModel:model,model:reviewer,parentRegistry:pair.registry,parentCtx:ctx,resolveModel:async()=>({status:'unconfigured',reason:'unused'})} as unknown as GuardianConfig)
  const agent=createManagedAgent(ctx,{execution,domain:origin.domain,hooks:captureExecutionHookChannel(ctx),modelCallOrigin:origin.bind(pair.registry,pair.driver),tools:pair.registry,model,systemPrompt:'original',budget:{contextWindow:16000},maxOutputTokens:128,generationFactory:(action,deps)=>{parentAction=action;return createExecutionGenerationLifecycle(execution,'parent',action,undefined,deps)}})
  if(intervene){await expect(agent.run('please perform the original task')).rejects.toThrow('guardian denied');expect(calls).toBe(0)}else{expect((await agent.run('please perform the original task')).finalText).toBe('complete');expect(calls).toBe(1)}expect(prompt).toContain('tool/call');expect(prompt).toContain('write_probe');expect(Object.hasOwn(execution.owner,'view')).toBe(false);expect(actualAudit).toBeDefined();expect(()=>auditApi.assertOriginalManagedApprovalAudit(origin.domain,parentAction!,actualAudit!,0,0)).toThrow()
 }finally{auditSpy.mockRestore();await coordinator.close();await server.close();await reviewerServer.close()}
},30000)
