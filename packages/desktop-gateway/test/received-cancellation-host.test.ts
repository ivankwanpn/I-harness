import { AsyncResource } from 'node:async_hooks'
import {it,expect,vi} from 'vitest'
import {createServer} from 'node:http'
import {mkdtemp,rm,mkdir,writeFile,readFile,readdir} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {tmpdir} from 'node:os'
import {inspect} from 'node:util'
import {fileURLToPath} from 'node:url'
const cut=vi.hoisted(()=>({mode:'',root:'',backends:[] as any[],docs:new Map<string,any>(),wrapped:new WeakSet<object>(),entered:Promise.withResolvers<void>(),release:Promise.withResolvers<void>(),cancelled:Promise.withResolvers<void>(),closedStarted:Promise.withResolvers<void>(),secondEntered:Promise.withResolvers<void>(),secondRelease:Promise.withResolvers<void>(),held:false,parentId:'',taskInputId:'',promotionId:'',promotionIssues:0,cancellations:[] as any[],sourceCloses:[] as any[],events:[] as any[],startClose:undefined as undefined|(()=>Promise<void>)}))
const describeError=(e:any):any=>e&&typeof e==='object'?{name:e.name,message:e.message,code:e.code,stack:e.stack,...(e.outcome?{outcome:e.outcome}:{}),...(e.cause?{cause:describeError(e.cause)}:{}),...(e.errors?{errors:Array.from(e.errors,describeError)}:{})}:{value:String(e)}
vi.mock('../../session-persistence-jsonl/src/index.ts',async original=>{
 const actual=await original<typeof import('../../session-persistence-jsonl/src/index.ts')>()
 return {...actual,createJsonlBackend(...args:Parameters<typeof actual.createJsonlBackend>){
  const backend=actual.createJsonlBackend(args[0],{...args[1],wrapOwnedBatch(originalAppend){
   const append=args[1]?.wrapOwnedBatch?.(originalAppend)??originalAppend
   return async(...params)=>{
    const frame=JSON.parse(Buffer.from(params[3].bytes).toString('utf8'))
    if(params[0]===cut.parentId){const admission=frame.events.find((e:any)=>e.type==='agent/input/admitted'&&e.provenance?.producer==='session.delivery.subagent');if(admission)cut.taskInputId=admission.inputId}
    const promotion=frame.events.find((e:any)=>e.type==='agent/input/promoted'&&e.inputId===cut.taskInputId)
    const target=params[0]===cut.parentId&&promotion&&frame.events.some((e:any)=>e.type==='turn/start')
    const outcome=await append(...params)
    if(target){cut.promotionIssues++;expect(outcome.kind).toBe('committed')}
    if(target&&!cut.held){cut.held=true;cut.promotionId=promotion.inputId;cut.events.push({phase:'original-promotion-committed-held',id:params[0],outcome});cut.entered.resolve();await cut.release.promise}
    return outcome
   }
  }});cut.backends.push(backend);return backend
 }}
})
vi.mock('../../session-persistence/src/index.ts',async original=>{
 const actual=await original<typeof import('../../session-persistence/src/index.ts')>()
 return {...actual,createSessionCoordinator(...args:Parameters<typeof actual.createSessionCoordinator>){
  const coordinator=actual.createSessionCoordinator(...args),open=coordinator.openManagedDocument.bind(coordinator)
  coordinator.openManagedDocument=async(...params)=>{
   const doc=await open(...params),id=params[0];cut.docs.set(id,doc)
   if(!cut.wrapped.has(doc)){
    cut.wrapped.add(doc);const register=doc.registerReceivedInputSource.bind(doc)
    doc.registerReceivedInputSource=drain=>{const source=register(drain),capture=source.captureCancellation.bind(source),close=source.close.bind(source)
     source.captureCancellation=event=>{const fact=capture(event),last=doc.view.events.filter((e:any)=>e.inputId===event.inputId&&['agent/input/admitted','agent/input/promoted','agent/input/cancelled'].includes(e.type)).at(-1),row:any={sessionId:id,event,pendingAtCapture:last?.type==='agent/input/admitted',operations:[]};cut.cancellations.push(row)
      for(const op of ['admit','reconcile','observe','retryAbsent'] as const){const native=fact[op].bind(fact);fact[op]=async()=>{try{const outcome=await native();row.operations.push({op,outcome});return outcome}catch(error){row.operations.push({op,error:describeError(error)});throw error}}}
      if(event.inputId===cut.promotionId)cut.cancelled.resolve();return fact}
     source.close=async()=>{try{await close();cut.sourceCloses.push({sessionId:id,state:'fulfilled'})}catch(error){cut.sourceCloses.push({sessionId:id,state:'rejected',error:describeError(error)});throw error}};return source}
    // Register on the genuine managed view through the real subscriber below.
   }
   return doc
  };return coordinator
 }}
})
import {PluginRegistry} from '../../plugin-registry/src/index.ts'
import {createHookTrustStore,sha256ClaudePluginTreeSync} from '../../hooks/src/index.ts'
import {encodeFrame,isRpcSuccess,makeRequest,type RpcMessage} from '../../sdk/src/index.ts'
import {createDesktopHost} from '../../desktop-gateway/src/host.ts'
import {createHostFixtureTrace} from '../../desktop-gateway/test/host-fixture-trace.ts'
import {createHostFixtureModel} from '../../desktop-gateway/test/host-fixture-model.ts'
import {append,createSession,deriveMessages,fromJSONL,toJSONL,readInbox} from '../../core-session/src/index.ts'

// Two actual Task births, read/Code child turns and a controlled notification/close exceed 20s.
it.each(['before-install','after-install'])('settles actual Desktop child/Code/Task close at controlled parent notification promotion (%s)',async mode=>{
 Object.assign(cut,{mode,root:await mkdtemp(join(tmpdir(),'received-host-')),backends:[],docs:new Map(),wrapped:new WeakSet(),entered:Promise.withResolvers<void>(),release:Promise.withResolvers<void>(),cancelled:Promise.withResolvers<void>(),closedStarted:Promise.withResolvers<void>(),secondEntered:Promise.withResolvers<void>(),secondRelease:Promise.withResolvers<void>(),held:false,parentId:'',taskInputId:'',promotionId:'',promotionIssues:0,cancellations:[],sourceCloses:[],events:[],startClose:undefined})
 const closeContext=new AsyncResource('received-host-external-close')
 const trace=createHostFixtureTrace('controlled-host-close-'+cut.mode),root=cut.root,workspace=resolve(root,'workspace'),sessions=resolve(root,'sessions')
 const requests:any[]=[],childRounds=new Map<string,number>(),frames:RpcMessage[]=[],producerProof:any[]=[]
 let parentRound=0,toolNumber=0,host:Awaited<ReturnType<typeof createDesktopHost>>|undefined,closing:Promise<void>|undefined,closeResult:any,main:Promise<unknown>|undefined,parentId='',journal:any,finalErrors:any[]=[]
 const deadline=Promise.withResolvers<never>(),bounded=<T,>(p:Promise<T>)=>Promise.race([p,deadline.promise]);const watchdog=setTimeout(()=>{cut.release.resolve();cut.secondRelease.resolve();deadline.reject(new Error('Controlled host boundary deadline'))},45000);watchdog.unref()
 const server=createServer(async(request,response)=>{
  const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(chunks).toString())
  let delta:any={content:'Reply ended'};const call=(name:string,args:unknown)=>({tool_calls:[{index:0,id:`call-${++toolNumber}`,function:{name,arguments:JSON.stringify(args)}}]})
  if(body.model==='parent'){
   const round=++parentRound;requests.push({model:'parent',round})
   if(round===1)delta=call('spawn_agent',{task_name:'helper',agent_type:'explore',message:'Read fixture.txt',background:false})
   else if(round===2)delta=call('spawn_agent',{task_name:'helper-second',agent_type:'explore',message:'Read fixture.txt',background:true})
   // Controlled extension: finish main without wait_agent, then release the
   // real background Task final HTTP response. This guarantees an idle parent wake.
  }else{
   const system=JSON.stringify(body.messages[0]?.content),path=system.includes('root/helper-second')?'root/helper-second':'root/helper',round=(childRounds.get(path)??0)+1;childRounds.set(path,round);requests.push({model:'child',path,round})
   if(round===1)delta=call('read',{path:'fixture.txt'})
   else if(round===2)delta=call('code_exec',{code:'const file = await tools.read({path:"fixture.txt"});text(file.content)'})
   else if(path==='root/helper-second'){cut.secondEntered.resolve();await cut.secondRelease.promise}
  }
  response.writeHead(200,{'content-type':'text/event-stream'});response.end(`data: ${JSON.stringify({choices:[{delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)
 })
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`
 const close=()=>{if(closing)return closing;cut.events.push({phase:'real-host-close',pending:readInbox(cut.docs.get(parentId).view).isPending(cut.promotionId)});closing=host!.close();void closing.catch(()=>{});cut.closedStarted.resolve();return closing};cut.startClose=close
 try{
  await mkdir(workspace,{recursive:true});await writeFile(join(workspace,'fixture.txt'),'Desktop host fixture')
  const registry=new PluginRegistry({root:join(root,'plugins')});await registry.addSource(fileURLToPath(new URL('../../desktop-gateway/test/fixtures/official-plugins',import.meta.url)));await registry.install('Official fixture subset__explanatory-output-style');await registry.enable('Official fixture subset__explanatory-output-style')
  const plugin=join(root,'plugins','Official fixture subset__explanatory-output-style');createHookTrustStore(join(root,'hook-trust.json')).approve({sha256:sha256ClaudePluginTreeSync(plugin),script:plugin,handlerId:'claude:SessionStart:0:0'})
  const settingsPath=join(root,'settings.json');await writeFile(settingsPath,JSON.stringify({autoTitle:false,approvalMode:'full-access',sandboxMode:'danger-full-access',plugins:{subagentModel:true},codeMode:{mode:'mixed'},agents:{roles:{explore:{provider:'fixture',model:'child'}}},llm:{providers:{fixture:{protocol:'openai-completions',baseURL:`${origin}/v1`,models:[{id:'parent',contextWindow:272000},{id:'child',contextWindow:272000}]}},defaultModel:{provider:'fixture',model:'parent'}}}))
  host=await createDesktopHost({workspace,settingsPath,sessionDir:sessions,buildProviderClient:createHostFixtureModel(origin,trace),onWrite:frame=>{trace.observe(frame);frames.push(frame);if(cut.mode==='after-install'&&'method'in frame&&frame.method==='session/event'){const params=frame.params as any,event=params?.event;if(params?.sessionId===parentId&&event?.type==='agent/input/preparation'&&event.op==='promoted'&&event.inputId===cut.promotionId){cut.events.push({phase:'promotion-installed',pending:readInbox(cut.docs.get(parentId).view).isPending(event.inputId)});closeContext.runInAsyncScope(()=>{void close()})}}}})
  let seq=0;const rpc=async(method:string,params:any={})=>{const id=++seq;await trace.run(method,()=>host!.handleLine(encodeFrame(makeRequest(id,method,params))));const reply=frames.find(frame=>'id'in frame&&frame.id===id);if(!isRpcSuccess(reply))throw Error(JSON.stringify(reply));return reply.result as any}
  await rpc('initialize');await rpc('desktop/provider/mutate',{action:'key/set',id:'fixture',value:'test-only-key'});parentId=(await rpc('session/create')).sessionId;cut.parentId=parentId
  await rpc('desktop/session/project/bind',{sessionId:parentId})
  main=rpc('session/prompt',{sessionId:parentId,prompt:'Delegate the fixture checks'});void main.catch(()=>{})
  await trace.run('initial-parent-completion',()=>bounded(main!));await trace.run('second-child-final-gate',()=>bounded(cut.secondEntered.promise))
  expect(parentRound).toBe(3);expect(cut.held).toBe(false)
  const parentDoc=cut.docs.get(parentId);expect(parentDoc).toBeDefined()
  cut.secondRelease.resolve();await bounded(cut.entered.promise);clearTimeout(watchdog)
  const backend=cut.backends[0];journal=(await backend.read(parentId)).events
  expect(journal.filter((e:any)=>e.type==='agent/input/promoted'&&e.inputId===cut.promotionId)).toHaveLength(1);expect(readInbox(parentDoc.view).isPending(cut.promotionId)).toBe(true)
  // The held receipt intentionally fences public snapshots. Read the actual
  // owned fixture backend journals for producer assertions, never bypass an RPC.
  const childFiles=(await readdir(sessions)).filter(name=>name.startsWith('child-')&&name.endsWith('.jsonl'));expect(childFiles).toHaveLength(2)
  for(const file of childFiles){const id=file.slice(0,-6),session=await backend.read(id),events=session.events??session
   const results=events.filter((e:any)=>e.type==='tool/result');expect(results.length).toBeGreaterThanOrEqual(2)
   const selection=createSession();for(const result of results){const call=events.find((e:any)=>e.type==='tool/call'&&e.callId===result.callId);expect(call).toBeDefined();expect(call.name).toBe(result.name);append(selection,call);append(selection,result);expect(result.envelope.execution).toEqual({outcome:'succeeded',dispatch:'dispatched'});expect(Buffer.byteLength(JSON.stringify(result.envelope))).toBeLessThanOrEqual(64000)}
   const cold=fromJSONL(toJSONL(selection));expect(cold.events).toEqual(selection.events);for(const message of deriveMessages(cold).filter(m=>m.role==='tool'))expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThanOrEqual(64000)
   const inline=(name:string)=>{const result=cold.events.find((e:any)=>e.type==='tool/result'&&e.name===name);expect(result?.type==='tool/result'&&result.envelope?.retention.kind==='inline').toBe(true);return(result as any).envelope.retention.value}
   expect(inline('read')).toEqual({content:'Desktop host fixture',instruction_scope:{status:'queued'}})
   const text='Desktop host fixture'
   expect(inline('code_exec')).toMatchObject({status:'completed',text,truncated:false,textRetention:{stored:true,complete:true,omittedBytes:0,truncated:false,admittedBytes:Buffer.byteLength(text)}})
   expect(results.filter((e:any)=>e.name==='read')).toHaveLength(1);expect(results.filter((e:any)=>e.name==='code_exec')).toHaveLength(1);expect(events.filter((e:any)=>e.type==='turn/end')).toHaveLength(1)
   producerProof.push({id,events,results:results.map((e:any)=>({callId:e.callId,name:e.name,execution:e.envelope.execution}))})
  }
  expect(producerProof).toHaveLength(2);expect(journal.filter((e:any)=>e.type==='subagent/end')).toHaveLength(2);expect(journal.find((e:any)=>e.type==='subagent/end')).toMatchObject({outcome:'completed',resultRevision:expect.any(String),envelope:{execution:{outcome:'succeeded',dispatch:'dispatched'}}});expect(journal.filter((e:any)=>e.type==='agent/input/admitted'&&e.inputId===cut.taskInputId)).toHaveLength(1)
  if(cut.mode==='before-install'){void close();await cut.closedStarted.promise;cut.release.resolve()}else{cut.release.resolve();await bounded(cut.closedStarted.promise)}
  closeResult=await bounded(closing!).then(()=>({state:'fulfilled'}),error=>({state:'rejected',error:describeError(error),detail:inspect(error,{depth:20})}))
  journal=(await backend.read(parentId)).events
 }finally{
  cut.secondRelease.resolve();cut.release.resolve();clearTimeout(watchdog)
  const drains=await Promise.allSettled([main??Promise.resolve(),host?.close()??Promise.resolve()])
  for(const [index,result] of drains.entries())if(result.status==='rejected')finalErrors.push({owner:index===0?'main':'host-finally',error:describeError(result.reason)})
  server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()))
  closeContext.emitDestroy()
  await writeFile(resolve(root,'observations.json'),JSON.stringify({scope:'Controlled extension of actual Desktop ordinary/Code children fixture. Original wait_agent parent round replaced by final main response; real background Task final HTTP response held until main ends. Original authority/body/call-result assertions read genuine owned fixture backend journals at held snapshot fence. Not unchanged maintained-test qualification.',mode:cut.mode,parentId,parentRound,childRounds:[...childRounds],requests,events:cut.events,promotionIssues:cut.promotionIssues,promotionId:cut.promotionId,cancellations:cut.cancellations,sourceCloses:cut.sourceCloses,producerProof,journal,closeResult,finalErrors},null,2))
  const evidence=process.env.IH_CANCELLATION_EVIDENCE_ROOT;if(evidence){await mkdir(evidence,{recursive:true});await writeFile(resolve(evidence,'host-'+mode+'.json'),await readFile(resolve(root,'observations.json')))}
  if(drains[1]?.status==='fulfilled')await rm(root,{recursive:true,force:true})
 }
 console.log(JSON.stringify({mode:cut.mode,parentRound,childRounds:[...childRounds],notificationGenerationSends:parentRound-3,promotionIssues:cut.promotionIssues,cancellationCaptures:cut.cancellations.length,sourceCloses:cut.sourceCloses.map(r=>({state:r.state,sessionId:r.sessionId,error:r.error?.message})),close:closeResult?.state,closeError:closeResult?.detail,tail:journal?.slice(-10).map((e:any)=>({seq:e.seq,type:e.type,op:e.op,disposition:e.disposition,inputId:e.inputId}))}))
 expect(finalErrors).toEqual([]);expect(parentRound).toBe(3);expect(cut.promotionIssues).toBe(1);expect(journal.filter((e:any)=>e.type==='agent/input/cancelled')).toHaveLength(0);expect(journal.filter((e:any)=>e.type==='context/action'&&e.op==='close'&&e.disposition==='stopped')).toHaveLength(1)
 for(const row of cut.cancellations)for(const operation of row.operations)expect(operation.outcome).toMatchObject({kind:'not-issued',code:'FACT_INVALID_GROUP'})
 if(cut.mode==='after-install')expect(cut.cancellations).toHaveLength(0)
 expect(closeResult.state,'Real Desktop host close must settle the superseded never-issued cancellation').toBe('fulfilled')
},60000)
