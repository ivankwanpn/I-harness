import {expect,it,vi} from 'vitest'
const scopeCut=vi.hoisted(()=>({path:'',armed:false,cause:undefined as unknown,attempts:0,entered:undefined as undefined|(()=>void),gate:undefined as undefined|Promise<void>}))
const fileCut=vi.hoisted(()=>({path:'',rename:false,renames:0,opens:0,headerPath:'',headerCut:false,headerFaults:0}))
const nativeTaskWrites=vi.hoisted(()=>({path:'',records:[] as {bytes:string;issues:number}[]}))
vi.mock('../../session-persistence-jsonl/src/backend/document-write.ts',async load=>{const original=await load<typeof import('../../session-persistence-jsonl/src/backend/document-write.ts')>();return {...original,createOwnedDocumentWrite(input:Parameters<typeof original.createOwnedDocumentWrite>[0]){const created=original.createOwnedDocumentWrite(input);if(input.path!==nativeTaskWrites.path)return created;const record={bytes:Buffer.from(input.bytes).toString('utf8'),issues:0};nativeTaskWrites.records.push(record);return {...created,handle:{retry:created.handle.retry.bind(created.handle),reconcile:created.handle.reconcile.bind(created.handle),outcome:created.handle.outcome.bind(created.handle),issue(){record.issues++;return created.handle.issue()}}}}}})
vi.mock('node:fs/promises',async original=>{const fs=await original<typeof import('node:fs/promises')>();return {...fs,async open(...args:Parameters<typeof fs.open>){const handle=await fs.open(...args);if(String(args[0])===fileCut.path)fileCut.opens++;const sync=handle.sync.bind(handle);handle.sync=async()=>{await sync();if(fileCut.headerCut&&String(args[0])===fileCut.headerPath){fileCut.headerCut=false;fileCut.headerFaults++;throw undefined}};return handle},async rename(...args:Parameters<typeof fs.rename>){await fs.rename(...args);if(String(args[1])===fileCut.path)fileCut.renames++;if(fileCut.rename&&String(args[1])===fileCut.path){fileCut.rename=false;throw undefined}}}})
const instructionCut=vi.hoisted(()=>({armed:false,created:0,closed:0}))
vi.mock('../../runtime-context/src/index.ts',async original=>{const real=await original<typeof import('../../runtime-context/src/index.ts')>();return {...real,createRuntimeContext(...args:Parameters<typeof real.createRuntimeContext>){const runtime=real.createRuntimeContext(...args),counted=instructionCut.armed;if(counted)instructionCut.created++;return {...runtime,registerSection(...args:Parameters<typeof runtime.registerSection>){const result=runtime.registerSection(...args);if(instructionCut.armed){instructionCut.armed=false;throw undefined}return result},async close(){await runtime.close();if(counted)instructionCut.closed++}}}}})
vi.mock('../../fs-lock/src/index.ts',async original=>{const real=await original<typeof import('../../fs-lock/src/index.ts')>();return {...real,async acquireSessionLock(options:import('../../fs-lock/src/index.ts').AcquireOptions){const lock=await real.acquireSessionLock(options);return {get held(){return lock.held},async release(){if(options.lockPath===scopeCut.path){scopeCut.entered?.();await scopeCut.gate;if(scopeCut.armed){scopeCut.attempts++;throw scopeCut.cause}}await lock.release()}}}}})
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext} from '@i-harness/core-plugin'
import {createToolRegistry} from '@i-harness/core-tools'
import {committedFactSeqs} from '@i-harness/core-session'
import {createMockClient} from '@i-harness/llm-mock'
import {registerExec} from '@i-harness/exec'
import {createJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {createGenerationLifecycle} from '../../session-executor/src/lifecycle/generation-actions.ts'
import {createUnmanagedTaskChildHost} from '../../session-executor/src/lifecycle/task-child-host.ts'
import {createTaskResultRetention} from '../../session-executor/src/lifecycle/task-result-retention.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {taskDocumentStorageContract} from '../src/task/storage-contract.ts'
import {registerSubagent} from '../src/index.ts'
import {SHIPPING_REPORT_POLICY} from '../src/report-policy.ts'
import * as spawnSources from '../src/tools/spawn-source.ts'
import * as childStarts from '../src/child.ts'
import {TaskPersistence} from '../src/task/persistence.ts'
import {createHash} from 'node:crypto'
import {lockPathFor} from '../../fs-lock/src/index.ts'
import {artifactPathsFor} from '../../session-persistence/src/coordinator/artifact-path-association.ts'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {createChildInstructionHost} from '../../session-executor/src/context/instructions/child-host.ts'
import {createMainInstructionManager} from '../../session-executor/src/context/instructions/manager.ts'
import {createProjectInstructionEnvironment} from '../../session-executor/src/context/instructions/host.ts'
import {receivedInputsFor} from '../../session-executor/src/lifecycle/received-inputs.ts'
const diagnostic=(value:unknown):unknown=>value instanceof Error?{message:value.message,stack:value.stack,cause:diagnostic(value.cause),...(value instanceof AggregateError?{errors:value.errors.map(diagnostic)}:{})}:value
it.each(['declared','inherit','code','replay-cap','b2-lost-header','missing-host','managed-parent','foreign-host','stop-ack','expiry-ack','binding-unknown','stop-ready','stop-resolver','instruction-falsey','ready-held','publication-stop','scope-close','scope-parent-revoked'] as const)('original ordinary-none connected child: %s',async mode=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'task-child-')),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 const wire=`data: ${JSON.stringify({choices:[{delta:{content:'child done'},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{expect(mounted!.tasks.get('task-1')!.status).toBe('running');response.end(wire)}]),parentModel=mode==='inherit'?createOpenAICompatibleClient({apiKey:'loopback',model:'parent-route',baseUrl:server.baseUrl}):createMockClient([]),parentStream=vi.spyOn(parentModel,'stream')
 const sourceSpy=vi.spyOn(spawnSources,'createSpawnSource'),readyGate=Promise.withResolvers<void>(),readyEntered=Promise.withResolvers<void>()
 const childStartSpy=vi.spyOn(childStarts,'spawnChild')
 let expired=false
 const monotonic=performance.now.bind(performance),clockSpy=mode==='expiry-ack'?vi.spyOn(performance,'now').mockImplementation(()=>monotonic()+(expired?3_600_001:0)):undefined
 let originalReady:Awaited<ReturnType<NonNullable<typeof coordinator.bootstrapChildTargetWithCapture>>>|undefined,heldSave:ReturnType<TaskPersistence['captureBindingSave']>|undefined
 const save=TaskPersistence.prototype.captureBindingSave,saveSpy=vi.spyOn(TaskPersistence.prototype,'captureBindingSave').mockImplementation(function(this:TaskPersistence){if(mode==='binding-unknown')fileCut.rename=true;if(mode==='b2-lost-header'){const id=this.snapshot().tasks[0]!.childBirth!.request.invocation.targetSessionId;fileCut.headerPath=join(root,id+'.jsonl');fileCut.headerCut=true;fileCut.headerFaults=0}const result=save.call(this);heldSave=result;if(mode==='stop-ack')void result.done.then(()=>action!.stop());if(mode==='expiry-ack')void result.done.then(()=>{expired=true});return result})
 let birthSpy:{mockRestore():void}|undefined
 let resumeSpy:{mockRestore():void}|undefined,resumedReady:typeof originalReady
 const terminalSaves:ReturnType<TaskPersistence['captureBindingSave']>[]=[]
 const captureRequiredSave=TaskPersistence.prototype.captureRequiredSave,captureSpy=vi.spyOn(TaskPersistence.prototype,'captureRequiredSave').mockImplementation(function(this:TaskPersistence,...args){const result=captureRequiredSave.apply(this,args);terminalSaves.push(result);return result})
 const environment=createProjectInstructionEnvironment()
 let manager:ReturnType<typeof createMainInstructionManager>|undefined,instructions:ReturnType<typeof createChildInstructionHost>|undefined
 const foreign=mode==='foreign-host'?createJsonlTaskTransitionCoordinator(join(root,'foreign'),{lock:{enabled:true}},taskDocumentStorageContract):undefined
 let mounted:ReturnType<typeof registerSubagent>|undefined,action:ReturnType<Awaited<ReturnType<typeof coordinator.openManagedDocument>>['beginAction']>|undefined
 try{
  await coordinator.create({sessionId:'parent'});const document=await coordinator.openManagedDocument('parent'),ctx=createContext(),registry=createToolRegistry(ctx,{executionOwner:{view:document.view,factOwner:document,context:ctx,sessionId:'parent'}})
  const instructionOptions={environment,cwd:root,available:()=>true,authority:()=>({kind:'unbound' as const,revision:'1',workspaceRoot:root})}
  manager=createMainInstructionManager({...instructionOptions,publish:async()=>{}});instructions=createChildInstructionHost({...instructionOptions,root:{session:document.view,factOwner:document,manager}})
  const originalInstruction=instructions.create,instruction=vi.fn(originalInstruction);Object.defineProperty(instruction,'settleFailed',{value:originalInstruction.settleFailed})
  const bootstrapOwner=coordinator as typeof coordinator&{bootstrapChildTargetWithCapture:NonNullable<typeof coordinator.bootstrapChildTargetWithCapture>},bootstrap=bootstrapOwner.bootstrapChildTargetWithCapture.bind(coordinator)
  const resumeOwner=coordinator as typeof coordinator&{resumeChildTarget:NonNullable<typeof coordinator.resumeChildTarget>},resume=resumeOwner.resumeChildTarget.bind(coordinator)
  resumeSpy=vi.spyOn(resumeOwner,'resumeChildTarget').mockImplementation(async(...args)=>{const result=await resume(...args);resumedReady=result;return result})
  birthSpy=vi.spyOn(bootstrapOwner,'bootstrapChildTargetWithCapture').mockImplementation(async(...args)=>{const result=await bootstrap(...args);originalReady=result;if(result.kind==='ready'){if(mode==='scope-close'||mode==='scope-parent-revoked')scopeCut.armed=true;if(mode==='instruction-falsey'){instructionCut.armed=true;instructionCut.created=instructionCut.closed=0}if(mode==='stop-ready')action!.stop();if(mode==='ready-held'){readyEntered.resolve();await readyGate.promise}}return result})
  if(mode==='scope-close'||mode==='scope-parent-revoked'){const key='desktop-session-project-'+createHash('sha256').update('parent').digest('hex'),capture=artifactPathsFor(createJsonlBackend(root))!.document(key) as {key:string};scopeCut.path=lockPathFor(root,'artifact-document-lease:'+capture.key);scopeCut.attempts=0;scopeCut.cause=undefined}
  fileCut.path=join(root,'task-parent.doc.jsonl');fileCut.opens=fileCut.renames=0;nativeTaskWrites.path=mode==='binding-unknown'?fileCut.path:'';nativeTaskWrites.records=[]
  const childModel=createOpenAICompatibleClient({apiKey:'loopback',model:'declared-child',baseUrl:server.baseUrl}),resolveModel=vi.fn(async()=>{if(mode==='stop-resolver')action!.stop();return {status:'ready' as const,binding:{client:childModel}}})
  mounted=registerSubagent(ctx,registry,{parentSession:document.view,factOwner:document,parentModel,exec:registerExec(ctx),resolveModel,allowSubagentModelSelection:true,reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(undefined,undefined,'parent'),createInstructionContext:instruction,
   generationFactoryFor:(owner,id,selected)=>(owned,dependencies)=>createGenerationLifecycle(owner.view,id,owned,{enabled:false,selectedClient:selected},dependencies),
   ...(mode==='missing-host'?{}:{prepareTaskChild:createUnmanagedTaskChildHost({coordinator:foreign??coordinator,policy:'unmanaged'})}),
   persist:{coordinator,stateId:'parent',parentSessionId:'parent'}});await mounted.ready
  mounted.roles.register({name:'small',description:'small',systemPrompt:'s',tools:[],...(mode==='inherit'?{}:{model:{provider:'fixture',model:'declared-child'}})})
  if(mode==='managed-parent')await coordinator.putDocument('desktop-session-project-'+createHash('sha256').update('parent').digest('hex'),{version:1,projectId:'foreign-project'})
  if(mode==='publication-stop'){const add=mounted.table.add.bind(mounted.table);vi.spyOn(mounted.table,'add').mockImplementation((...args)=>{add(...args);action!.stop()})}
  await receivedInputsFor(document,'parent').inbox.admit({inputId:'human',text:'parent work',intent:'user',delivery:'queue',provenance:{kind:'human',authority:'request',scope:'turn',producer:'session.prompt'}})
  action=document.beginAction();const source=action.registerSettlementSource(async()=>{}),args={message:'child work',task_name:'one',agent_type:'small',background:false},[seq]=committedFactSeqs(await action.facts.tools.call({type:'tool/call',callId:'call',name:'spawn_agent',args}));committedFactSeqs(await action.facts.tools.dispatch('call',{kind:'prior',seq:seq!,expectedType:'tool/call'}))
  const prepare=()=>registry.prepare({name:'spawn_agent',args},action!.signal,{session:document.view,sessionId:'parent',callId:'call',callEventSeq:seq!,settlementSource:source,...mode==='code'?{resultConsumer:'code' as const}:{}})
  const first=registry.dispatch(await prepare()),duplicate=registry.dispatch(await prepare())
  void first.catch(()=>{});void duplicate.catch(()=>{})
  if(mode==='ready-held'){await readyEntered.promise;expect(originalReady?.kind).toBe('ready');expect(server.requests).toHaveLength(0);expect(instruction).not.toHaveBeenCalled();expect(resolveModel).not.toHaveBeenCalled();expect(mounted.table.entries().size).toBe(0);readyGate.resolve()}
  if(['missing-host','managed-parent','foreign-host','stop-ack','expiry-ack','binding-unknown','stop-ready','stop-resolver','instruction-falsey','publication-stop','scope-close','scope-parent-revoked'].includes(mode)){
   const results=await Promise.allSettled([first,duplicate]);expect(results.every(result=>result.status==='rejected')).toBe(true)
   expect(server.requests).toHaveLength(0);expect(parentStream).not.toHaveBeenCalled()
   if(mode==='missing-host'){expect(mounted.tasks.list()).toHaveLength(0);expect(sourceSpy).not.toHaveBeenCalled();expect(birthSpy).not.toHaveBeenCalled()}
   if(mode==='managed-parent'||mode==='foreign-host'){expect(sourceSpy).not.toHaveBeenCalled();expect(birthSpy).not.toHaveBeenCalled()}
   if(mode==='stop-ack'){expect(heldSave).toBeDefined();expect(birthSpy).not.toHaveBeenCalled();expect(mounted.tasks.get('task-1')?.childBirth).toBeDefined()}
   if(mode==='expiry-ack'){expect(results[0]).toMatchObject({status:'rejected',reason:{code:'GENERATION_EXPIRED'}});expect(birthSpy).not.toHaveBeenCalled();expect(instruction).not.toHaveBeenCalled()}
   if(mode==='binding-unknown'){expect(heldSave).toBeDefined();expect(birthSpy).not.toHaveBeenCalled();const originalFailure=await heldSave!.done.then(()=>{throw Error('Original binding unexpectedly succeeded')},cause=>cause),binding=nativeTaskWrites.records.find(record=>{const data=JSON.parse(record.bytes);return data.tasks.some((task:{childBirth?:unknown;outcome?:string})=>task.childBirth&&task.outcome===undefined)})!;expect(binding).toBeDefined();const stages=nativeTaskWrites.records.length,renames=fileCut.renames;await mounted.dispose();expect(heldSave!.outcome()?.kind).toBe('committed');expect(binding.issues).toBe(1);expect(nativeTaskWrites.records.filter(record=>record.bytes===binding.bytes)).toEqual([binding]);expect(fileCut.renames-renames).toBe(nativeTaskWrites.records.length-stages);await expect(heldSave!.done).rejects.toBe(originalFailure);expect(()=>heldSave!.assertHandoff()).toThrow();await expect(mounted.tasks.save()).rejects.toThrow();expect(birthSpy).not.toHaveBeenCalled();expect(server.requests).toHaveLength(0)}
   if(mode==='stop-ready'){expect(birthSpy).toHaveBeenCalledTimes(1);expect(originalReady?.kind).toBe('ready');expect(instruction).not.toHaveBeenCalled()}
   if(mode==='stop-resolver'){expect(resolveModel).toHaveBeenCalledTimes(1);expect(instruction).toHaveBeenCalledTimes(1);expect(mounted.agents.entries().size).toBe(0)}
   if(mode==='instruction-falsey'){expect(instructionCut.created).toBe(1);expect(instructionCut.closed).toBe(1);expect(resolveModel).not.toHaveBeenCalled();expect(results[0]).toMatchObject({status:'rejected',reason:undefined})}
   if(mode==='scope-close'){expect(scopeCut.attempts).toBeGreaterThan(0);expect(birthSpy).toHaveBeenCalledTimes(1);expect(originalReady?.kind).toBe('ready');expect(instruction).not.toHaveBeenCalled();expect(mounted.tasks.get('task-1')?.childBirth).toBeDefined();scopeCut.armed=false;await mounted.dispose();expect(server.requests).toHaveLength(0);expect(birthSpy).toHaveBeenCalledTimes(1)}
   if(mode==='scope-parent-revoked'){expect(originalReady?.kind).toBe('ready');expect(terminalSaves).toHaveLength(1);const original=terminalSaves[0]!;expect(original.outcome()?.kind).not.toBe('committed');scopeCut.armed=false;document.revokeNewWork();await mounted.dispose();expect(terminalSaves).toEqual([original]);expect(original.outcome()?.kind).toBe('committed');await expect(mounted.tasks.save()).rejects.toThrow();expect(server.requests).toHaveLength(0);expect(birthSpy).toHaveBeenCalledTimes(1);await source.close();return}
   await source.close();return
  }
  const results=await Promise.all([first,duplicate]);expect(results[0]).toEqual(results[1]);expect(results[0]).toMatchObject({task_id:'task-1',status:'completed'})
  const task=mounted.tasks.get('task-1')!;expect(task.childBirth).toBeDefined();expect(task.childSessionId).toBe(task.childBirth!.request.invocation.targetSessionId)
  if(mode==='b2-lost-header'){expect(fileCut.headerFaults).toBe(1);expect(resumeSpy).toHaveBeenCalledTimes(1);expect(resumedReady?.kind).toMatch(/ready/);expect((resumeSpy as unknown as {mock:{calls:unknown[][]}}).mock.calls[0]![0]).toEqual(task.childBirth!.request)}else expect(resumeSpy).not.toHaveBeenCalled()
  const child=mounted.table.get('root/one')!;expect(child.session.events.filter(event=>event.type==='agent/input/admitted')).toHaveLength(1);expect(child.session.events.filter(event=>event.type==='session/bootstrap')).toHaveLength(1)
  if(mode==='replay-cap'){
   const original=childStartSpy.mock.calls[0]![0],mount=vi.spyOn(ctx.scope,'mount');if(original.childStart?.kind!=='committed-child-birth')throw Error('Original child capability missing')
   await expect(childStarts.spawnChild({...original,childStart:{kind:'committed-child-birth',birth:{...original.childStart.birth}}})).rejects.toThrow('Foreign')
   await expect(childStarts.spawnChild(original)).rejects.toThrow();expect(mount).not.toHaveBeenCalled();expect(await coordinator.openManagedDocument(task.childSessionId!)).toBe(child.factOwner);mount.mockRestore()
  }
  const generation=child.session.events.find(event=>event.type==='context/action'&&event.op==='open');expect(generation).toMatchObject({startedAt:task.childBirth!.request.core.initial.startedAt,expiresAt:task.childBirth!.request.core.initial.expiresAt});expect(task.childBirth!.request.core.execution.timeoutMs).toBe(3_600_000)
  expect(server.requests).toHaveLength(1);expect(server.requests[0]!.body.model).toBe(mode==='inherit'?'parent-route':'declared-child');expect(resolveModel).toHaveBeenCalledTimes(mode==='inherit'?0:1);expect(parentStream).not.toHaveBeenCalled();expect(server.errors).toEqual([]);expect(instruction).toHaveBeenCalledTimes(1);expect(sourceSpy).toHaveBeenCalledTimes(1);expect(birthSpy).toHaveBeenCalledTimes(1)
  expect(mounted.agents.entries().size).toBe(1);expect(mounted.table.entries().size).toBe(1);expect(mounted.jobs.listAll()).toHaveLength(1)
  await source.close()
 }catch(cause){console.error('Original task launch diagnostic',JSON.stringify(diagnostic(cause)));throw cause}
 finally{clockSpy?.mockRestore();instructionCut.armed=false;scopeCut.armed=false;fileCut.headerCut=false;readyGate.resolve();saveSpy.mockRestore();captureSpy.mockRestore();birthSpy?.mockRestore();resumeSpy?.mockRestore();childStartSpy.mockRestore();sourceSpy.mockRestore();action?.finish();nativeTaskWrites.path='';try{await mounted?.dispose()}catch(cause){console.error('Original task cleanup diagnostic',JSON.stringify(diagnostic(cause)));throw cause}finally{await instructions?.close();await manager?.close();await environment.close();await coordinator.close();await foreign?.close();await server.close();await rm(root,{recursive:true,force:true})}}
},20_000)
