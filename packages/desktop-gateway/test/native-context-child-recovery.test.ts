import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import {expect,it,vi} from 'vitest'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {PassThrough,Writable} from 'node:stream'
import {committedFactSeqs,deriveMessages,managedResultRefs,semanticSeedResultRefs,createLegacyRetentionSelection,type SessionView as Session} from '@i-harness/core-session'
import {recordFixture} from './managed-fixture.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createJsonlBackend} from '@i-harness/session-persistence-jsonl'
import {createSessionAssembly,createDurableSessionLoader} from '@i-harness/session-executor'
import {createNativeConsumerOwners,dispatchOwned} from './helpers/native-consumer-fixture.ts'
import {selectSeedHistory} from '../../core-session/src/conversation/seed-selection.ts'
import type {ManagedArtifactRef} from '@i-harness/core-session'
import type {ContextResultRef} from '@i-harness/context-output'
import {createCompactionHarness} from '../../compaction/test/fixtures/engine.ts'
import {prepareTextFixture,checkpointOfLength} from '../../compaction/test/fixtures/checkpoint.ts'
import type {LLMRequest,ModelClient} from '../../llm-seam/src/index.ts'
import {HarnessClient,encodeFrame} from '@i-harness/sdk'
import type {SessionCoordinator} from '@i-harness/session-persistence'
import {createDesktopHost} from '../src/host.ts'
import type {createNativeContextRuntime} from '../src/context-runtime.ts'

type NativeRuntime = Awaited<ReturnType<typeof createNativeContextRuntime>>
const observedHost = vi.hoisted(() => ({
  capture: undefined as ((coordinator: SessionCoordinator, runtime: NativeRuntime) => void) | undefined,
}))

vi.mock('../src/context-runtime.ts', async original => {
  const actual = await original<typeof import('../src/context-runtime.ts')>()
  return {
    ...actual,
    async createNativeContextRuntime(options: Parameters<typeof createNativeContextRuntime>[0]) {
      const runtime = await actual.createNativeContextRuntime(options)
      observedHost.capture?.(options.coordinator as SessionCoordinator, runtime)
      return runtime
    },
  }
})

async function openPublicHost(root: string, storage: string, project: { id: string; name: string; roots: string[]; primaryRoot: string }) {
  const settingsPath = join(root, 'settings.json')
  const credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({
    autoTitle: false, contextSubsystems: { contextOutput: { enabled: true } },
    compaction: { auto: false }, sandboxMode: 'read-only', codeMode: { mode: 'off' },
    llm: {
      providers: { fixture: { protocol: 'openai-completions', baseURL: 'http://127.0.0.1:1',
        apiKeyEnv: 'IH_C67_FIXTURE_KEY', models: [{ id: 'fixture', contextWindow: 32000 }] } },
      defaultModel: { provider: 'fixture', model: 'fixture' },
    },
  }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_C67_FIXTURE_KEY: 'controlled' } }))
  const replies = new PassThrough()
  let original: { coordinator: SessionCoordinator; runtime: NativeRuntime } | undefined
  observedHost.capture = (coordinator, runtime) => { original = { coordinator, runtime } }
  const host = await createDesktopHost({
    workspace: root, sessionDir: storage, settingsPath, credentialsPath, sessionStore: 'jsonl',
    onWrite: frame => { replies.write(encodeFrame(frame)) },
    buildProviderClient: () => controlledModel(request => (async function* () {
      const last = request.messages.at(-1)
      const previous = request.messages.findLast(message => message.role === 'assistant' && message.toolCalls?.length)
      const previousTool = previous?.role === 'assistant' ? previous.toolCalls?.at(-1)?.name : undefined
      if (last?.role === 'tool' && previousTool === 'context_output_read') {
        yield { type: 'text/chunk', text: 'Retained output read.' }
      } else if (last?.role === 'tool' && previousTool === 'context_output_search') {
        if (typeof last.content !== 'string') throw Error('Expected the original retained search reply')
        const search = JSON.parse(last.content) as { hits?: { ref: { id: string }; offset: number }[] }
        const hit = search.hits?.[0]
        if (!hit) throw Error('The public search returned no retained result: ' + last.content)
        yield { type: 'tool_call', call: { name: 'context_output_read', args: { refId: hit.ref.id, offset: hit.offset, maxBytes: 1024 } } }
      } else if (request.tools?.some(tool => tool.name === 'context_output_search')) {
        yield { type: 'tool_call', call: { name: 'context_output_search', args: { query: 'MARKER', limit: 4, maxBytes: 8192 } } }
      } else if (last?.role === 'tool') {
        throw Error('The search tool was not discoverable in the original target')
      } else {
        yield { type: 'tool_call', call: { name: 'tool_search', args: { query: 'context_output_search' } } }
      }
      yield { type: 'end' }
    })()),
  }).finally(() => { observedHost.capture = undefined })
  const input = new Writable({
    write(line, _encoding, done) {
      void host.handleLine(line.toString()).then(() => done(), cause => done(cause))
    },
  })
  const client = new HarnessClient(replies, input)
  const close = async () => {
    try { await client.close() }
    finally { await host.close(); replies.end() }
  }
  try {
    if (!original) throw Error('The live host did not construct its native context')
    const info = await client.initialize()
    expect(info.capabilities['session-fork-selected-results']).toEqual(['1'])
    await client.request('desktop/project/sync', { projects: [project] })
    return { client, ...original, close }
  } catch (cause) {
    await close()
    throw cause
  }
}

// Public C67 also runs target tool calls, paged SDK reads and a fresh Gateway.
// The normal case took 158s, and Code Mode reached the cold host at the old 180s limit.
for (const mode of ['off', 'only'] as const) it(
  `child ${mode} captures own refs and recovers after compaction/reset/cold resume and fork`, async () => {
  const root=await mkdtemp(join(tmpdir(),'c67-child-'))
  const storage=join(root,'sessions')
  const project={id:'native-consumer',name:'Native consumer',roots:[root],primaryRoot:root}
  let coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(storage),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'parent'})
  const nativeRoot = join(storage, 'native-context')
  let owners=await createNativeConsumerOwners(coordinator,root,project,nativeRoot),runtime=owners.runtime;await runtime.contextOutput.configure({enabled:true})
  await owners.projects.bind('parent',project.id)
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
  let assembly=await createSessionAssembly({...options,prepareTaskChild:runtime.prepareTaskChild,coordinator,contextOutput:runtime.contextOutput,contextOutputSourceFor:runtime.sourceFor,contextOutputLegacyReadObservation:runtime.withLegacyReadObservation})
  let fixtureOpen = true
  const closeFixture = async () => {
    await assembly.dispose()
    await owners.close()
    await coordinator.close()
    fixtureOpen = false
  }
  let publicHost: Awaited<ReturnType<typeof openPublicHost>> | undefined
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
    console.info(JSON.stringify({fixture:'c67-real-spawn',mode,spawned,childId:legacy[0]?.sessionId,childEvents:childSession?.events.map(event=>({type:event.type,seq:event.seq,...('callId' in event?{callId:event.callId}:{}),...('cellId' in event?{cellId:event.cellId}:{}),refs:managedResultRefs(event)}))}))
    expect(childSession).toBeDefined()
    const refs=childSession!.events.flatMap(event=>event.type==='context/result-ref'?[event.ref]:[])
    const observed=childSession!.events.filter(event=>event.type==='tool/result'&&event.name==='code_exec')
    expect(refs,JSON.stringify(observed)).toHaveLength(mode==='off'?1:2)
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
        for(const [index,ref] of refs.entries()){
          let offset=0,text=''
          for(;;){
            const page=await runtime.contextOutput.readLegacyObserved({sessionId:id},{refId:ref.id,offset,maxBytes:8192},read)
            text+=page.text
            if(page.eof)break
            expect(page.nextOffset).toBeGreaterThan(offset);offset=page.nextOffset!
          }
          expect(text).toBe(index===0?direct:emitted)
          const hits=await runtime.contextOutput.searchLegacyObserved({sessionId:id},{query:index===0?'DIRECT_MARKER':'EMITTED_MARKER',refIds:[ref.id]},read)
          expect(hits.hits.map(hit=>hit.ref.id)).toEqual([ref.id])
          console.info(JSON.stringify({fixture:'c67-legacy-bytes',mode,phase,id,refId:ref.id,bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')}))
        }
      })
    }
    const assertBodies=async(id:string,phase:string)=>{
      await assertLegacy(id,phase)
      for(const body of bodies){
        let offset=0,encoded='',pages=0
        for(;;){
          const query = { ref: body.ref, offset, maxBytes: 8192 }
          const page = publicHost ? await publicHost.client.readResultPage(id, query) : await runtime.contextOutput.readResult({ sessionId: id }, query)
          if (!('ref' in page) || !('offset' in page)) throw Error('Managed result page unavailable: ' + JSON.stringify(page))
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
    await closeFixture()
    coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(storage),{lock:{enabled:true}},taskDocumentStorageContract);owners=await createNativeConsumerOwners(coordinator,root,project,nativeRoot);runtime=owners.runtime;await runtime.contextOutput.configure({enabled:true})
    fixtureOpen = true
    assembly=await createSessionAssembly({...options,prepareTaskChild:runtime.prepareTaskChild,coordinator,session:await createDurableSessionLoader(coordinator)('parent'),restoredState,contextOutput:runtime.contextOutput,contextOutputSourceFor:runtime.sourceFor,contextOutputLegacyReadObservation:runtime.withLegacyReadObservation});observe()
    await followup('continue after cold resume');await assertBodies(childId,'cold');await assertTaskBody('cold');expect(requests.at(-1)!.systemPrompt).not.toContain(hidden.id)
    await coordinator.flush(childId)
    const selectedView=(await coordinator.openManagedDocument(childId)).view,selectedHistory=selectSeedHistory(selectedView,{kind:'completed'})
    console.info(JSON.stringify({fixture:'c67-selected-history',mode,history:selectedHistory.kind==='selected'?{kind:selectedHistory.kind,turns:selectedHistory.turns,groups:selectedHistory.groups.map(group=>({extent:group.extent,calls:group.items.flatMap(item=>item.calls.map(call=>call.callId))}))}:selectedHistory,refs:refs.map(ref=>({id:ref.id,callId:ref.callId})),lifecycle:selectedView.events.flatMap(event=>['turn/start','turn/end','compaction/summary','compaction/reset','rewind/point'].includes(event.type)?[event]:[])}))
    const selection=createLegacyRetentionSelection((await coordinator.openManagedDocument(childId)).view,{kind:'completed'})
    console.info(JSON.stringify({fixture:'c67-legacy-selection',mode,selection:selection.kind==='selected'?{kind:selection.kind,totalTurns:selection.totalTurns,local:[...selection.local()]}:selection}))
    expect(selection).toMatchObject({kind:'refused',reason:'legacy-anchor-unsupported'})
    await closeFixture()
    publicHost = await openPublicHost(root, storage, project)
    coordinator = publicHost.coordinator
    runtime = publicHost.runtime
    const prepared = await publicHost.client.prepareSelectedResultsFork({ version: 2, sourceSessionId: childId, results: 'selected-results-v1' })
    if (prepared.kind !== 'prepared') throw Error('Public selected fork preparation refused: ' + prepared.reason)
    const attempt = publicHost.client.createSelectedResultsForkAttempt(prepared.prepared)
    const fork = await attempt.run()
    if (fork.kind !== 'ready') throw Error('Public selected fork did not reach READY: ' + JSON.stringify(fork))
    const target=(await coordinator.snapshot!(fork.sessionId)).session
    expect(target.events[0]).toMatchObject({type:'conversation/seed-manifest',version:3})
    expect(semanticSeedResultRefs(target).map(ref=>ref.id).sort()).toEqual(bodies.map(body=>body.ref.id).sort())
    const assertPublicDiscovery = async () => {
      if (!publicHost) throw Error('Original public host is unavailable')
      const turn = await publicHost.client.run({ sessionId: fork.sessionId, prompt: 'Find the retained output containing MARKER.' })
      const result = turn.events.findLast(event => event.type === 'tool/result' && event.name === 'context_output_search')
      if (result?.type !== 'tool/result' || result.envelope?.retention.kind !== 'inline')
        throw Error('Missing public context search result: ' + JSON.stringify(turn.events.filter(event => event.type === 'tool/result')))
      expect(result.envelope.execution.outcome).toBe('succeeded')
      const search = result.envelope.retention.value as { hits: { ref: { id: string } }[] }
      expect(search.hits.map(hit => hit.ref.id).sort()).toEqual(refs.map(ref => ref.id).sort())
      const read = turn.events.findLast(event => event.type === 'tool/result' && event.name === 'context_output_read')
      if (read?.type !== 'tool/result' || read.envelope?.retention.kind !== 'inline')
        throw Error('Missing original legacy read result')
      expect(read.envelope.execution.outcome).toBe('succeeded')
      expect(read.envelope.retention.value).toMatchObject({
        ref: expect.objectContaining({ id: search.hits[0]!.ref.id }), text: expect.stringContaining('MARKER'),
      })
    }
    const assertInherited=async(phase:string)=>{
      await assertBodies(fork.sessionId,phase)
      await runtime.withLegacyReadObservation({sessionId:fork.sessionId},async read=>{
        const hits=(await runtime.contextOutput.searchLegacyObserved({sessionId:fork.sessionId},{query:'MARKER'},read)).hits
        expect(hits.map(hit=>hit.ref.id).sort()).toEqual(refs.map(ref=>ref.id).sort())
        for(const query of ['DIRECT_MARKER',...(mode==='only'?['EMITTED_MARKER']:[])])expect((await runtime.contextOutput.searchLegacyObserved({sessionId:fork.sessionId},{query},read)).hits).toHaveLength(1)
        for(const ref of [parentOnly,hidden]){
          await expect(runtime.contextOutput.readLegacyObserved({sessionId:fork.sessionId},{refId:ref.id},read)).rejects.toThrow()
          expect((await runtime.contextOutput.searchLegacyObserved({sessionId:fork.sessionId},{query:ref===hidden?'hidden':'parent private output',refIds:[ref.id]},read)).hits).toHaveLength(0)
        }
      })
    }
    await assertPublicDiscovery()
    await assertInherited('fork')
    const future=(await runtime.contextOutput.capture({sessionId:childId,callId:'future',label:'post-selection',text:'FUTURE_MARKER',complete:true,source:await runtime.sourceFor(childId)}))!
    const sourceOwner=await coordinator.openManagedDocument(childId)
    await recordFixture(sourceOwner,{type:'turn/start'});await recordFixture(sourceOwner,{type:'context/result-ref',ref:future});await recordFixture(sourceOwner,{type:'turn/end'})
    await runtime.withLegacyReadObservation({sessionId:fork.sessionId},async read=>{
      await expect(runtime.contextOutput.readLegacyObserved({sessionId:fork.sessionId},{refId:future.id},read)).rejects.toThrow()
      expect((await runtime.contextOutput.searchLegacyObserved({sessionId:fork.sessionId},{query:'FUTURE_MARKER'},read)).hits).toHaveLength(0)
    })
    await publicHost.client.request('desktop/context-subsystems/configure', { patch: { scope: 'global', contextOutput: { enabled: false } } })
    for (const id of ['parent', childId]) {
      await publicHost.client.request('desktop/context-subsystems/action', { command: { target: 'context', action: 'clear', sessionId: id } })
    }
    await runtime.withLegacyReadObservation({sessionId:fork.sessionId},read=>expect(runtime.contextOutput.readLegacyObserved({sessionId:fork.sessionId},{refId:refs[0]!.id},read)).rejects.toThrow(/disabled/))
    await publicHost.client.request('desktop/context-subsystems/configure', { patch: { scope: 'global', contextOutput: { enabled: true } } })
    await assertInherited('source-clear')
    await publicHost.close()
    publicHost = await openPublicHost(root, storage, project)
    coordinator = publicHost.coordinator
    runtime = publicHost.runtime
    const adopted = await publicHost.client.executeSelectedResultsFork({ operation: attempt.operation, mode: 'retry' })
    expect(adopted).toMatchObject({ kind: 'adopted', receipt: fork.receipt })
    await assertPublicDiscovery()
    await publicHost.client.request('desktop/context-subsystems/configure', { patch: { scope: 'global', contextOutput: { enabled: false } } })
    await runtime.withLegacyReadObservation({sessionId:fork.sessionId},read=>expect(runtime.contextOutput.readLegacyObserved({sessionId:fork.sessionId},{refId:refs[0]!.id},read)).rejects.toThrow(/disabled/))
    await publicHost.client.request('desktop/context-subsystems/configure', { patch: { scope: 'global', contextOutput: { enabled: true } } })
    await assertInherited('target-cold')
    expect(effects).toBe(1)
  }finally{
    if (publicHost) await publicHost.close()
    if (fixtureOpen) await closeFixture()
    await rm(root,{recursive:true,force:true})
  }
}, mode === 'off' ? 240_000 : 300_000)
