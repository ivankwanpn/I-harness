import {afterEach,expect,it,vi} from 'vitest'
import {append,createSession,createNondurableFactOwner} from '@i-harness/core-session'
import {createGenerationLifecycle} from '../src/lifecycle/generation-actions.ts'
import type {PassiveProducerRecord} from '@i-harness/llm-seam/internal/passive-observation'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {prepareModelRequest,createRetryingClient,resolveRetryPolicy} from '@i-harness/llm-seam'
import {withOriginalPassiveClientAttribution} from '@i-harness/llm-seam/internal/passive-observation'
afterEach(()=>vi.unstubAllGlobals())
it('captures original acknowledged memory seq/trustedAt and original close without new source calls',async()=>{
 const session=createSession();append(session,{type:'command/run',commandId:'c',name:'fixture',source:{kind:'user'}})
 const document=createNondurableFactOwner(session),action=document.beginAction(),rows:PassiveProducerRecord[]=[];let drained=0
 const lifecycle=createGenerationLifecycle(document.view,'s',action,undefined,{async beforeDrain(){drained++},passiveGeneration:{capture(row){rows.push(row)},unavailable(reason){throw Error(reason)}}})
 const generation=await lifecycle.open('manual',{kind:'command',seq:0});await generation.close('stopped');await lifecycle.drain();action.finish()
 const facts=rows.filter(row=>row.kind==='fact');expect(facts).toHaveLength(2)
 for(const row of facts){expect(row.source).toBe('memory-committed');expect(row.event).toEqual(document.view.events[row.factSeq]);expect(row.event.trustedAt).toBeGreaterThan(0)}
 expect(facts.map(row=>row.event.op)).toEqual(['open','close']);expect(drained).toBeGreaterThan(0)
})
it('two actual retry sends keep one original action and distinct original reservations/send observations',async()=>{
 const session=createSession();append(session,{type:'command/run',commandId:'c',name:'fixture',source:{kind:'user'}})
 const owner=createNondurableFactOwner(session),action=owner.beginAction(),rows:PassiveProducerRecord[]=[],gaps:string[]=[]
 const observer={capture(row:PassiveProducerRecord){rows.push(row)},unavailable(reason:string){gaps.push(reason)}}
 const lifecycle=createGenerationLifecycle(owner.view,'s',action,undefined,{async beforeDrain(){},passiveGeneration:observer})
 const generation=await lifecycle.open('manual',{kind:'command',seq:0})
 let sends=0;vi.stubGlobal('fetch',async()=>{sends++;if(sends===1)return new Response('fixture busy',{status:503});return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":3}}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})})
 const attributed=withOriginalPassiveClientAttribution(createOpenAICompatibleClient({apiKey:'fixture-only',model:'actual-model',baseUrl:'https://original.invalid'}),{providerId:'p',modelId:'actual-model',workspace:'w',billing:'api'})
 const client=createRetryingClient(attributed,resolveRetryPolicy({mode:'normal',maxRetries:1,backoff:{initialDelayMs:1,maxDelayMs:1,jitterRatio:0}}))
 const prepared=await prepareModelRequest(client,{systemPrompt:'',messages:[],tools:[]});await generation.bind(prepared)
 for await(const _ of prepared.stream({generation:generation.control('summary')})){}
 await generation.close('stopped');await lifecycle.drain();action.finish()
 expect(sends).toBe(2);expect(gaps).toEqual(['original-send-usage-unavailable'])
 const handoff=rows.find(row=>row.kind==='handoff');expect(handoff).toMatchObject({identity:{actionId:generation.actionId,lane:'summary'},attribution:{modelId:'actual-model'}})
 expect(rows.filter(row=>row.kind==='usage').at(-1)).toMatchObject({terminalCoverage:'complete'})
 const handoffs=rows.filter(row=>row.kind==='handoff');expect(handoffs).toHaveLength(2);expect(new Set(handoffs.map(row=>row.identity.actionId))).toEqual(new Set([generation.actionId]));expect(new Set(handoffs.map(row=>row.identity.attemptId)).size).toBe(2);expect(new Set(handoffs.map(row=>row.confirmation.sendId)).size).toBe(2)
 expect(rows.filter(row=>row.kind==='fact').map(row=>row.event.op)).toEqual(['open','bind','reserve','settle','reserve','settle','close'])
})
it('captures genuine durable seq/time after original close reconciliation without a new capture',async()=>{
 const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'passive-ack-')),backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true,lockRoot:root}},taskDocumentStorageContract)
 const {id}=await coordinator.create();coordinator.enqueue(id,[{type:'command/run',commandId:'c',name:'fixture',source:{kind:'user'}}]);await coordinator.flush(id)
 const document=await coordinator.openManagedDocument(id)
 const action=document.beginAction(),rows:PassiveProducerRecord[]=[],gaps:string[]=[]
 const register=action.registerSettlementSource.bind(action);let closeCaptures=0
 action.registerSettlementSource=(...args)=>{const source=register(...args),capture=source.generation.capture.bind(source.generation);source.generation.capture=event=>{const original=capture(event);if(event.type==='context/action'&&event.op==='close'){closeCaptures++;const admit=original.admit.bind(original);original.admit=async()=>{const result=await admit();if(result.kind==='committed')return {kind:'unknown',key:result.receipt.key};return result}}return original};return source}
 const lifecycle=createGenerationLifecycle(document.view,id,action,undefined,{async beforeDrain(){},passiveGeneration:{capture(row){rows.push(row)},unavailable(reason){gaps.push(reason)}}})
 const generation=await lifecycle.open('manual',{kind:'command',seq:0})
 await expect(generation.close('stopped')).rejects.toMatchObject({code:'GENERATION_UNCERTAIN'})
 await generation.recoverClose!();await lifecycle.drain();action.finish();expect(closeCaptures).toBe(1)
 const facts=rows.filter(row=>row.kind==='fact');expect(facts.map(row=>row.event.op)).toEqual(['open','close']);expect(gaps).toEqual([])
 for(const row of facts){expect(row.source).toBe('journal-fact');expect(row.event).toEqual(document.view.events[row.factSeq])}
 await coordinator.close()
})
