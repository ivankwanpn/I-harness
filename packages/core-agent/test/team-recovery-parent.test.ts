import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext} from '@i-harness/core-plugin'
import {captureManagedTeamParent,createOriginalTeamProvisioningOwner,reserveOriginalTeamRecoveryParent,assertOriginalTeamRecoveryParent} from '@i-harness/core-session/internal/execution'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {createManagedAgentModelOriginOwner} from '../src/tool-batch/model-origin.ts'

it('issues a new same-owner Team prefix lease after each committed member change',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'team-recovery-parent-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'parent'});const execution=await acquireManagedExecution(coordinator,'parent'),origin=createManagedAgentModelOriginOwner(createContext(),execution),mounted=captureManagedTeamParent(origin.domain);await mounted.ready;void mounted.ledger;const owner=createOriginalTeamProvisioningOwner(origin.domain,mounted)
 let first:ReturnType<typeof reserveOriginalTeamRecoveryParent>|undefined,second:ReturnType<typeof reserveOriginalTeamRecoveryParent>|undefined,foreign:ReturnType<typeof captureManagedTeamParent>|undefined
 try{first=reserveOriginalTeamRecoveryParent(owner);await first.ready;void first.ledger;assertOriginalTeamRecoveryParent(owner,first);first.assertInitialPrefix();expect(()=>assertOriginalTeamRecoveryParent(owner,{...first!})).toThrow();foreign=captureManagedTeamParent(origin.domain);await foreign.ready;void foreign.ledger;const foreignOwner=createOriginalTeamProvisioningOwner(origin.domain,foreign);expect(()=>assertOriginalTeamRecoveryParent(foreignOwner,first!)).toThrow()
  const action=execution.owner.beginAction();try{const capture=action.captureTeamTransaction([{type:'team/member',version:1,teamId:'team',member:{id:'one',sessionId:'one',name:'one',description:'',provider:'spawn',context:'fresh',phase:'provisioning'}}]);expect((await capture.admit()).kind).toBe('committed')}finally{action.finish()}
  expect(()=>first!.assertInitialPrefix()).toThrow('prefix changed');second=reserveOriginalTeamRecoveryParent(owner);await second.ready;assertOriginalTeamRecoveryParent(owner,second);expect(second.ledger.some(event=>event.type==='team/member'&&event.member.id==='one')).toBe(true);second.assertInitialPrefix()
 }finally{await second?.close();await first?.close();await foreign?.close();await mounted.close();await coordinator.close()}
},30000)
