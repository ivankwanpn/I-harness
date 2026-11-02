import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext} from '@i-harness/core-plugin'
import {committedFactSeqs} from '@i-harness/core-session'
import {createManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {inspectOriginalTaskDeliveryOpen} from '@i-harness/session-persistence/internal/retained-inspection'
import {receivedExecutionInputsFor} from '../src/lifecycle/execution-inputs.ts'

it('opens and admits the original private Task delivery once from committed source and terminal',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'private-task-recipient-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'parent'});const execution=await acquireManagedExecution(coordinator,'parent'),domain=createManagedExecutionDomain(execution.identity,execution.owner,createContext()),inputs=receivedExecutionInputsFor(execution),recipient=inputs.taskDelivery(domain),action=execution.owner.beginAction(),source=action.registerSettlementSource(async()=>{})
 try{
  committedFactSeqs(await inputs.facts().admit({type:'agent/input/admitted',version:1,inputId:'human',text:'work',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}}))
  const [callSeq]=committedFactSeqs(await action.facts.tools.call({type:'tool/call',name:'spawn_agent',callId:'call',args:{}}));committedFactSeqs(await action.facts.tools.dispatch('call',{kind:'prior',seq:callSeq!,expectedType:'tool/call'}))
  const prepared=await recipient.prepareTaskLaunch({sessionId:'parent',namespace:'subagent',taskId:'task-1',callSeq:callSeq!});expect(prepared.kind).toBe('bound');if(prepared.kind!=='bound')throw Error('Task launch unavailable')
  expect(inspectOriginalTaskDeliveryOpen(prepared,execution.owner)).toMatchObject({view:undefined,binding:prepared.binding})
  const start=action.captureSubagentStart({type:'subagent/start',version:1,taskId:'task-1',parentSessionId:'parent',agentPath:'root/a',role:'general',description:'work'},prepared.binding),seqs=committedFactSeqs(await start.admit()),sourceSeq=seqs[1]!
  const [terminalSeq]=committedFactSeqs(await source.delivery.capture({type:'subagent/end',version:1,taskId:'task-1',outcome:'completed',resultRevision:'revision',envelope:{version:1,execution:{outcome:'succeeded',dispatch:'dispatched'},preview:'',media:[],retention:{kind:'inline',value:'result',encodedBytes:8}}}).admit())
  const evidence={sourceSeq,terminalSeq:terminalSeq!},presentation={text:'done',description:'task done',display:{kind:'task' as const,title:'done',body:'done'}}
  expect(recipient.taskEvidence('subagent','task-1')).toMatchObject({evidence})
  expect(recipient.taskEvidence('subagent','foreign')).toBeUndefined()
  expect(()=>recipient.taskEvidence.call({...recipient},'subagent','task-1')).toThrow()
  const receipt=await recipient.admitTask(evidence,presentation);expect(receipt).toMatchObject({durability:'durable',disposition:'pending'});expect(await recipient.admitTask(evidence,presentation)).toEqual(receipt)
  await expect(recipient.admitTask({...evidence,terminalSeq:terminalSeq!+1},presentation)).rejects.toThrow()
 }finally{await source.close();action.finish();await inputs.close();await coordinator.close()}
},20000)
