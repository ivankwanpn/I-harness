import {expect,it,vi} from 'vitest'
import {mkdtemp,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createSession,append,toJSONL,decodeFactBatch,createConversationValidationIndex,type SettlementFacts,type ProducerFactOutcome,type BatchKey} from '@i-harness/core-session'
import {createSessionCoordinator} from '../../session-persistence/src/index.ts'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {createAgentContext} from '../src/agent/context.ts'
import {prepareTextFixture,checkpointOfLength} from '../../compaction/test/fixtures/checkpoint.ts'
it('an actually issued unknown publication retains its original key/capture after Stop and never reissues',async()=>{
 vi.stubGlobal('fetch',()=>{throw Error('no network')})
 const owner='held-receipt-owner',session=createSession(),d='a'.repeat(64)
 for(let i=0;i<20;i++)append(session,{type:'user/message',text:`segment-${i} ${'x'.repeat(400)}`})
 append(session,{type:'context/soft-reduction',version:1,op:'start',ownerSessionId:owner,sequenceId:'prior',workKey:d,sourceKey:d,protectionKey:d,policyKey:d,acceptedExchanges:0,humanTurns:0})
 append(session,{type:'context/soft-reduction',version:1,op:'terminal',ownerSessionId:owner,sequenceId:'prior',startSeq:20,workKey:d,sourceKey:d,outcome:'failed',publication:'none',consumedBeforeKey:d})
 session.header={sessionId:owner,createdAt:'synthetic-fix2'} as typeof session.header
 const directory=await mkdtemp(join(tmpdir(),'ih-fix2-receipt-'));await writeFile(join(directory,owner+'.jsonl'),toJSONL(session))
 const backend=createJsonlBackend(directory),coordinator=createSessionCoordinator(backend,{lock:{enabled:true}}),document=await coordinator.openManagedDocument(owner),action=document.beginAction(),sources:SettlementFacts<ProducerFactOutcome>[]=[]
 const appendBatch=backend.appendOwnedBatch!;let issued=0,captures=0,transports=0,originalKey:BatchKey|undefined;const reconciled:BatchKey[]=[]
 backend.appendOwnedBatch=async(...args)=>{if(decodeFactBatch(args[3].bytes).events.some(e=>e.type==='compaction/replacement')){issued++;originalKey=args[3].key;await appendBatch(...args);action.stop();return{kind:'unknown',key:args[3].key}}return appendBatch(...args)}
 const model={prepare:prepareTextFixture,async *stream(){transports++;throw Error('summary data fixture cannot transport')}}
 const context=createAgentContext({session:document.view,model,tools:{schemas:()=>[]} as never,systemPrompt:'',compact:{contextWindow:20000,thresholdRatio:.8,targetRatio:.7,minTurnsBeforeRecompact:0,prune:false},maxOutputTokens:15500,
  summaryFactory:()=>async source=>({kind:'complete',text:checkpointOfLength(600),groupIds:source.groups.map(g=>g.id)}),facts:action.facts,assertFactOpen:action.assertOpen,
  captureSoftReduction:action.captureSoftReduction.bind(action),captureContextReduction:(draft,current)=>{captures++;const original=action.captureContextReduction!(draft,current);return{...original,async reconcile(){const outcome=await original.reconcile();if(outcome.kind==='committed')reconciled.push(outcome.receipt.key);return outcome}}},registerFactSource:drain=>{const source=action.registerSettlementSource(drain);sources.push(source);return source}},owner)
 try{
  expect(await context.compactor!.maybeCompact(document.view)).toMatchObject({publication:'recovery-required'})
  expect(createConversationValidationIndex(document.view.events,{formatVersion:9}).softReduction(owner)).toMatchObject({failures:1,pending:true})
  await Promise.allSettled(sources.map(s=>s.close()));expect((await Promise.allSettled(sources.map(s=>s.close()))).every(r=>r.status==='fulfilled')).toBe(true)
  expect(captures).toBe(1);expect(issued).toBe(1);expect(transports).toBe(0);expect(reconciled.length).toBeGreaterThan(0);expect(reconciled.every(key=>JSON.stringify(key)===JSON.stringify(originalKey))).toBe(true)
  const events=(await backend.read(owner)).events;expect(events.filter(e=>e.type==='compaction/replacement')).toHaveLength(1)
  expect(createConversationValidationIndex(events,{formatVersion:9}).softReduction(owner)).toMatchObject({failures:0,pending:false})
  const terminal=events.at(-1)!;expect(terminal).toMatchObject({type:'context/soft-reduction',outcome:'target-ready',seq:originalKey!.firstSeq+1})
 }finally{action.finish();await coordinator.close();vi.unstubAllGlobals()}
})
