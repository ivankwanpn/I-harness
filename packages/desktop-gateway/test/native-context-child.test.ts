import {expect,it} from 'vitest'
import {mkdir,mkdtemp,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createSessionCoordinator} from '@i-harness/session-persistence'
import {createJsonlBackend} from '@i-harness/session-persistence-jsonl'
import {createSessionService,createDurableSessionLoader} from '@i-harness/session-executor'
import {createCodeRetrievalTools} from '@i-harness/code-retrieval'
import {createNativeContextRuntime} from '../src/context-runtime.ts'
import type {LLMRequest,ModelClient} from '../../llm-seam/src/index.ts'
import {append} from '@i-harness/core-session'

it('live enabling lets a real explore child capture and search native refs through its role-limited broker',async()=>{
  const base=resolve('build/native-child-tests');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'child-'))
  const coordinator=createSessionCoordinator(createJsonlBackend(join(root,'sessions')));await coordinator.create({sessionId:'parent'})
  let service:ReturnType<typeof createSessionService>|undefined
  const runtime=await createNativeContextRuntime({workspace:root,storageRoot:join(root,'native'),coordinator,projectFor:async()=>undefined,
    visibleRefsFor:async id=>(service?.liveSession(id)??(await coordinator.snapshot!(id)).session).events.flatMap(event=>event.type==='context/result-ref'?[event.ref]:[])})
  let calls=0;const requests:LLMRequest[]=[]
  const model:ModelClient={async *stream(request){requests.push(request);calls++
    if(calls===1)yield{type:'tool_call',call:{name:'code_exec',args:{code:'text(ALL_TOOLS.map(t=>t.name));text("a".repeat(20000)+"CHILD_RETAINED"+"b".repeat(20000));',max_output_tokens:16}}}
    else if(calls===2)yield{type:'tool_call',call:{name:'code_exec',args:{code:'const found=await tools.context_output_search({query:"CHILD_RETAINED"});text(await tools.context_output_read({refId:found.hits[0].ref.id,offset:found.hits[0].offset,maxBytes:1024}));'}}}
    else yield{type:'text/chunk',text:'Child finished.'}
    yield{type:'end'}
  }}
  service=createSessionService({workspace:root,coordinator,sessionFor:createDurableSessionLoader(coordinator),model,sandbox:'danger-full-access',approveAll:true,codeMode:{mode:'only'},contextOutput:runtime.contextOutput,contextOutputSourceFor:runtime.sourceFor,additionalTools:createCodeRetrievalTools(runtime.codeRetrieval)})
  try {
    const assembly=await service.assemblyFor('parent')
    await runtime.contextOutput.configure({enabled:true})
    const result=await assembly.tools.dispatch(await assembly.tools.prepare({name:'spawn_agent',args:{message:'Inspect native text',task_name:'native',agent_type:'explore',fork_turns:'none',background:false}},undefined,{sessionId:'parent',callId:'spawn'}))
    expect(JSON.stringify(result)).toContain('Child finished.')
    expect(requests).toHaveLength(3)
    const profiles=await Promise.all((await coordinator.list()).map(id=>coordinator.profile(id)));const child=profiles.find(profile=>profile.meta.parentSession==='parent')!.meta
    expect(child).toBeDefined()
    const childSession=(await coordinator.snapshot!(child.sessionId)).session
    const catalog=JSON.stringify(childSession.events.find(event=>event.type==='code/output'))
    expect(catalog).toContain('context_output_read');expect(catalog).not.toContain('code_context_index')
    const refs=childSession.events.flatMap(event=>event.type==='context/result-ref'?[event.ref]:[])
    expect(refs).toHaveLength(1)
    expect(JSON.stringify(childSession.events.filter(event=>event.type==='code/result'&&event.name==='context_output_read'))).toContain('CHILD_RETAINED')
    expect((await runtime.contextOutput.search({sessionId:'parent'},{query:'CHILD_RETAINED'})).hits[0]!.ref.id).toBe(refs[0]!.id)
    await runtime.contextOutput.clear(child.sessionId)
    expect((await runtime.contextOutput.search({sessionId:'parent'},{query:'CHILD_RETAINED'})).hits).toHaveLength(1)
  } finally {await service.close();await runtime.close();await coordinator.close();await rm(root,{recursive:true,force:true})}
},15000)

it.each([false,true])('a real child owns its inherited native references before its first model request (disabled=%s)',async disabled=>{
  const base=resolve('build/native-child-tests');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'seed-'))
  const coordinator=createSessionCoordinator(createJsonlBackend(join(root,'sessions')));await coordinator.create({sessionId:'parent'})
  let service:ReturnType<typeof createSessionService>|undefined
  const runtime=await createNativeContextRuntime({workspace:root,storageRoot:join(root,'native'),coordinator,projectFor:async()=>undefined,
    visibleRefsFor:async id=>(service?.liveSession(id)??(await coordinator.snapshot!(id)).session).events.flatMap(event=>event.type==='context/result-ref'?[event.ref]:[])})
  let calls=0,refId=''
  const model:ModelClient={async *stream(){calls++
    if(calls===1){await runtime.contextOutput.clear('parent');await runtime.contextOutput.configure({enabled:true});yield{type:'tool_call',call:{name:'context_output_read',args:{refId}}}}
    else yield{type:'text/chunk',text:'Seed read completed.'}
    yield{type:'end'}
  }}
  service=createSessionService({workspace:root,coordinator,sessionFor:createDurableSessionLoader(coordinator),model,sandbox:'danger-full-access',approveAll:true,contextOutput:runtime.contextOutput,contextOutputSourceFor:runtime.sourceFor,additionalTools:createCodeRetrievalTools(runtime.codeRetrieval)})
  try{
    await runtime.contextOutput.configure({enabled:true})
    const assembly=await service.assemblyFor('parent')
    const ref=(await runtime.contextOutput.capture({sessionId:'parent',callId:'seed',label:'seed',text:'INHERITED_NATIVE',complete:true,source:await runtime.sourceFor('parent')}))!;refId=ref.id
    append(assembly.session,{type:'turn/start'});append(assembly.session,{type:'user/message',text:'seed'});append(assembly.session,{type:'context/result-ref',ref});append(assembly.session,{type:'turn/end'})
    await coordinator.flush('parent')
    if(disabled)await runtime.contextOutput.configure({enabled:false})
    await assembly.tools.dispatch(await assembly.tools.prepare({name:'spawn_agent',args:{message:'Read inherited ref',task_name:'seed',agent_type:'explore',fork_turns:'all',background:false}},undefined,{sessionId:'parent',callId:'spawn'}))
    const child=(await Promise.all((await coordinator.list()).map(id=>coordinator.profile(id)))).find(profile=>profile.meta.parentSession==='parent')!.meta
    const log=(await coordinator.snapshot!(child.sessionId)).session
    expect(log.events.find(event=>event.type==='tool/result'&&event.name==='context_output_read')).toMatchObject({output:{text:'INHERITED_NATIVE'}})
  }finally{await service.close();await runtime.close();await coordinator.close();await rm(root,{recursive:true,force:true})}
},15000)
