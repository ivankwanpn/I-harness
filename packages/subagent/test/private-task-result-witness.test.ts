import {expect,it,vi} from 'vitest'
const fault=vi.hoisted(()=>({close:false}))
vi.mock('../../session-persistence/src/execution-internal.ts',async load=>{const original=await load<typeof import('../../session-persistence/src/execution-internal.ts')>();return {...original,associateExecutionDependencies(backend:object,open:Parameters<typeof original.associateExecutionDependencies>[1]){original.associateExecutionDependencies(backend,(...args)=>{const scope=open(...args);return Object.freeze({assertCurrent:scope.assertCurrent.bind(scope),readEvent:scope.readEvent.bind(scope),async close(){if(fault.close)throw Error('controlled dependency close');await scope.close()}})})}}})
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext} from '@i-harness/core-plugin'
import {createManagedExecutionDomain,readManagedTaskResult} from '@i-harness/core-session/internal/execution'
import {committedFactSeqs} from '@i-harness/core-session'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {taskDocumentStorageContract} from '../src/task/storage-contract.ts'

it('reads only the original selected Task end and refuses copied and closed domains',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'private-task-witness-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'parent'});const execution=await acquireManagedExecution(coordinator,'parent'),domain=createManagedExecutionDomain(execution.identity,execution.owner,createContext()),action=execution.owner.beginAction(),source=action.registerSettlementSource(async()=>{})
 try{
  committedFactSeqs(await action.captureSubagentStart({type:'subagent/start',version:1,taskId:'task-1',parentSessionId:'parent',agentPath:'root/a',role:'general',description:'work'}).admit())
  committedFactSeqs(await source.delivery.capture({type:'subagent/end',version:1,taskId:'task-1',outcome:'completed',resultRevision:'revision',resultText:'private body',envelope:{version:1,execution:{outcome:'succeeded',dispatch:'dispatched'},preview:'',media:[],retention:{kind:'inline',value:'original result',encodedBytes:17}}}).admit())
  const result=await readManagedTaskResult(domain,'task-1');expect(result).toMatchObject({type:'subagent/end',taskId:'task-1',resultRevision:'revision'});expect(result).not.toHaveProperty('resultText')
  expect(await readManagedTaskResult(domain,'foreign')).toBeUndefined();await expect(readManagedTaskResult({...domain},'task-1')).rejects.toThrow()
  fault.close=true;await expect(readManagedTaskResult(domain,'task-1')).rejects.toThrow('controlled dependency close');await expect(readManagedTaskResult(domain,'task-1')).rejects.toThrow();fault.close=false
 }finally{fault.close=false;await source.close();action.finish();await coordinator.close()}
 await expect(readManagedTaskResult(domain,'task-1')).rejects.toThrow()
})
