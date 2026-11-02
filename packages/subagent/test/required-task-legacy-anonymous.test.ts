const claimCut=vi.hoisted(()=>({root:'',armed:false,claims:0,terminals:0,entered:undefined as undefined|(()=>void)}))
vi.mock('../../session-persistence-jsonl/src/backend/document-write.ts',async load=>{const original=await load<typeof import('../../session-persistence-jsonl/src/backend/document-write.ts')>();return {...original,createOwnedDocumentWrite(...args:Parameters<typeof original.createOwnedDocumentWrite>){const created=original.createOwnedDocumentWrite(...args),input=args[0],data=JSON.parse(Buffer.from(input.bytes).toString('utf8')),ours=claimCut.root&&input.path.startsWith(claimCut.root)&&input.path.endsWith('task-parent.doc.jsonl'),claim=ours&&data.tasks?.some((task:{status:string;outcome?:string})=>task.status==='running'&&task.outcome===undefined);if(claim)claimCut.claims++;if(ours&&data.tasks?.some((task:{outcome?:string})=>task.outcome!==undefined))claimCut.terminals++;const apply=async(retry:boolean)=>{const outcome=retry?await created.handle.retry():await created.handle.issue();if(claim&&claimCut.armed){claimCut.entered?.();return{kind:'unknown' as const,cause:undefined,cleanupPending:false}}return outcome};return{handle:{issue:()=>apply(false),retry:()=>apply(true),reconcile:created.handle.reconcile.bind(created.handle),outcome:created.handle.outcome.bind(created.handle)},settle:created.settle.bind(created)}}}})
import {it,expect,vi} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext} from '@i-harness/core-plugin'
import {createToolRegistry} from '@i-harness/core-tools'
import {createMockClient} from '@i-harness/llm-mock'
import {registerExec} from '@i-harness/exec'
import {createJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {createGenerationLifecycle} from '../../session-executor/src/lifecycle/generation-actions.ts'
import {createTaskResultRetention} from '../../session-executor/src/lifecycle/task-result-retention.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {receivedInputsFor} from '../../session-executor/src/lifecycle/received-inputs.ts'
import {taskDocumentStorageContract} from '../src/task/storage-contract.ts'
import {registerSubagent} from '../src/index.ts'
import {SHIPPING_REPORT_POLICY} from '../src/report-policy.ts'
it.each([false,true])('genuine anonymous legacy retains Task2 and original claim prelude through retirement (unknown=%s)',async unknown=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'required-anonymous-')),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),claimUnknown=Promise.withResolvers<void>()
 const wire=`data: ${JSON.stringify({choices:[{delta:{content:'child done'},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:2}})}\n\ndata: [DONE]\n\n`,server=await createLoopbackProvider('/v1/chat/completions',[async response=>{entered.resolve();await release.promise;response.end(wire)}])
 let mounted:ReturnType<typeof registerSubagent>|undefined,action:ReturnType<Awaited<ReturnType<typeof coordinator.openManagedDocument>>['beginAction']>|undefined
 try{
  await coordinator.create({sessionId:'parent'});const document=await coordinator.openManagedDocument('parent'),ctx=createContext(),registry=createToolRegistry(ctx,{executionOwner:{view:document.view,factOwner:document,context:ctx,sessionId:'parent'}}),child=createOpenAICompatibleClient({apiKey:'loopback',model:'legacy-child',baseUrl:server.baseUrl})
  mounted=registerSubagent(ctx,registry,{parentSession:document.view,factOwner:document,parentModel:createMockClient([]),exec:registerExec(ctx),resolveModel:async()=>({status:'ready',binding:{client:child}}),allowSubagentModelSelection:true,reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(undefined,undefined,'parent'),generationFactoryFor:(owner,id,selected)=>(owned,dependencies)=>createGenerationLifecycle(owner.view,id,owned,{enabled:false,selectedClient:selected},dependencies),persist:{coordinator,stateId:'parent',parentSessionId:'parent'}});await mounted.ready
  mounted.roles.register({name:'legacy',description:'legacy',systemPrompt:'work',tools:[],model:{provider:'fixture',model:'legacy-child'}})
  await receivedInputsFor(document,'parent').inbox.admit({inputId:'human',text:'parent work',intent:'user',delivery:'queue',provenance:{kind:'human',authority:'request',scope:'turn',producer:'session.prompt'}})
  action=document.beginAction();const source=action.registerSettlementSource(async()=>{}),prepared=await registry.prepare({name:'spawn_agent',args:{message:'legacy work',task_name:'one',agent_type:'legacy',fork_turns:'none'}},action.signal,{session:document.view,sessionId:'parent',settlementSource:source})
  expect(prepared.exec.callId).toBeUndefined();expect(prepared.exec.callEventSeq).toBeUndefined()
  claimCut.root=root;claimCut.armed=unknown;claimCut.claims=claimCut.terminals=0;claimCut.entered=claimUnknown.resolve
  await registry.dispatch(prepared);await entered.promise;if(unknown)await claimUnknown.promise
  if(unknown)await expect(coordinator.getDocument('task-parent')).rejects.toThrow('Task document IO requires cleanup');else{const before=await coordinator.getDocument('task-parent') as {formatVersion:number;tasks:{childBirth?:unknown}[]};expect(before.formatVersion).toBe(2);expect(before.tasks[0]!.childBirth).toBeUndefined()}expect(server.requests).toHaveLength(1)
  document.revokeNewWork();const closing=mounted.dispose();void closing.catch(()=>{});release.resolve();if(unknown){expect(document.view.events.filter(e=>e.type==='subagent/end')).toHaveLength(0);claimCut.armed=false;await Promise.allSettled([closing,document.close()]);await document.close();await mounted.dispose()}else await closing;await source.close();action.finish();expect(claimCut.claims).toBe(1);expect(claimCut.terminals).toBe(1)
  const after=await coordinator.getDocument('task-parent') as {formatVersion:number;tasks:{outcome:string;childBirth?:unknown}[]};expect(after.formatVersion).toBe(2);expect(after.tasks[0]!.childBirth).toBeUndefined();expect(after.tasks[0]!.outcome).toBe('cancelled');expect(document.view.events.filter(e=>e.type==='subagent/end')).toHaveLength(1);expect(server.requests).toHaveLength(1)
 }catch(cause){const{inspect}=await import('node:util');console.info('anonymous-original-primary',inspect(cause,{depth:16}));throw cause}finally{claimCut.armed=false;claimCut.root='';claimCut.entered=undefined;release.resolve();action?.finish();await mounted?.dispose();await coordinator.close();await server.close()}
},20000)
