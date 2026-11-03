import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {captureManagedTeamParent,createManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import * as provisioning from '../../core-session/src/managed/team-provisioning.ts'

async function fixture(label:string){
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,label)),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'lead'});const execution=await acquireManagedExecution(coordinator,'lead'),domain=createManagedExecutionDomain(execution.identity,execution.owner,{}),parent=captureManagedTeamParent(domain);await parent.ready;void parent.ledger
 const owner=provisioning.createOriginalTeamProvisioningOwner(domain,parent)
 return {coordinator,execution,domain,parent,owner}
}
const member=(sessionId?:string)=>({type:'team/member' as const,version:1 as const,teamId:'team',member:{id:'member',name:'helper',description:'d',provider:'fixture',context:'fresh' as const,phase:'provisioning' as const,...sessionId?{sessionId}:{}}})

it('retains only the original Team owner candidate and acknowledged provisioning action',async()=>{
 const f=await fixture('team-provisioning-'),action=f.execution.owner.beginAction(),candidate=provisioning.reserveOriginalTeamProvisioning(f.owner,action),event=member('member'),capture=action.captureTeamTransaction([event]),outcome=await capture.admit()
 expect(outcome.kind).toBe('committed');expect(()=>provisioning.createOriginalTeamProvisioning(f.owner,candidate,capture,{...outcome})).toThrow();expect(()=>provisioning.createOriginalTeamProvisioning(f.owner,{...candidate},capture,outcome)).toThrow()
 const witness=provisioning.createOriginalTeamProvisioning(f.owner,candidate,capture,outcome)
 try{expect(provisioning.inspectOriginalTeamProvisioning(f.domain,witness).event).toMatchObject(event);expect(()=>provisioning.inspectOriginalTeamProvisioning(f.domain,{...witness})).toThrow();expect(()=>provisioning.inspectOriginalTeamProvisioning({} as typeof f.domain,witness)).toThrow();expect(Object.hasOwn(f.execution.owner,'view')).toBe(false)}finally{await witness.close();await f.parent.close();await f.coordinator.close()}
 expect(()=>provisioning.inspectOriginalTeamProvisioning(f.domain,witness)).toThrow()
})

it('refuses provisioning before writing when no original Team caller is supplied',async()=>{
 const f=await fixture('team-provisioning-owner-'),{createTeamFacts,managedTeamFactOwner}=await import('../src/facts.ts'),{createTeamTransact}=await import('../src/transact.ts')
 const lead=createTeamFacts(managedTeamFactOwner(f.domain),()=>tx.drain(),()=>{},undefined,f.owner),tx=createTeamTransact(lead)
 try{const before=f.execution.observe().eventCount;await expect((tx.transactProvisioning as any)(()=>({events:[member('member')],result:'x'}),undefined)).rejects.toThrow('Original Team caller required');expect(f.execution.observe().eventCount).toBe(before)}finally{await lead.close();await f.parent.close();await f.coordinator.close()}
})

it('does not grant provisioning authority without the stable original target',async()=>{
 const f=await fixture('team-no-stable-target-'),action=f.execution.owner.beginAction(),candidate=provisioning.reserveOriginalTeamProvisioning(f.owner,action),capture=action.captureTeamTransaction([member()]),outcome=await capture.admit()
 try{expect(outcome.kind).toBe('committed');expect(()=>provisioning.createOriginalTeamProvisioning(f.owner,candidate,capture,outcome)).toThrow('provisioning member required')}finally{candidate.abandon();action.finish();await f.parent.close();await f.coordinator.close()}
})

it('refuses replacement of the original Team birth issuer before calling it',async()=>{
 const {createTeammateSpawner}=await import('../src/scheduler/teammate-lifecycle.ts'),{createContext}=await import('@i-harness/core-plugin'),{createToolRegistry}=await import('@i-harness/core-tools'),{createRoleRegistry,createJobRegistry}=await import('@i-harness/subagent'),ctx=createContext();let originalCalls=0,replacedCalls=0
 const sub={roles:createRoleRegistry(),reserveManagedTeamChild(){originalCalls++;throw Error('unexpected original')}},spawner=createTeammateSpawner(ctx,{parentRegistry:createToolRegistry(ctx),parentModel:{async *stream(){yield {type:'end' as const}}}},sub as never,createJobRegistry(),()=>[],{notify(){}},()=>{},()=>{},async()=>{})
 sub.reserveManagedTeamChild=()=>{replacedCalls++;throw Error('unexpected replacement')}
 await expect(spawner('helper','work','fresh',{managed:{caller:{} as never,provisioning:{} as never}})).rejects.toThrow('Original Team birth issuer changed');expect(originalCalls).toBe(0);expect(replacedCalls).toBe(0)
})
