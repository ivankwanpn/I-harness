import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createManagedExecutionDomain,captureManagedTeamParent} from '@i-harness/core-session/internal/execution'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import * as provisioning from '../../core-session/src/managed/team-provisioning.ts'

it('retains only the original acknowledged Team provisioning action and expires it on close',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'team-provisioning-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'lead'});const execution=await acquireManagedExecution(coordinator,'lead'),domain=createManagedExecutionDomain(execution.identity,execution.owner,{}),parent=captureManagedTeamParent(domain);await parent.ready;void parent.ledger;const owner=provisioning.createOriginalTeamProvisioningOwner(domain,parent),action=execution.owner.beginAction(),candidate=provisioning.reserveOriginalTeamProvisioning(owner,action),event={type:'team/member' as const,version:1 as const,teamId:'team',member:{id:'member',sessionId:'member',name:'helper',description:'d',provider:'fixture',context:'fresh' as const,phase:'provisioning' as const}},capture=action.captureTeamTransaction([event]),outcome=await capture.admit()
 expect(outcome.kind).toBe('committed');const create=(provisioning as any).createOriginalTeamProvisioning;expect(create).toBeTypeOf('function')
 expect(()=>create(owner,candidate,capture,{...outcome})).toThrow();expect(()=>create(owner,{...candidate},capture,outcome)).toThrow()
 const witness=create(owner,candidate,capture,outcome)
 const otherParent=captureManagedTeamParent(domain);await otherParent.ready;void otherParent.ledger;const otherOwner=provisioning.createOriginalTeamProvisioningOwner(domain,otherParent)
 try{expect((provisioning as any).inspectOriginalTeamProvisioning(domain,witness).event).toMatchObject(event);expect(()=> (provisioning as any).inspectOriginalTeamProvisioning(domain,{...witness})).toThrow();expect(()=> (provisioning as any).inspectOriginalTeamProvisioning({} as typeof domain,witness)).toThrow();expect(()=>provisioning.assertOriginalTeamProvisioningOwnerWitness(otherOwner,witness)).toThrow();expect(()=>create(owner,candidate,capture,outcome)).toThrow();expect(Object.hasOwn(execution.owner,'view')).toBe(false)}finally{await witness.close();await otherParent.close();await parent.close();await coordinator.close()}
 expect(()=> (provisioning as any).inspectOriginalTeamProvisioning(domain,witness)).toThrow()
})
