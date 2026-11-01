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
type OriginalClientBuilder=Parameters<ReturnType<typeof createUsageCapture>['buildClient']>[0]
const diagnostic=(value:unknown):unknown=>value instanceof Error?{message:value.message,cause:diagnostic(value.cause),...(value instanceof AggregateError?{errors:value.errors.map(diagnostic)}:{})}:value===undefined?{type:'undefined'}:value
it('actual B2 declared child preserves its own send and measured usage observations',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'child-usage-')),store=createUsageStore(join(root,'usage')),coordinator=createJsonlTaskTransitionCoordinator(join(root,'sessions'),{lock:{enabled:true}},taskDocumentStorageContract)
 const records:PassiveProducerRecord[]=[],sink=createUsageObservationSink({record:value=>store.recordObservation(value)}),observer={capture(record:PassiveProducerRecord){records.push(record);sink.observer.capture(record)},unavailable:sink.observer.unavailable}
 const warnings:string[]=[],originalWarn=console.warn.bind(console),warningSpy=vi.spyOn(console,'warn').mockImplementation(message=>{const text=String(message);if(text.startsWith('Plugin disposal failed:'))warnings.push(text);originalWarn(message)})
 let assembly:SessionAssembly|undefined,action:ReturnType<SessionAssembly['factOwner']['beginAction']>|undefined,source:ReturnType<NonNullable<typeof action>['registerSettlementSource']>|undefined,bodyPassed=false,primary:{cause:unknown}|undefined
 const wire=`data: ${JSON.stringify({choices:[{delta:{content:'child done'},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async(response,request)=>{expect(request.body.model).toBe('declared-child');expect(assembly!.tasks().some(task=>task.status==='running')).toBe(true);response.end(wire)}])
 let legacyRecords=0
 const capture=createUsageCapture({workspace:root,observationMode:true,passiveObserver:observer,async record(){legacyRecords++}})
 const build=capture.buildClient(((_profile,model)=>createOpenAICompatibleClient({apiKey:'loopback',model:model!,baseUrl:server.baseUrl})) as OriginalClientBuilder)
 const parent=build({name:'fixture-parent',displayName:'Parent',protocol:'openai-compatible'},'parent-route'),child=build({name:'fixture-child',displayName:'Child',protocol:'openai-compatible'},'declared-child'),parentStream=vi.spyOn(parent,'stream'),resolve=vi.fn(async()=>({status:'ready' as const,binding:{client:child}}))
 const cleanup:unknown[]=[]
 try{
  await coordinator.create({sessionId:'parent'})
  assembly=await createSessionAssembly({workspace:root,coordinator,sessionId:'parent',model:parent,modelPolicy:'required',approveAll:true,codeMode:{mode:'off'},sandbox:'danger-full-access',passiveGeneration:observer,allowSubagentModelSelection:true,resolveRoleModel:resolve,prepareTaskChild:createUnmanagedTaskChildHost({coordinator,policy:'unmanaged'})})
  await assembly.updatePluginCapabilities({pluginAgents:[{name:'r5-child',description:'one scripted child',systemPrompt:'return fixture result',tools:[],model:{provider:'fixture-child',model:'declared-child'}}]})
  await receivedInputsFor(assembly.factOwner,'parent').inbox.admit({inputId:'human',text:'parent work',intent:'user',delivery:'queue',provenance:{kind:'human',authority:'request',scope:'turn',producer:'session.prompt'}})
  action=assembly.factOwner.beginAction();source=action.registerSettlementSource(async()=>{})
  const args={message:'child work',task_name:'one',agent_type:'r5-child',background:false},[seq]=committedFactSeqs(await action.facts.tools.call({type:'tool/call',callId:'call',name:'spawn_agent',args}));committedFactSeqs(await action.facts.tools.dispatch('call',{kind:'prior',seq:seq!,expectedType:'tool/call'}))
  const prepare=()=>assembly!.tools.prepare({name:'spawn_agent',args},action!.signal,{session:assembly!.session,sessionId:'parent',callId:'call',callEventSeq:seq!,settlementSource:source!})
  const first=assembly.tools.dispatch(await prepare()),duplicate=assembly.tools.dispatch(await prepare());const result=await Promise.all([first,duplicate]);expect(result[0]).toEqual(result[1]);expect(result[0]).toMatchObject({status:'completed'})
  expect(server.requests).toHaveLength(1);expect(parentStream).not.toHaveBeenCalled();expect(resolve).toHaveBeenCalledTimes(1);expect(server.errors).toEqual([]);expect(legacyRecords).toBe(0)
  const taskDocument=await coordinator.getDocument('task-parent') as TaskProtocolDocument;expect(taskDocument.formatVersion).toBe(3)
  const task=taskDocument.tasks.find(task=>task.childSessionId)!;expect(task.childBirth).toBeDefined();expect(task.childSessionId).toBe(task.childBirth!.request.invocation.targetSessionId)
  const view=assembly.liveChildSession!(task.childSessionId!)!;expect(view.events.filter(event=>event.type==='session/bootstrap')).toHaveLength(1);expect(view.events.filter(event=>event.type==='agent/input/admitted')).toHaveLength(1)
  const handoffs=records.filter(record=>record.kind==='handoff');expect(handoffs).toHaveLength(1);expect(handoffs[0]).toMatchObject({identity:{ownerSessionId:task.childSessionId},attribution:{providerId:'fixture-child',modelId:'declared-child',workspace:root}})
  const usage=records.filter(record=>record.kind==='usage');expect(usage.map(record=>record.snapshotOrdinal)).toEqual(usage.map((_,index)=>index+1));expect(usage.some(record=>record.usage.inputTokens===5&&record.usage.outputTokens===2)).toBe(true)
  for(const record of records.filter(record=>record.kind==='fact'&&record.event.ownerSessionId===task.childSessionId)){expect(record.kind).toBe('fact');if(record.kind==='fact'){expect(record.source).toBe('journal-fact');expect(record.event).toEqual(view.events[record.factSeq])}}
  bodyPassed=true;await writeFile(join(root,'body-proof.json'),JSON.stringify({bodyPassed,task,requests:server.requests,records},null,2))
 }catch(cause){primary={cause};await writeFile(join(root,'body-proof.json'),JSON.stringify({bodyPassed,primary:diagnostic(cause),requests:server.requests,records},null,2))}finally{
  try{await source?.close()}catch(error){cleanup.push(error)}action?.finish()
  try{await assembly?.dispose()}catch(error){cleanup.push(error)}
  try{await coordinator.close()}catch(error){cleanup.push(error)}
  if(!cleanup.length)try{await sink.close();if(bodyPassed){const loaded=await store.loadObservations(),fold=reduceUsageObservations(loaded.observations,{start:0,end:Number.MAX_SAFE_INTEGER});expect(fold.totals).toMatchObject({logicalActions:1,transportHandoffs:1,measuredTokenSubtotal:7});expect(loaded.warnings).toEqual([]);expect(sink.warnings()).toEqual([])}}catch(error){cleanup.push(error)}
  try{await server.close()}catch(error){cleanup.push(error)}
  for(const warning of warnings)cleanup.push(Error(warning));warningSpy.mockRestore()
  await writeFile(join(root,'cleanup-proof.json'),JSON.stringify({bodyPassed,primary:primary?diagnostic(primary.cause):undefined,cleanup:cleanup.map(diagnostic)},null,2))
  if(primary||cleanup.length)throw new AggregateError([...(primary?[primary.cause]:[]),...cleanup],'Original B2 usage qualification unresolved')
 }
},20000)
