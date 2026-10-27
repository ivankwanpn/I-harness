import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import {expect,it,vi} from 'vitest'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {committedFactSeqs,deriveMessages,managedResultRefs,type SessionView as Session} from '@i-harness/core-session'
import {recordFixture} from './managed-fixture.ts'
import {createMetadataRecorder} from './helpers/selected-results-metadata.ts'
import {createSessionCoordinator} from '@i-harness/session-persistence'
import {createJsonlBackend} from '@i-harness/session-persistence-jsonl'
import {createSessionAssembly,createDurableSessionLoader} from '@i-harness/session-executor'
import {createNativeConsumerOwners,dispatchOwned} from './helpers/native-consumer-fixture.ts'
import type {ManagedArtifactRef} from '@i-harness/core-session'
import type {ContextResultRef} from '@i-harness/context-output'
import {createCompactionHarness} from '../../compaction/test/fixtures/engine.ts'
import {prepareTextFixture,checkpointOfLength} from '../../compaction/test/fixtures/checkpoint.ts'
import type {LLMRequest,ModelClient} from '../../llm-seam/src/index.ts'

it.each(['off','only'] as const)('metadata-only child %s traces declared resources through compaction reset and cold',async mode=>{
  const recorder=await createMetadataRecorder(mode)
  const root=await mkdtemp(join(tmpdir(),'sr0-child-'))
  const storage=join(root,'sessions')
  let coordinator=createSessionCoordinator(createJsonlBackend(storage),{lock:{enabled:true}});await coordinator.create({sessionId:'parent'})
  let owners=await createNativeConsumerOwners(coordinator,root),runtime=owners.runtime;await runtime.contextOutput.configure({enabled:true})
  const direct='a'.repeat(40000)+'DIRECT_MARKER'+'b'.repeat(40000),emitted='c'.repeat(40000)+'EMITTED_MARKER'+'d'.repeat(40000)
  const legacy:ContextResultRef[]=[]
  const requests:LLMRequest[]=[];let first=true,childSession:Session|undefined,waits=0,effects=0,parentEffects=0
  const model:ModelClient=controlledModel(request => ({async *stream(request){requests.push(structuredClone(request))
    // A zero observation window makes the valid asynchronous return explicit.
    // Continue the same owned cell instead of assuming the first read settled.
    if(first){first=false;yield{type:'tool_call',call:mode==='off'?{name:'fixture_long',args:{}}:{name:'code_exec',args:{code:'await tools.fixture_long({});text("c".repeat(40000)+"EMITTED_MARKER"+"d".repeat(40000));',yield_time_ms:0,max_output_tokens:16}}}}
    else {
      const latest=[...request.messages].reverse().find(message=>message.role==='tool')
      const observation=mode==='only'&&typeof latest?.content==='string'?JSON.parse(latest.content) as {cell_id?:string;status?:string;error?:string}:undefined
      if(observation?.cell_id){
        expect(['running','completed'],observation.error).toContain(observation.status)
        if(observation.status==='running'){
          expect(++waits).toBeLessThanOrEqual(8)
          yield{type:'tool_call',call:{name:'code_wait',args:{cell_id:observation.cell_id,yield_time_ms:1000,max_tokens:16}}}
        }else yield{type:'text/chunk',text:'Child finished.'}
      }else yield{type:'text/chunk',text:'Child finished.'}
    }
    yield{type:'end'}
  }} as import('@i-harness/llm-seam').ModelClient).stream(request))
  const summarizer:ModelClient=controlledModel(request => ({prepare:prepareTextFixture,async *stream(){yield{type:'text/chunk',text:checkpointOfLength(600)};yield{type:'end'}}} as import('@i-harness/llm-seam').ModelClient).stream(request))
  const options={workspace:root,sessionId:'parent',model,sandbox:'danger-full-access' as const,approveAll:true,codeMode:{mode},additionalTools:[{name:'fixture_parent_only',description:'parent only',inputSchema:{type:'object'},isReadOnly:true,execute:async()=>{parentEffects++;return 'parent private effect'}},{name:'fixture_long',description:'long fixture',inputSchema:{type:'object'},isReadOnly:true,execute:async(_args:unknown,exec:import('../../core-tools/src/index.ts').ToolExec)=>{
    effects++;if(!exec.sessionId||exec.sessionId==='parent')throw new Error('Fixture must execute in the actual child')
    const ref=await runtime.contextOutput.capture({sessionId:exec.sessionId,callId:exec.callId!,label:'explicit legacy direct compatibility',text:direct,complete:true,source:await runtime.sourceFor(exec.sessionId)})
    if(!ref)throw new Error('Explicit legacy direct capture refused')
    legacy.push(ref);await recordFixture(await coordinator.openManagedDocument(exec.sessionId),{type:'context/result-ref',ref});return direct
  }}],pluginAgents:[{name:'native-child',description:'native child',systemPrompt:'NATIVE_CHILD',tools:['fixture_long','context_output_read','context_output_search']}]}
  let assembly=await createSessionAssembly({...options,coordinator,contextOutput:runtime.contextOutput,contextOutputSourceFor:runtime.sourceFor,contextOutputLegacyReadObservation:runtime.withLegacyReadObservation})
  const observe=()=>assembly.ctx.on('agent/post-tool',async payload=>{
    const event=payload as {name:string;session:Session;output?:{status?:string}}
    if(event.name==='fixture_long'||event.name==='code_exec'||event.name==='code_wait')childSession=event.session
    if(event.name==='code_wait'&&event.output?.status==='completed'&&legacy.length===1){
      const childId=legacy[0]!.sessionId
      const ref=await runtime.contextOutput.capture({sessionId:childId,callId:(event.session.events.findLast(fact=>fact.type==='tool/result'&&fact.name==='code_wait') as Extract<import('@i-harness/core-session').SessionEventView,{type:'tool/result'}>).callId,label:'explicit legacy emitted compatibility',text:emitted,complete:true,source:await runtime.sourceFor(childId)})
      if(!ref)throw new Error('Explicit legacy emitted capture refused')
      legacy.push(ref);await recordFixture(await coordinator.openManagedDocument(childId),{type:'context/result-ref',ref})
    }
  })
  observe()
  try{
    const parentOnly=(await runtime.contextOutput.capture({sessionId:'parent',callId:'parent-only',label:'parent only',text:'parent private output',complete:true,source:await runtime.sourceFor('parent')}))!
    await recordFixture(assembly.factOwner,{type:'context/result-ref',ref:parentOnly})
    const spawned=await dispatchOwned(assembly,'spawn_agent',{message:'Capture long text',task_name:'native',agent_type:'native-child',fork_turns:'none',background:false}) as unknown as {agent_path:string;task_id:string;result_revision:string;result_ref:ManagedArtifactRef}
    const path=spawned.agent_path
    const assertTaskBody=async(phase:string)=>{
      const document=await coordinator.getDocument('task-parent') as import('../../subagent/src/task/types.ts').TaskProtocolDocument|undefined
      const row=document?.tasks.find(task=>task.id===spawned.task_id)
      const originalCall=assembly.session.events.find(event=>event.type==='tool/call'&&event.name==='spawn_agent')
      if(originalCall?.type!=='tool/call')throw new Error('Original parent spawn call missing')
      expect(row).toMatchObject({toolCallId:originalCall.callId,callEventSeq:originalCall.seq,childSessionId:legacy[0]!.sessionId,outcome:'completed',result:{kind:'retained',revision:spawned.result_revision,envelope:{retention:{kind:'artifact',ref:spawned.result_ref}}}})
      const end=assembly.session.events.find(event=>event.type==='subagent/end'&&event.taskId===spawned.task_id)
      expect(end).toMatchObject({outcome:'completed',resultRevision:spawned.result_revision,envelope:{retention:{kind:'artifact',ref:spawned.result_ref}}})
      let offset=0,encoded=''
      for(;;){
        const page=await dispatchOwned(assembly,'get_task_output',{task_ids:[spawned.task_id],body:true,result_revision:spawned.result_revision,ref_revision:spawned.result_ref.revision,ref_id:spawned.result_ref.id,offset_bytes:offset,max_output_bytes:2048}) as unknown as import('../../subagent/src/task/result.ts').TaskResultPage
        expect(page).toMatchObject({resultRevision:spawned.result_revision,ref:spawned.result_ref,offset})
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(2048)
        encoded+=page.data.text
        if(page.eof)break
        expect(page.nextOffset).toBeGreaterThan(offset);offset=page.nextOffset!
      }
      expect(encoded).toBe(JSON.stringify({resultText:'Child finished.'}))
      console.info(JSON.stringify({fixture:'c67-task-body',mode,phase,taskId:spawned.task_id,callId:row!.toolCallId,callEventSeq:row!.callEventSeq,result:row!.result,bytes:Buffer.byteLength(encoded)}))
    }
    await assertTaskBody('initial')
    expect(childSession).toBeDefined()
    const refs=childSession!.events.flatMap(event=>event.type==='context/result-ref'?[event.ref]:[])
    const observed=childSession!.events.filter(event=>event.type==='tool/result'&&event.name==='code_exec')
    expect(refs).toHaveLength(mode==='off'?1:2)
    expect(effects).toBe(1);expect(parentEffects).toBe(0)
    if(mode==='only'){
      expect(observed).toMatchObject([{envelope:{retention:{kind:'inline',value:{status:'running'}}}}])
      const calls=childSession!.events.filter(event=>event.type==='tool/call'&&event.name==='code_exec')
      expect(calls).toHaveLength(1)
      const call=calls[0];if(call?.type!=='tool/call')throw new Error('Missing code execution call')
      expect(childSession!.events.filter(event=>event.type==='tool/dispatch'&&event.callId===call.callId)).toHaveLength(1)
      const completed=childSession!.events.filter(event=>event.type==='tool/result'&&event.name==='code_wait')
      expect(completed.at(-1)).toMatchObject({envelope:{retention:{kind:'inline',value:{status:'completed'}}}})
      expect(waits).toBeGreaterThan(0);expect(waits).toBeLessThanOrEqual(8)
    }
    const childId=refs[0]!.sessionId
    expect(requests.every(request=>request.systemPrompt?.includes('NATIVE_CHILD'))).toBe(true)
    expect(requests.every(request=>!request.tools?.some(tool=>tool.name==='fixture_parent_only'||tool.name==='spawn_agent'))).toBe(true)
    expect(assembly.session.events.filter(event=>event.type==='tool/call'&&event.name==='fixture_long')).toHaveLength(0)
    await runtime.withLegacyReadObservation({sessionId:childId},read=>expect(runtime.contextOutput.readLegacyObserved({sessionId:childId},{refId:parentOnly.id},read)).rejects.toThrow())
    const bodyEvents=childSession!.events.filter(event=>event.type==='tool/result'&&event.name==='fixture_long'||event.type==='code/result'&&event.name==='fixture_long'||event.type==='code/output')
    expect(bodyEvents).toHaveLength(mode==='off'?1:2)
    const bodies=bodyEvents.map(event=>{
      const found=managedResultRefs(event);expect(found).toHaveLength(1)
      return {label:event.type==='code/output'?'emitted':'direct',ref:found[0]!,expected:event.type==='code/output'?emitted:direct}
    })
    const assertLegacy=async(id:string,phase:string)=>{
      await runtime.withLegacyReadObservation({sessionId:id},async read=>{
        await recorder.record(runtime.observations.current(id),phase)
        for(const [index,ref] of refs.entries()){
          let offset=0,text=''
          for(;;){
            const page=await runtime.contextOutput.readLegacyObserved({sessionId:id},{refId:ref.id,offset,maxBytes:8192},read)
            text+=page.text
            if(page.eof)break
            expect(page.nextOffset).toBeGreaterThan(offset);offset=page.nextOffset!
          }
          expect(text).toBe(index===0?direct:emitted)
          console.info(JSON.stringify({fixture:'c67-legacy-bytes',mode,phase,id,refId:ref.id,bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')}))
        }
      })
    }
    const assertBodies=async(id:string,phase:string)=>{
      await assertLegacy(id,phase)
      for(const body of bodies){
        let offset=0,encoded='',pages=0
        for(;;){
          const page=await runtime.contextOutput.readResult({sessionId:id},{ref:body.ref,offset,maxBytes:8192})
          expect(page.ref).toEqual(body.ref);expect(page.offset).toBe(offset);expect(page.data.kind).toBe('text')
          if(page.data.kind!=='text')throw new Error('Actual JSON text page required')
          expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(8192)
          encoded+=page.data.text;pages++
          if(page.eof){expect(page.nextOffset).toBeNull();break}
          expect(page.nextOffset).toBeGreaterThan(offset);offset=page.nextOffset!
        }
        expect(pages).toBeGreaterThan(1);expect(body.ref.completeness).toBe('complete')
        expect(Buffer.byteLength(encoded)).toBe(body.ref.encodedBytes);expect(JSON.parse(encoded)).toBe(body.expected)
        expect(createHash('sha256').update(encoded).digest('hex')).toBe(body.ref.contentDigest)
        console.info(JSON.stringify({fixture:'c67-managed-bytes',mode,phase,id,label:body.label,ref:body.ref,pages,bytes:Buffer.byteLength(encoded)}))
      }
    }
    const assertRecovery=()=>{
      const input=requests.at(-1)!
      for(const ref of refs)expect(input.systemPrompt).toContain(ref.id)
      expect(input.systemPrompt).not.toContain(parentOnly.id)
      const encoded=JSON.stringify(input)
      const toolInput=JSON.stringify(input.messages.filter(message=>message.role==='tool'))
      expect(toolInput).not.toContain('DIRECT_MARKER');expect(toolInput).not.toContain('EMITTED_MARKER')
      expect(encoded).not.toContain(direct);expect(encoded).not.toContain(emitted)
      expect(Buffer.byteLength(encoded)).toBeLessThan(60000)
      console.info(JSON.stringify({fixture:'c67-model-input',mode,childId,bytes:Buffer.byteLength(encoded),sha256:createHash('sha256').update(encoded).digest('hex'),ownRefs:refs.map(ref=>ref.id),parentPrivate:parentOnly.id}))
    }
    await assertBodies(childId,'initial')
    assertRecovery()
    const followup=async(message:string)=>{
      const before=requests.length
      const followed=await dispatchOwned(assembly,'followup_task',{target:path,message})
      expect(followed).toEqual({delivered:true})
      await vi.waitFor(()=>{
        expect(assembly.subagentState!().agentTable.find(entry=>entry.path===path)?.error).toBeUndefined()
        expect(requests.length).toBeGreaterThan(before)
      })
      await vi.waitFor(()=>expect(assembly.subagentState!().agentTable.find(entry=>entry.path===path)?.status).toBe('waiting'))
      assertRecovery()
    }
    const hidden=(await runtime.contextOutput.capture({sessionId:childId,callId:'hidden',label:'hidden',text:'hidden',complete:true,source:await runtime.sourceFor(childId)}))!
    const childOwner=await coordinator.openManagedDocument(childId),compactionAction=childOwner.beginAction()
    const [anchor]=committedFactSeqs(await compactionAction.facts.agent.lifecycle({type:'turn/start'}))
    await recordFixture(childOwner,{type:'user/message',text:'rewound turn'})
    await recordFixture(childOwner,{type:'context/result-ref',ref:hidden});await recordFixture(childOwner,{type:'turn/end'})
    await recordFixture(childOwner,{type:'rewind/point',version:1,targetTurn:2,anchorSeq:anchor!,mode:'all',fileOps:[]})
    const compactor=createCompactionHarness({model:summarizer,factOwner:childOwner,config:{contextWindow:100000,minSummaryChars:1,prune:false}})
    expect((await compactor.compact(childSession!)).compacted).toBe(true)
    expect(JSON.stringify(deriveMessages(childSession!))).not.toContain(refs[0]!.id)
    await followup('continue after compaction');await assertBodies(childId,'compaction');expect(requests.at(-1)!.systemPrompt).not.toContain(hidden.id)
    expect((await compactor.resetWindow(childSession!,1)).reset).toBe(true)
    await followup('continue after reset');await assertBodies(childId,'reset');expect(requests.at(-1)!.systemPrompt).not.toContain(hidden.id);compactionAction.finish()
    const restoredState=assembly.subagentState!()
    await assembly.dispose();await owners.close();await coordinator.close()
    coordinator=createSessionCoordinator(createJsonlBackend(storage),{lock:{enabled:true}});owners=await createNativeConsumerOwners(coordinator,root);runtime=owners.runtime;await runtime.contextOutput.configure({enabled:true})
    assembly=await createSessionAssembly({...options,coordinator,session:await createDurableSessionLoader(coordinator)('parent'),restoredState,contextOutput:runtime.contextOutput,contextOutputSourceFor:runtime.sourceFor,contextOutputLegacyReadObservation:runtime.withLegacyReadObservation});observe()
    await followup('continue after cold resume');await assertBodies(childId,'cold');await assertTaskBody('cold');expect(requests.at(-1)!.systemPrompt).not.toContain(hidden.id)
    await coordinator.flush(childId)
    // The original consumer remains unchanged and RED at this original fork.
    // This diagnostic records the actual refusal, without claiming READY or
    // replacing any original downstream positive oracle.
    await expect(owners.fork(childId)).rejects.toThrow('Shipping fork did not reach READY')
    expect(effects).toBe(1)
  }finally{await assembly.dispose();await owners.close();await coordinator.close();await rm(root,{recursive:true,force:true});console.info(JSON.stringify({diagnostic:'selected-results-cleanup',mode,root,assemblyDisposeReturned:true,ownersCloseReturned:true,coordinatorCloseReturned:true,removeReturned:true}))}
},15000)

