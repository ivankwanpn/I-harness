import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createContext} from '@i-harness/core-plugin'
import {createManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
import {createContextOutputService} from '@i-harness/context-output'
import {createExecutionLease} from '@i-harness/sandbox'
import {compileExecutionPolicy} from '@i-harness/sandbox-policy'
import {createExecServiceWithReservation,createWorkflowStepFactory} from '../../exec/src/service.ts'
import {createWorkflowExecutor,createWorkflowJobStore} from '../../workflow/src/runner.ts'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {createWorkflowResultRetention} from '../src/lifecycle/workflow-result-retention.ts'

it('retains only the exact clean original Workflow completion through its held private source',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'workflow-retention-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(join(root,'sessions')),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const execution=await acquireManagedExecution(coordinator,'main'),domain=createManagedExecutionDomain(execution.identity,execution.owner,createContext()),action=execution.owner.beginAction(),source=action.registerSettlementSource(async()=>{}),output=createContextOutputService({root:join(root,'results'),workspaceId:'fixture'})
 const pair=createExecServiceWithReservation({execution:{defaultOwner:{sessionId:'main'},resolvePolicy:owner=>compileExecutionPolicy({mode:'danger-full-access',owner,authority:{kind:'unbound',revision:'r',workspaceRoot:resolve(root)}}),validateAuthority(){},selectBackend:()=>({async probe(){return{id:'controlled',availability:'available',assurance:'unverified',features:{writeIsolation:false,readIsolation:false,denyPaths:false,pipes:true,pty:false,retainedTree:true}}},async prepare(spec,policy){return{policy,async rollback(){},async commit(check){check();const lease=createExecutionLease({receipt:{executionId:'actual',backendId:'controlled',policyFingerprint:policy.fingerprint,owner:spec.owner,assurance:'unverified'},rootExited:Promise.resolve({exitCode:0}),async waitTreeEmpty(){},async settleIo(){},async releaseResources(){},async terminate(){}});return {...lease,get settled(){return lease.settled},pid:1,io:{async write(){},async endInput(){},output:(async function*(){yield {channel:'stdout' as const,data:Buffer.from('original output')}})()}}}}}})}})
 try{const run=createWorkflowExecutor({exec:pair.service,steps:createWorkflowStepFactory(pair,c=>c),jobs:createWorkflowJobStore()}).runWorkflow({name:'w',description:'w',steps:[{name:'one',command:'controlled'}]},undefined,'main'),completion=await run.join(),retain=createWorkflowResultRetention({service:output,domain,sourceFor:async()=>({sourceId:'original-source'})});expect(()=>retain({...run},completion,source,'call')).toThrow();expect(()=>retain(run,{...completion},source,'call')).toThrow();expect(()=>retain(run,completion,{...source},'call')).toThrow();const retained=retain(run,completion,source,'call');expect(()=>retain(run,completion,source,'call')).toThrow();const settled=await retained.settle();expect(settled).toMatchObject({kind:'ready',envelope:{retention:{kind:'artifact',ref:{codec:'json-utf8-v1'}}}});await source.close();expect(()=>retained.settle()).toThrow()}finally{action.finish();await source.close().catch(()=>{});await pair.service.dispose();await execution.close();await output.close();await coordinator.close()}
},30000)
