import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext} from '@i-harness/core-plugin'
import {createToolRegistry} from '@i-harness/core-tools'
import {createManagedExecutionDomain,captureManagedTeamParent,inspectOriginalTeamDelivery} from '@i-harness/core-session/internal/execution'
import {createAgentTable,createJobRegistry,createRoleRegistry} from '@i-harness/subagent'
import {createAgentRegistry} from '@i-harness/core-agent'
import {registerExec} from '@i-harness/exec'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {mountAgentTeams} from '../src/scheduler.ts'

it('retains original Team lead evidence and refuses an unbranded admission receipt',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'team-delivery-evidence-')),backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'lead'});const execution=await acquireManagedExecution(coordinator,'lead'),ctx=createContext(),domain=createManagedExecutionDomain(execution.identity,execution.owner,ctx),seed=domain.owner.beginAction()
 try{const base={id:'member',name:'helper',description:'d',provider:'fixture',context:'fresh' as const};expect((await seed.captureTeamTransaction([{type:'team/member',version:1,teamId:'team',member:{...base,phase:'provisioning'}},{type:'team/member',version:1,teamId:'team',member:{...base,phase:'active',sessionId:'child'}}]).admit()).kind).toBe('committed')}finally{seed.finish()}
 const parent=captureManagedTeamParent(domain);await parent.ready;const tools=createToolRegistry(ctx),exec=registerExec(ctx);let evidence:object|undefined,wakes=0,calls=0
 const notify={async admit(){throw Error('generic admission must not run')},async admitTeamDelivery(value:object){calls++;evidence=value;expect(()=>inspectOriginalTeamDelivery(domain,value as never)).not.toThrow();return {} as never},wake(){wakes++}}
 const handle=await mountAgentTeams(ctx,tools,{managedParent:{domain,parent},parentRegistry:tools,parentNotify:notify,subagents:{table:createAgentTable(),jobs:createJobRegistry(),roles:createRoleRegistry(),agents:createAgentRegistry(),exec,resolveModel:async()=>({status:'unconfigured',reason:'unused'}),childSessions:{coordinator,parentSessionId:'lead'}},parentModel:{async *stream(){yield {type:'end' as const}}}})
 try{const result=await tools.get('send_message')!.execute({target:'lead',message:'one original message'},{sessionId:'child'}) as {messageId:string;status:string};expect(result.status).toBe('queued');expect(calls).toBe(1);expect(wakes).toBe(0);expect(parent.hasInbox(result.messageId)).toBe(true);await handle.drainLeadMessages!();expect(calls).toBe(2);expect(wakes).toBe(0);const events=(await backend.read('lead')).events;expect(events.filter(event=>event.type==='subagent/inbox'&&event.messageId===result.messageId)).toHaveLength(1);expect(events.filter(event=>event.type==='team/message/delivered'&&event.messageId===result.messageId)).toHaveLength(0)}finally{await handle.unmount();await exec.dispose();await coordinator.close()}
 expect(evidence).toBeDefined();expect(()=>inspectOriginalTeamDelivery(domain,evidence as never)).toThrow()
},30000)
import {receivedExecutionInputsFor} from '../../session-executor/src/lifecycle/execution-inputs.ts'

it('admits one genuine mounted-Team lead message through its original recipient',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'team-delivery-recipient-')),backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'lead'});const execution=await acquireManagedExecution(coordinator,'lead'),ctx=createContext(),domain=createManagedExecutionDomain(execution.identity,execution.owner,ctx),inputs=receivedExecutionInputsFor(execution),recipient=inputs.taskDelivery(domain)
 await inputs.inbox.admit({inputId:'human-one',text:'hello',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'session.prompt'}})
 const seed=domain.owner.beginAction();try{const base={id:'member',name:'helper',description:'d',provider:'fixture',context:'fresh' as const};expect((await seed.captureTeamTransaction([{type:'team/member',version:1,teamId:'team',member:{...base,phase:'provisioning'}},{type:'team/member',version:1,teamId:'team',member:{...base,phase:'active',sessionId:'child'}}]).admit()).kind).toBe('committed')}finally{seed.finish()}
 const parent=captureManagedTeamParent(domain);await parent.ready;const tools=createToolRegistry(ctx),exec=registerExec(ctx);let wakes=0,inputId=''
 const notify={async admit(){throw Error('generic admission must not run')},async admitTeamDelivery(evidence:Parameters<typeof recipient.admitTeam>[0]){const receipt=await recipient.admitTeam(evidence);inputId=receipt.inputId;return receipt},wake(){wakes++}}
 const handle=await mountAgentTeams(ctx,tools,{managedParent:{domain,parent},parentRegistry:tools,parentNotify:notify,subagents:{table:createAgentTable(),jobs:createJobRegistry(),roles:createRoleRegistry(),agents:createAgentRegistry(),exec,resolveModel:async()=>({status:'unconfigured',reason:'unused'}),childSessions:{coordinator,parentSessionId:'lead'}},parentModel:{async *stream(){yield {type:'end' as const}}}})
 try{const result=await tools.get('send_message')!.execute({target:'lead',message:'one original message'},{sessionId:'child'}) as {messageId:string;status:string};expect(result.status).toBe('accepted');expect(inputId).toBeTruthy();expect(execution.observe().inbox.isExecutable(inputId)).toBe(true);expect(wakes).toBe(0);await handle.drainLeadMessages!();const events=(await backend.read('lead')).events;expect(events.filter(event=>event.type==='subagent/inbox'&&event.messageId===result.messageId)).toHaveLength(1);expect(events.filter(event=>event.type==='team/message/delivered'&&event.messageId===result.messageId)).toHaveLength(1);expect(events.filter(event=>event.type==='agent/input/admitted'&&event.inputId===inputId)).toHaveLength(1)}finally{await handle.unmount();await inputs.close();await exec.dispose();await coordinator.close()}
},30000)
