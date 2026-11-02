import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext} from '@i-harness/core-plugin'
import {createToolRegistry} from '@i-harness/core-tools'
import {createManagedExecutionDomain,captureManagedTeamParent} from '@i-harness/core-session/internal/execution'
import {createAgentTable,createJobRegistry,createRoleRegistry} from '@i-harness/subagent'
import {createAgentRegistry} from '@i-harness/core-agent'
import {registerExec} from '@i-harness/exec'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {mountAgentTeams,createOriginalTeamRecoveryPort,type TeamMountHandle} from '../src/scheduler.ts'

it('closes the captured original Team mount after exposed methods change and owner retires',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'team-port-cleanup-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'lead'});const execution=await acquireManagedExecution(coordinator,'lead'),ctx=createContext(),domain=createManagedExecutionDomain(execution.identity,execution.owner,ctx),parent=captureManagedTeamParent(domain);await parent.ready
 const tools=createToolRegistry(ctx),exec=registerExec(ctx);let port:ReturnType<typeof createOriginalTeamRecoveryPort>|undefined,handle:TeamMountHandle|undefined,substituteCalls=0
 try{
  await mountAgentTeams(ctx,tools,{retainMount(original){handle=original;port=createOriginalTeamRecoveryPort(domain,original)},managedParent:{domain,parent},parentRegistry:tools,subagents:{table:createAgentTable(),jobs:createJobRegistry(),roles:createRoleRegistry(),agents:createAgentRegistry(),exec,resolveModel:async()=>({status:'unconfigured',reason:'unused'})},parentModel:{async *stream(){yield {type:'end' as const}}}})
  expect(tools.get('send_message')).toBeDefined();handle!.resumeRecovery=async()=>{substituteCalls++};handle!.unmount=async()=>{substituteCalls++}
  await expect(port!.resume()).rejects.toThrow('Original Team mount changed');execution.revokeNewWork();await port!.close();await port!.close()
  expect(substituteCalls).toBe(0);expect(tools.get('send_message')).toBeUndefined();expect(()=>parent.assertCurrent()).toThrow()
 }finally{await port?.close();await exec.dispose();await coordinator.close()}
},30000)
