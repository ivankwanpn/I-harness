import {expect,it,vi} from 'vitest'
import {mkdir,mkdtemp,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {append,deriveMessages,rewindCuts,type Session} from '@i-harness/core-session'
import {createSessionCoordinator,forkSession} from '@i-harness/session-persistence'
import {createJsonlBackend} from '@i-harness/session-persistence-jsonl'
import {createSessionAssembly,createDurableSessionLoader} from '@i-harness/session-executor'
import {createNativeContextRuntime} from '../src/context-runtime.ts'
import {createCompactionEngine} from '../../compaction/src/index.ts'
import type {LLMRequest,ModelClient} from '../../llm-seam/src/index.ts'

it.each(['off','only'] as const)('child %s captures own refs and recovers after compaction/reset/cold resume and fork',async mode=>{
  const base=resolve('build/native-child-recovery');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'child-'))
  const storage=join(root,'sessions')
  let coordinator=createSessionCoordinator(createJsonlBackend(storage));await coordinator.create({sessionId:'parent'})
  const makeRuntime=()=>createNativeContextRuntime({workspace:root,storageRoot:join(root,'native'),coordinator,projectFor:async()=>({}),visibleRefsFor:async id=>{
    const session=(await coordinator.snapshot!(id)).session,cuts=rewindCuts(session)
    return session.events.flatMap(event=>event.type==='context/result-ref'&&!cuts.some(cut=>event.seq!>=cut.cutFrom&&event.seq!<cut.markerSeq)?[event.ref]:[])
  }})
  let runtime=await makeRuntime();await runtime.contextOutput.configure({enabled:true})
  const requests:LLMRequest[]=[];let first=true,childSession:Session|undefined
  const model:ModelClient={async *stream(request){requests.push(structuredClone(request))
    if(first){first=false;yield{type:'tool_call',call:mode==='off'?{name:'fixture_long',args:{}}:{name:'code_exec',args:{code:'await tools.fixture_long({});text("c".repeat(20000)+"EMITTED_MARKER"+"d".repeat(20000));',max_output_tokens:16}}}}
    else yield{type:'text/chunk',text:'Child finished.'}
    yield{type:'end'}
  }}
  const summarizer:ModelClient={async *stream(){yield{type:'text/chunk',text:'The child completed its inspection. Native references are needed to continue.'};yield{type:'end'}}}
  const options={workspace:root,sessionId:'parent',model,sandbox:'danger-full-access' as const,approveAll:true,codeMode:{mode},additionalTools:[{name:'fixture_long',description:'long fixture',inputSchema:{type:'object'},isReadOnly:true,execute:async()=> 'a'.repeat(20000)+'DIRECT_MARKER'+'b'.repeat(20000)}],pluginAgents:[{name:'native-child',description:'native child',systemPrompt:'NATIVE_CHILD',tools:['fixture_long','context_output_read','context_output_search']}]}
  let assembly=await createSessionAssembly({...options,coordinator,contextOutput:runtime.contextOutput,contextOutputSourceFor:runtime.sourceFor})
  const observe=()=>assembly.ctx.on('agent/post-tool',payload=>{const event=payload as {name:string;session:Session};if(event.name==='fixture_long'||event.name==='code_exec')childSession=event.session})
  observe()
  try{
    const parentOnly=(await runtime.contextOutput.capture({sessionId:'parent',callId:'parent-only',label:'parent only',text:'parent private output',complete:true,source:await runtime.sourceFor('parent')}))!
    append(assembly.session,{type:'context/result-ref',ref:parentOnly})
    const spawned=await assembly.tools.execute({name:'spawn_agent',args:{message:'Capture long text',task_name:'native',agent_type:'native-child',fork_turns:'none',background:false}})
    const path=(spawned.output as {agent_path:string}).agent_path
    expect(childSession).toBeDefined()
    const refs=childSession!.events.flatMap(event=>event.type==='context/result-ref'?[event.ref]:[])
    expect(refs).toHaveLength(mode==='off'?1:2)
    const childId=refs[0]!.sessionId
    const assertRecovery=()=>{for(const ref of refs)expect(requests.at(-1)!.systemPrompt).toContain(ref.id);expect(requests.at(-1)!.systemPrompt).not.toContain(parentOnly.id)}
    assertRecovery()
    const followup=async(message:string)=>{
      const before=requests.length
      await assembly.tools.execute({name:'followup_task',args:{target:path,message}})
      await vi.waitFor(()=>expect(requests.length).toBeGreaterThan(before))
      await vi.waitFor(()=>expect(assembly.subagentState!().agentTable.find(entry=>entry.path===path)?.status).toBe('waiting'))
      assertRecovery()
    }
    const hidden=(await runtime.contextOutput.capture({sessionId:childId,callId:'hidden',label:'hidden',text:'hidden',complete:true,source:await runtime.sourceFor(childId)}))!
    append(childSession!,{type:'turn/start'});append(childSession!,{type:'user/message',text:'rewound turn'});const anchor=childSession!.events.at(-1)!
    append(childSession!,{type:'context/result-ref',ref:hidden});append(childSession!,{type:'turn/end'})
    append(childSession!,{type:'rewind/point',version:1,targetTurn:2,anchorSeq:anchor.seq!,mode:'all',fileOps:[]})
    const compactor=createCompactionEngine({model:summarizer,config:{contextWindow:100000,minSummaryChars:1}})
    expect((await compactor.compact(childSession!)).compacted).toBe(true)
    expect(JSON.stringify(deriveMessages(childSession!))).not.toContain(refs[0]!.id)
    await followup('continue after compaction');expect(requests.at(-1)!.systemPrompt).not.toContain(hidden.id)
    expect((await compactor.resetWindow(childSession!,1)).reset).toBe(true)
    await followup('continue after reset');expect(requests.at(-1)!.systemPrompt).not.toContain(hidden.id)
    const restoredState=assembly.subagentState!()
    await assembly.dispose();await runtime.close();await coordinator.close()
    coordinator=createSessionCoordinator(createJsonlBackend(storage));runtime=await makeRuntime();await runtime.contextOutput.configure({enabled:true})
    assembly=await createSessionAssembly({...options,coordinator,session:await createDurableSessionLoader(coordinator)('parent'),restoredState,contextOutput:runtime.contextOutput,contextOutputSourceFor:runtime.sourceFor});observe()
    await followup('continue after cold resume');expect(requests.at(-1)!.systemPrompt).not.toContain(hidden.id)
    await coordinator.flush(childId)
    const fork=await forkSession(coordinator,childId)
    const inherited=(await coordinator.snapshot!(fork.sessionId)).session.events.flatMap(event=>event.type==='context/result-ref'?[event.ref]:[])
    expect(inherited.map(ref=>ref.id)).toEqual(refs.map(ref=>ref.id))
    await runtime.inheritFork(childId,fork.sessionId,inherited)
    await runtime.contextOutput.clear('parent');await runtime.contextOutput.clear(childId)
    for(const query of ['DIRECT_MARKER',...(mode==='only'?['EMITTED_MARKER']:[])])expect((await runtime.contextOutput.search({sessionId:fork.sessionId},{query})).hits).toHaveLength(1)
  }finally{await assembly.dispose();await runtime.close();await coordinator.close();await rm(root,{recursive:true,force:true})}
},15000)
