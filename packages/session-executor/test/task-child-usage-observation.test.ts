import {expect,it,vi} from 'vitest'
import {mkdtemp,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {committedFactSeqs} from '@i-harness/core-session'
import {createSessionAssembly,type SessionAssembly} from '../src/assembly.ts'
import {createUnmanagedTaskChildHost} from '../src/lifecycle/task-child-host.ts'
import {receivedInputsFor} from '../src/lifecycle/received-inputs.ts'
import {createJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {createUsageCapture} from '../../desktop-gateway/src/usage-capture.ts'
import {createUsageObservationSink} from '../../desktop-gateway/src/usage-observation-sink.ts'
import {createUsageStore} from '../../usage-stats/src/store.ts'
import {reduceUsageObservations} from '../../usage-stats/src/observation-reducer.ts'
import type {PassiveProducerRecord} from '@i-harness/llm-seam/internal/passive-observation'
import type {TaskProtocolDocument} from '../../subagent/src/task/types.ts'
import {TaskPersistence} from '../../subagent/src/task/persistence.ts'
import * as childStarts from '../../subagent/src/child.ts'
import {originalTaskChildBirth} from '../../subagent/src/child/task-birth.ts'
const headerCut=vi.hoisted(()=>({path:'',armed:false,faults:0}))
vi.mock('node:fs/promises',async load=>{const actual=await load<typeof import('node:fs/promises')>();return {...actual,async open(...args:Parameters<typeof actual.open>){const file=await actual.open(...args),sync=file.sync.bind(file);file.sync=async()=>{await sync();if(headerCut.armed&&String(args[0])===headerCut.path){headerCut.armed=false;headerCut.faults++;throw undefined}};return file}}})
type OriginalClientBuilder=Parameters<ReturnType<typeof createUsageCapture>['buildClient']>[0]
const diagnostic=(value:unknown):unknown=>value instanceof Error?{message:value.message,cause:diagnostic(value.cause),...(value instanceof AggregateError?{errors:value.errors.map(diagnostic)}:{})}:value===undefined?{type:'undefined'}:value
type Mode='declared'|'lost-header'|'held-settlement'|'stop'|'parent-child'|'inherit'
async function qualify(mode:Mode){
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'child-usage-')),store=createUsageStore(join(root,'usage')),coordinator=createJsonlTaskTransitionCoordinator(join(root,'sessions'),{lock:{enabled:true}},taskDocumentStorageContract)
 const measured=Promise.withResolvers<void>(),settling=Promise.withResolvers<void>(),releaseSettlement=Promise.withResolvers<void>(),releaseStream=Promise.withResolvers<void>()
 const records:PassiveProducerRecord[]=[],sink=createUsageObservationSink({record:value=>store.recordObservation(value)}),observer={capture(record:PassiveProducerRecord){records.push(record);sink.observer.capture(record);if(record.kind==='usage'&&record.usage.inputTokens===5)measured.resolve()},unavailable:sink.observer.unavailable}
 const warnings:string[]=[],originalWarn=console.warn.bind(console),warningSpy=vi.spyOn(console,'warn').mockImplementation(message=>{const text=String(message);if(text.startsWith('Plugin disposal failed:'))warnings.push(text);originalWarn(message)})
 let assembly:SessionAssembly|undefined,action:ReturnType<SessionAssembly['factOwner']['beginAction']>|undefined,source:ReturnType<NonNullable<typeof action>['registerSettlementSource']>|undefined,bodyPassed=false,primary:{cause:unknown}|undefined
 const wire=`data: ${JSON.stringify({choices:[{delta:{content:'child done'},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const childRound=async(response:import('node:http').ServerResponse,request:{body:Record<string,unknown>})=>{expect(request.body.model).toBe(mode==='inherit'?'parent-route':'declared-child');expect(assembly!.tasks().some(task=>task.status==='running')).toBe(true);if(mode==='stop'){response.write(`data: ${JSON.stringify({choices:[{delta:{content:'partial'}}],usage:{prompt_tokens:5,completion_tokens:2}})}\n\n`);await releaseStream.promise;return}response.end(wire)}
 const server=await createLoopbackProvider('/v1/chat/completions',mode==='parent-child'?[async(response,request)=>{expect(request.body.model).toBe('parent-route');response.end(`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'parent-spawn',type:'function',function:{name:'spawn_agent',arguments:JSON.stringify({message:'child work',task_name:'one',agent_type:'r5-child',background:false})}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:5,completion_tokens:2}})}\n\ndata: [DONE]\n\n`)},childRound,async(response,request)=>{expect(request.body.model).toBe('parent-route');expect(request.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({role:'tool'})]));response.end(wire)}]:[childRound])
 let legacyRecords=0
 const capture=createUsageCapture({workspace:root,observationMode:true,passiveObserver:observer,async record(){legacyRecords++}})
 const build=capture.buildClient(((_profile,model)=>createOpenAICompatibleClient({apiKey:'loopback',model:model!,baseUrl:server.baseUrl})) as OriginalClientBuilder)
 const parent=build({name:'fixture-parent',displayName:'Parent',protocol:'openai-compatible'},'parent-route'),child=build({name:'fixture-child',displayName:'Child',protocol:'openai-compatible'},'declared-child'),parentStream=vi.spyOn(parent,'stream'),resolve=vi.fn(async()=>({status:'ready' as const,binding:{client:child}}))
 const cleanup:unknown[]=[]
 const save=TaskPersistence.prototype.captureBindingSave,saveSpy=vi.spyOn(TaskPersistence.prototype,'captureBindingSave').mockImplementation(function(this:TaskPersistence){if(mode==='lost-header'){const id=this.snapshot().tasks[0]!.childBirth!.request.invocation.targetSessionId;headerCut.path=join(root,'sessions',id+'.jsonl');headerCut.armed=true}return save.call(this)})
 if(!coordinator.resumeChildTarget)throw Error('Original child resume capability unavailable')
 const resumeOwner=coordinator as typeof coordinator&{resumeChildTarget:NonNullable<typeof coordinator.resumeChildTarget>},resume=resumeOwner.resumeChildTarget.bind(coordinator),resumeSpy=vi.spyOn(resumeOwner,'resumeChildTarget').mockImplementation((...args)=>resume(...args))
 const hooked=new WeakSet<object>()
 const hookDocument=(document:Awaited<ReturnType<typeof coordinator.openManagedDocument>>)=>{if(hooked.has(document))return;hooked.add(document);const begin=document.beginAction.bind(document);document.beginAction=(...input)=>{const original=begin(...input),register=original.registerSettlementSource.bind(original);original.registerSettlementSource=(...args)=>{const source=register(...args),capture=source.generation.capture.bind(source.generation);source.generation.capture=event=>{const captured=capture(event);if(event.type==='context/attempt'&&event.op==='settle'){const admit=captured.admit.bind(captured);captured.admit=async()=>{settling.resolve();await releaseSettlement.promise;return admit()}}return captured};return source};return original}}
 const spawn=childStarts.spawnChild,spawnSpy=vi.spyOn(childStarts,'spawnChild').mockImplementation(async options=>{if(mode==='held-settlement'){if(options.childStart?.kind!=='committed-child-birth')throw Error('Original B2 birth missing');hookDocument(originalTaskChildBirth(options.childStart.birth).document)}return spawn(options)})
 try{
  await coordinator.create({sessionId:'parent'})
  assembly=await createSessionAssembly({workspace:root,coordinator,sessionId:'parent',model:parent,modelPolicy:'required',approveAll:true,codeMode:{mode:'off'},sandbox:'danger-full-access',passiveGeneration:observer,allowSubagentModelSelection:true,resolveRoleModel:resolve,prepareTaskChild:createUnmanagedTaskChildHost({coordinator,policy:'unmanaged'})})
  await assembly.updatePluginCapabilities({pluginAgents:[{name:'r5-child',description:'one scripted child',systemPrompt:'return fixture result',tools:[],...(mode==='inherit'?{}:{model:{provider:'fixture-child',model:'declared-child'}})}]})
  if(mode==='parent-child'){
   const result=await assembly.agent.run('use the declared child once, then report the result');expect(result.finalText).toBe('child done')
  }else{
  await receivedInputsFor(assembly.factOwner,'parent').inbox.admit({inputId:'human',text:'parent work',intent:'user',delivery:'queue',provenance:{kind:'human',authority:'request',scope:'turn',producer:'session.prompt'}})
  action=assembly.factOwner.beginAction();source=action.registerSettlementSource(async()=>{})
  const args={message:'child work',task_name:'one',agent_type:'r5-child',background:false},[seq]=committedFactSeqs(await action.facts.tools.call({type:'tool/call',callId:'call',name:'spawn_agent',args}));committedFactSeqs(await action.facts.tools.dispatch('call',{kind:'prior',seq:seq!,expectedType:'tool/call'}))
  const prepare=()=>assembly!.tools.prepare({name:'spawn_agent',args},action!.signal,{session:assembly!.session,sessionId:'parent',callId:'call',callEventSeq:seq!,settlementSource:source!})
  const first=assembly.tools.dispatch(await prepare()),duplicate=assembly.tools.dispatch(await prepare());void first.catch(()=>{});void duplicate.catch(()=>{})
  if(mode==='held-settlement'){await Promise.race([settling.promise,first.then(()=>{throw Error('Original child completed before captured settlement gate')},cause=>{throw cause})]);expect(records.filter(record=>record.kind==='usage')).toHaveLength(2);expect(records.some(record=>record.kind==='fact'&&record.event.type==='context/attempt'&&record.event.op==='settle')).toBe(false);expect(assembly.tasks().some(task=>task.status==='running')).toBe(true);releaseSettlement.resolve()}
  if(mode==='stop'){await Promise.race([measured.promise,first.then(()=>{throw Error('Original child completed before partial usage gate')},cause=>{throw cause})]);const task=assembly.tasks().find(task=>task.status==='running')!;expect(assembly.cancelTask(task.id)).toBe('cancellation-requested');assembly.cancelTask(task.id);releaseStream.resolve()}
  const result=await Promise.all([first,duplicate]);expect(result[0]).toEqual(result[1]);if(mode==='stop')expect(result[0]).not.toMatchObject({status:'completed'});else expect(result[0]).toMatchObject({status:'completed'})
  }
  expect(server.requests).toHaveLength(mode==='parent-child'?3:1);if(mode!=='parent-child'&&mode!=='inherit')expect(parentStream).not.toHaveBeenCalled();expect(resolve).toHaveBeenCalledTimes(mode==='inherit'?0:1);expect(server.errors).toEqual([]);expect(legacyRecords).toBe(0)
  const taskDocument=await coordinator.getDocument('task-parent') as TaskProtocolDocument;expect(taskDocument.formatVersion).toBe(3);expect(taskDocument.tasks).toHaveLength(1)
  const task=taskDocument.tasks.find(task=>task.childSessionId)!;expect(task.childBirth).toBeDefined();expect(task.childSessionId).toBe(task.childBirth!.request.invocation.targetSessionId)
  const view=assembly.liveChildSession!(task.childSessionId!)!;expect(view.events.filter(event=>event.type==='session/bootstrap')).toHaveLength(1);expect(view.events.filter(event=>event.type==='agent/input/admitted')).toHaveLength(1)
  const initial=view.events.find(event=>event.type==='agent/input/admitted')!;if(initial.type!=='agent/input/admitted')throw Error('Original admitted input missing')
  expect(view.events.find(event=>event.type==='context/action'&&event.op==='open')).toMatchObject({ownerSessionId:task.childSessionId,startedAt:task.childBirth!.request.core.initial.startedAt,expiresAt:task.childBirth!.request.core.initial.expiresAt,origin:{kind:'delegated-input',ref:'admitted',seq:initial.seq,inputId:initial.inputId}})
  const handoffs=records.filter(record=>record.kind==='handoff');expect(handoffs).toHaveLength(mode==='parent-child'?3:1);expect(handoffs.find(record=>record.identity.ownerSessionId===task.childSessionId)).toMatchObject({identity:{ownerSessionId:task.childSessionId},attribution:{providerId:mode==='inherit'?'fixture-parent':'fixture-child',modelId:mode==='inherit'?'parent-route':'declared-child',workspace:root}})
  if(mode==='parent-child'){const parentHandoffs=handoffs.filter(record=>record.identity.ownerSessionId==='parent');expect(parentHandoffs).toHaveLength(2);const parentOpens=assembly.session.events.filter(event=>event.type==='context/action'&&event.op==='open');expect(parentOpens).toHaveLength(2);expect(new Set(parentHandoffs.map(record=>record.identity.actionId))).toEqual(new Set(parentOpens.map(event=>'actionId'in event?event.actionId:undefined)));expect(parentOpens[1]).toMatchObject({origin:{kind:'predecessor'}});expect(new Set(parentHandoffs.map(record=>record.confirmation.sendId)).size).toBe(2);for(const record of parentHandoffs)expect(record.attribution).toMatchObject({providerId:'fixture-parent',modelId:'parent-route'})}
  const childHandoff=handoffs.find(record=>record.identity.ownerSessionId===task.childSessionId)!
  expect(view.events.find(event=>event.type==='context/attempt'&&event.op==='reserve')).toMatchObject({attemptId:childHandoff.identity.attemptId,incarnation:childHandoff.identity.incarnation,semanticId:childHandoff.confirmation.semanticId,payloadId:childHandoff.confirmation.payloadId})
  expect(view.events.find(event=>event.type==='context/attempt'&&event.op==='settle')).toMatchObject({attemptId:childHandoff.identity.attemptId,sendId:childHandoff.confirmation.sendId})
  const usage=records.filter((record):record is Extract<PassiveProducerRecord,{kind:'usage'}>=>record.kind==='usage'&&record.identity.ownerSessionId===task.childSessionId);expect(usage.map(record=>record.snapshotOrdinal)).toEqual(usage.map((_,index)=>index+1));expect(usage.some(record=>record.usage.inputTokens===5&&record.usage.outputTokens===2)).toBe(true)
  if(mode==='stop'){expect(usage.at(-1)?.terminalCoverage).toBe('unknown');expect(view.events.some(event=>event.type==='context/action'&&event.op==='accepted')).toBe(false);expect(view.events.filter(event=>event.type==='context/action'&&event.op==='close')).toEqual([expect.objectContaining({disposition:'stopped'})])}
  if(mode==='lost-header'){expect(headerCut.faults).toBe(1);expect(resumeSpy).toHaveBeenCalledTimes(1);expect(resumeSpy.mock.calls[0]![0]).toEqual(task.childBirth!.request)}else expect(resumeSpy).not.toHaveBeenCalled()
  for(const record of records.filter(record=>record.kind==='fact'&&record.event.ownerSessionId===task.childSessionId)){expect(record.kind).toBe('fact');if(record.kind==='fact'){expect(record.source).toBe('journal-fact');expect(record.event).toEqual(view.events[record.factSeq])}}
  bodyPassed=true;await writeFile(join(root,'body-proof.json'),JSON.stringify({mode,bodyPassed,task,requests:server.requests,records},null,2))
 }catch(cause){primary={cause};await writeFile(join(root,'body-proof.json'),JSON.stringify({bodyPassed,primary:diagnostic(cause),requests:server.requests,records},null,2))}finally{
  releaseSettlement.resolve();releaseStream.resolve();headerCut.armed=false
  try{await source?.close()}catch(error){cleanup.push(error)}action?.finish()
  try{await assembly?.dispose()}catch(error){cleanup.push(error)}
  try{await coordinator.close()}catch(error){cleanup.push(error)}
  if(!cleanup.length)try{await sink.close();if(bodyPassed){const loaded=await store.loadObservations(),fold=reduceUsageObservations(loaded.observations,{start:0,end:Number.MAX_SAFE_INTEGER});expect(fold.totals).toMatchObject({logicalActions:mode==='parent-child'?3:1,transportHandoffs:mode==='parent-child'?3:1,measuredTokenSubtotal:mode==='parent-child'?21:7});expect(loaded.warnings).toEqual([]);expect(sink.warnings()).toEqual([])}}catch(error){cleanup.push(error)}
  try{await server.close()}catch(error){cleanup.push(error)}
  for(const warning of warnings)cleanup.push(Error(warning));warningSpy.mockRestore();saveSpy.mockRestore();resumeSpy.mockRestore();spawnSpy.mockRestore();headerCut.faults=0
  await writeFile(join(root,'cleanup-proof.json'),JSON.stringify({bodyPassed,primary:primary?diagnostic(primary.cause):undefined,cleanup:cleanup.map(diagnostic)},null,2))
  if(primary||cleanup.length)throw new AggregateError([...(primary?[primary.cause]:[]),...cleanup],'Original B2 usage qualification unresolved')
 }
}
it('actual B2 declared child preserves its own send and measured usage observations',()=>qualify('declared'),20000)
it.each(['lost-header','held-settlement','stop','parent-child','inherit'] as const)('actual B2 child usage boundary: %s',mode=>qualify(mode),20000)
