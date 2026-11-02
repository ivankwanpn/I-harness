import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {createManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
import * as facts from '../src/facts.ts'
import {createTeamTransact} from '../src/transact.ts'

it('uses only the original managed owner for team fact transactions',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-team-facts-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'lead'});const execution=await acquireManagedExecution(coordinator,'lead'),domain=createManagedExecutionDomain(execution.identity,execution.owner,{})
 const factory=(facts as any).managedTeamFactOwner;expect(factory).toBeTypeOf('function');expect(()=>factory({...domain})).toThrow()
 const original=factory(domain),lead=facts.createTeamFacts(original,()=>tx.drain(),()=>{}),tx=createTeamTransact(lead)
 try{await tx.transact(()=>({events:[{type:'team/member',version:1,teamId:'t',member:{id:'one',name:'one',description:'',provider:'fixture',context:'fresh',phase:'provisioning'}}],result:undefined}));expect(Object.hasOwn(execution.owner,'view')).toBe(false);execution.revokeNewWork();expect(()=>original.beginAction()).toThrow()}finally{await lead.close();await coordinator.close()}
})

it('restores the same Team fold from a supplied original ledger without a Session',async()=>{
 const admission=await import('../src/scheduler/admission.ts'),ledger=[{type:'team/member',version:1,teamId:'saved',member:{id:'one',name:'one',description:'d',provider:'p',context:'fresh',phase:'provisioning'}}] as const
 const create=(admission as any).admitTeamFromLedger;expect(create).toBeTypeOf('function');const result=create(false,ledger);try{expect(result.teamId).toBe('saved');expect(result.state.members.get('one')?.id).toBe('one')}finally{admission.releaseTeam(result.teamId)}
})

it('commits a Team message and acknowledgement through the same private owner',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-team-message-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'lead'});const execution=await acquireManagedExecution(coordinator,'lead'),domain=createManagedExecutionDomain(execution.identity,execution.owner,{})
 const {createFoldState}=await import('../src/fold.ts'),{createMailbox}=await import('../src/mailbox.ts'),state=createFoldState();state.members.set('helper',{id:'child',name:'helper',description:'',provider:'fixture',context:'fresh',phase:'active'})
 const lead=facts.createTeamFacts((facts as any).managedTeamFactOwner(domain),()=>tx.drain(),()=>{}),tx=createTeamTransact(lead,state)
 let delivered=0;const mailbox=createMailbox({teamId:'team',state,transact:tx,deliver:async()=>{delivered++;return {kind:'consumed',via:'target',sendFailure:{occurred:false}}},memberStatus:()=> 'idle',maxPendingMessagesPerMember:64})
 try{const result=await mailbox.sendMessage({id:'team',name:'lead',role:'lead'},'helper','hello','quiet');expect(result.status).toBe('accepted');expect(delivered).toBe(1);expect(state.delivered.has(result.messageId)).toBe(true);expect(Object.hasOwn(execution.owner,'view')).toBe(false)}finally{await lead.close();await coordinator.close()}
})

it('delivers an original Team message to the managed lead once and fences Stop',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-team-inbox-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'lead'});const execution=await acquireManagedExecution(coordinator,'lead'),domain=createManagedExecutionDomain(execution.identity,execution.owner,{})
 const core=await import('@i-harness/core-session/internal/execution'),parent=core.captureManagedTeamParent(domain);await parent.ready
 const {createTaskDelivery}=await import('../src/scheduler/task-delivery.ts'),{createFoldState}=await import('../src/fold.ts'),{createAgentTable,createJobRegistry}=await import('@i-harness/subagent'),{createAgentRegistry}=await import('@i-harness/core-agent')
 const state=createFoldState(),jobs=createJobRegistry(),original=facts.managedTeamFactOwner(domain,()=>parent.assertCurrent()),deliver=createTaskDelivery('team',state,{managedParent:{domain,parent}},{table:createAgentTable(),agents:createAgentRegistry(),jobs},jobs,{notify(){}},()=>false,original)
 try{const before=execution.observe().eventCount;expect(await deliver('team','message-1','hello','quiet')).toMatchObject({kind:'consumed'});expect(parent.hasInbox('message-1')).toBe(true);expect(await deliver('team','message-1','hello','quiet')).toMatchObject({kind:'consumed'});expect(execution.observe().eventCount).toBe(before+1);execution.revokeNewWork();await expect(deliver('team','message-2','late','quiet')).rejects.toThrow()}finally{await parent.close();await coordinator.close()}
})

it('mounts the original managed Team ledger and completes a lead message before Stop',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-team-mount-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'lead'});const execution=await acquireManagedExecution(coordinator,'lead'),{createContext}=await import('@i-harness/core-plugin'),ctx=createContext(),domain=createManagedExecutionDomain(execution.identity,execution.owner,ctx)
 const seed=domain.owner.beginAction();try{const base={id:'member-1',name:'helper',description:'d',provider:'fixture',context:'fresh' as const};const outcome=await seed.captureTeamTransaction([{type:'team/member',version:1,teamId:'team',member:{...base,phase:'provisioning'}},{type:'team/member',version:1,teamId:'team',member:{...base,phase:'active',sessionId:'child'}}]).admit();expect(outcome.kind).toBe('committed')}finally{seed.finish()}
 const core=await import('@i-harness/core-session/internal/execution'),parent=core.captureManagedTeamParent(domain);await parent.ready
 const {createToolRegistry}=await import('@i-harness/core-tools'),{createAgentTable,createJobRegistry,createRoleRegistry}=await import('@i-harness/subagent'),{createAgentRegistry}=await import('@i-harness/core-agent'),{registerExec}=await import('@i-harness/exec'),{mountAgentTeams}=await import('../src/scheduler.ts')
 const tools=createToolRegistry(ctx),handle=await mountAgentTeams(ctx,tools,{managedParent:{domain,parent},parentRegistry:tools,subagents:{table:createAgentTable(),jobs:createJobRegistry(),roles:createRoleRegistry(),agents:createAgentRegistry(),exec:registerExec(ctx),resolveModel:async()=>({status:'unconfigured',reason:'unused'}),childSessions:{coordinator,parentSessionId:'lead'}},parentModel:{async *stream(){yield {type:'end' as const}}}})
 try{expect(handle.teamName).toBe('team');const result=await tools.get('send_message')!.execute({target:'lead',message:'actual managed message'},{sessionId:'child'});expect(result).toMatchObject({status:'accepted'});expect(parent.hasInbox((result as {messageId:string}).messageId)).toBe(true);expect(Object.hasOwn(execution.owner,'view')).toBe(false);execution.revokeNewWork();await expect(Promise.resolve().then(()=>tools.get('send_message')!.execute({target:'lead',message:'after stop'},{sessionId:'child'}))).rejects.toThrow()}finally{await handle.unmount();await coordinator.close()}
},30000)

it('does not classify a managed pending Team target from an ordinary snapshot miss',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-team-pending-')),backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'lead'});const execution=await acquireManagedExecution(coordinator,'lead'),{createContext}=await import('@i-harness/core-plugin'),ctx=createContext(),domain=createManagedExecutionDomain(execution.identity,execution.owner,ctx),action=domain.owner.beginAction()
 try{expect((await action.captureTeamTransaction([{type:'team/member',version:1,teamId:'team',member:{id:'child',sessionId:'child',name:'helper',description:'d',provider:'spawn',context:'fresh',phase:'provisioning'}}]).admit()).kind).toBe('committed')}finally{action.finish()}
 const core=await import('@i-harness/core-session/internal/execution'),parent=core.captureManagedTeamParent(domain);await parent.ready
 const {createToolRegistry}=await import('@i-harness/core-tools'),{createAgentTable,createJobRegistry,createRoleRegistry}=await import('@i-harness/subagent'),{createAgentRegistry}=await import('@i-harness/core-agent'),{registerExec}=await import('@i-harness/exec'),{mountAgentTeams}=await import('../src/scheduler.ts'),tools=createToolRegistry(ctx);let handle:Awaited<ReturnType<typeof mountAgentTeams>>|undefined
 try{await expect(mountAgentTeams(ctx,tools,{managedParent:{domain,parent},parentRegistry:tools,subagents:{table:createAgentTable(),jobs:createJobRegistry(),roles:createRoleRegistry(),agents:createAgentRegistry(),exec:registerExec(ctx),resolveModel:async()=>({status:'unconfigured',reason:'unused'}),childSessions:{coordinator,parentSessionId:'lead'}},parentModel:{async *stream(){yield {type:'end' as const}}}}).then(value=>{handle=value;return value})).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'});const events=(await backend.read('lead')).events;expect(events.filter(event=>event.type==='team/member')).toHaveLength(1)}finally{await handle?.unmount();await parent.close();await coordinator.close()}
},30000)
