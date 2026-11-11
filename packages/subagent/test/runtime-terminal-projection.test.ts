import {it,expect} from 'vitest'
import {createJobRegistry,type JobRegistration} from '../src/jobs.ts'
import {createAgentTable,type ChildAgentEntry} from '../src/agent-table.ts'
import {createSession} from '@i-harness/core-session'
import {persistentAgentTable,persistentJobRegistry,settlePersistentJob,wireSubagentPersistence} from '../src/persist.ts'
import {createRoleRegistry} from '../src/roles.ts'
import {isOriginalRequiredSpawnJob,isOriginalRequiredSpawnEntry} from '../src/tools/source-run.ts'
import {snapshotState} from '../src/persist.ts'
import {captureJobProjection,captureTableProjection,requireJobProjection,captureTaskTableProjection} from '../src/runtime-projection.ts'
import {createTaskRegistry} from '../src/task/registry.ts'
function terminal(outcome:'completed'|'cancelled'|'error'='cancelled'){
 const tasks=createTaskRegistry(),task=tasks.submit({identity:{parentSessionId:'parent'},agentPath:'root/one',description:'one',prompt:'work',agent:'general',delivery:'tool'});tasks.terminalize({taskId:task.id,outcome,...(outcome==='completed'?{resultText:'late success'}:{error:'original terminal'})});return task
}
function entry():ChildAgentEntry{return{path:'root/one',status:'running',session:createSession(),controller:new AbortController(),mailbox:[]}}
it('projects the exact original uncancellable job receipt once and keeps public cancellation shape',async()=>{
 const original=createJobRegistry();let saves=0,captured:JobRegistration|undefined;const jobs=persistentJobRegistry(original,async()=>{saves++})
 const returned=jobs.registerJob('root','subagent','one',undefined,undefined,undefined,{agentPath:'root/one'},receipt=>{captured=receipt;expect(captureJobProjection(receipt)).toBeTypeOf('function')})
 expect(returned.finish).toBeUndefined();const before=saves,project=captureJobProjection(captured!),task=terminal()
 const first=project(task);expect(project(task)).toBe(first);await first;expect(jobs.read(returned.id).status).toBe('killed');expect(saves).toBe(before+1);expect(()=>captureJobProjection({...captured!})).toThrow()
})
it('refuses a foreign table entry before mutation or persistence and never resurrects it',async()=>{
 const original=createAgentTable();let saves=0;const table=persistentAgentTable(original,async()=>{saves++}),actual=entry();table.add(actual.path,actual);const project=captureTableProjection(table,actual),foreign=entry();table.add(foreign.path,foreign);const before=saves
 await expect(project(terminal())).rejects.toThrow('entry replaced');expect(table.get(actual.path)).toBe(foreign);expect(foreign.status).toBe('running');expect(actual.status).toBe('running');expect(saves).toBe(before)
})
it('keeps a late Stop winner in the original job and entry instead of publishing success',async()=>{
 const jobs=createJobRegistry(),registration=jobs.registerJob('root','subagent','one',undefined,undefined,undefined,{agentPath:'root/one'}),table=createAgentTable(),actual=entry();table.add(actual.path,actual)
 const job=captureJobProjection(registration),agent=captureTableProjection(table,actual);jobs.kill(registration.id);table.update(actual.path,actual,{status:'killed',error:'Stop won'});await Promise.all([job(terminal('completed')),agent(terminal('completed'))]);expect(jobs.read(registration.id).status).toBe('killed');expect(jobs.read(registration.id).output).toBe('');expect(actual.status).toBe('killed');expect(actual.finalText).toBeUndefined();expect(actual.error).toBe('Stop won')
})
it('retains the exact acquired receipt before a throwing publication callback and preserves original save failure',async()=>{
 const original=createJobRegistry();let captured:JobRegistration|undefined,saves=0;const cause=false,jobs=persistentJobRegistry(original,async()=>{saves++;throw cause})
 let threw=false;try{jobs.registerJob('root','subagent','one',undefined,undefined,undefined,{agentPath:'root/one'},registration=>{captured=registration;throw cause})}catch(error){threw=true;expect(error).toBe(cause)}expect(threw).toBe(true)
 const project=captureJobProjection(captured!),first=project(terminal('error'));await expect(first).rejects.toBe(cause);expect(project(terminal('error'))).toBe(first);expect(saves).toBe(1);expect(original.read(captured!.id).status).toBe('error')
})

it('retains the persistent producer before a post-acquire observer failure',()=>{
 const original=createJobRegistry(),cause=new Error('publication failed');let captured:JobRegistration|undefined,saves=0,observations=0
 const jobs=persistentJobRegistry(original,async()=>{saves++},()=>{if(++observations===1)throw cause})
 expect(()=>jobs.registerJob('root','code','one',undefined,undefined,()=>{},undefined,receipt=>{captured=receipt})).toThrow(cause)
 expect(captured?.finish).toBeTypeOf('function');expect(captured!.finish!('error','failed')).toBe(true)
 expect(original.read(captured!.id).status).toBe('error');expect(observations).toBe(2);expect(saves).toBe(1)
})

it('retains the exact persistent terminal save and never replays it after failure',async()=>{
 const raw=createJobRegistry(),cause=new Error('save unavailable');let saves=0,observed=0
 const jobs=persistentJobRegistry(raw,async()=>{if(++saves===2)throw cause},()=>{observed++}),receipt=jobs.registerJob('root','index','index',undefined,undefined,()=>{})
 const first=settlePersistentJob(receipt,'error','original failure');await expect(first).rejects.toBe(cause)
 expect(settlePersistentJob(receipt,'error','original failure')).toBe(first);await expect(settlePersistentJob(receipt,'completed','other')).rejects.toThrow('changed')
 expect(saves).toBe(2);expect(observed).toBe(2);expect(raw.read(receipt.id)).toMatchObject({status:'error',output:'original failure'});await expect(settlePersistentJob({...receipt},'error','original failure')).rejects.toThrow('Original persistent job required')
})

it('refuses changed original registration fields before terminal mutation or a save',async()=>{
 const original=createJobRegistry();let saves=0,receipt:JobRegistration|undefined;const jobs=persistentJobRegistry(original,async()=>{saves++});jobs.registerJob('root','subagent','one',undefined,undefined,undefined,{agentPath:'root/one'},registration=>{receipt=registration});const project=captureJobProjection(receipt!),id=receipt!.id,before=saves;receipt!.id='foreign'
 expect(()=>project(terminal())).toThrow('registration changed');expect(original.read(id).status).toBe('running');expect(saves).toBe(before);receipt!.id=id
})

it('does not turn an unproved producer outcome into terminal job or body success',async()=>{
 const tasks=createTaskRegistry(),task=tasks.submit({identity:{parentSessionId:'parent'},agentPath:'root/one',description:'one',prompt:'work',agent:'general',delivery:'tool'});tasks.terminalize({taskId:task.id,outcome:'recovery-required',recoveryReason:'dispatch-unknown'})
 const jobs=createJobRegistry(),registration=jobs.registerJob('root','subagent','one',undefined,undefined,undefined,{agentPath:'root/one'}),table=createAgentTable(),actual=entry();table.add(actual.path,actual)
 await expect(captureJobProjection(registration)(task)).rejects.toThrow('outcome unavailable');await expect(captureTableProjection(table,actual)(task)).rejects.toThrow('outcome unavailable');expect(jobs.read(registration.id).status).toBe('running');expect(jobs.read(registration.id).result).toBeUndefined();expect(actual.status).toBe('running');expect(actual.finalText).toBeUndefined()
})

it.each(['before-io','unknown-after-io'])('isolates canonical required Task projection from auxiliary %s failure',async phase=>{
 const rawJobs=createJobRegistry(),rawTable=createAgentTable();let writes=0,current=0,armed=false
 const save=async()=>{writes++;if(!armed)return;if(phase==='unknown-after-io')await Promise.resolve();throw Error(phase)}
 const jobs=persistentJobRegistry(rawJobs,save),table=persistentAgentTable(rawTable,save),actual=entry()
 // Mount-time snapshots are independent attempts. Capture their original
 // rejection without turning this focused terminal test into an IO probe.
 table.add(actual.path,actual)
 let registration:JobRegistration|undefined
 jobs.registerJob('root','subagent','one',undefined,undefined,undefined,{agentPath:actual.path},receipt=>{registration=receipt})
 await Promise.resolve();armed=true;const before=writes
 const check=()=>{current++},job=requireJobProjection(registration!,check,async()=>{}),agent=captureTaskTableProjection(table,actual,check)
 const task=terminal('error')
 await Promise.all([job(task),agent(task)])
 expect(writes).toBe(before);expect(current).toBeGreaterThan(0)
 expect(rawJobs.read(registration!.id).status).toBe('error');expect(actual.status).toBe('error')
 // Ordinary projections still own their exact original failure.
 await expect(captureJobProjection(registration!)(task)).rejects.toThrow(phase)
 expect(writes).toBe(before+1)
})

it('retains auxiliary save failures in their own mount flush and cleanup without repeating the save',async()=>{
 let writes=0
 const cause=Error('Original auxiliary projection unavailable')
 const wired=wireSubagentPersistence({jobs:createJobRegistry(),table:createAgentTable(),roles:createRoleRegistry()},{
  coordinator:{async putDocument(){writes++;throw cause}} as unknown as Parameters<typeof wireSubagentPersistence>[1]['coordinator'],
  stateId:'auxiliary',parentSessionId:'parent',
 })
 wired.jobs.registerJob('root','code','ordinary')
 await expect(wired.flushFacts()).rejects.toThrow('Auxiliary subagent projections require recovery')
 await expect(wired.flushFacts()).rejects.toThrow('Auxiliary subagent projections require recovery')
 await expect(wired.closeFacts()).rejects.toThrow('Subagent projection cleanup unresolved')
 expect(writes).toBe(1)
})

it('never selects Task cache omission from an ordinary receipt, copied identity or projection shape',async()=>{
 let writes=0
 const rawJobs=createJobRegistry(),jobs=persistentJobRegistry(rawJobs,async()=>{writes++})
 const receipt=jobs.registerJob('root','subagent','ordinary',undefined,undefined,undefined,{agentPath:'root/one'})
 requireJobProjection(receipt)
 expect(isOriginalRequiredSpawnJob(receipt)).toBe(false)
 expect(isOriginalRequiredSpawnJob({...receipt})).toBe(false)
 const rawTable=createAgentTable(),table=persistentAgentTable(rawTable,async()=>{writes++}),actual={...entry(),taskId:'forged-task'}
 captureTaskTableProjection(table,actual)
 expect(isOriginalRequiredSpawnEntry(actual)).toBe(false)
 expect(isOriginalRequiredSpawnEntry({...actual})).toBe(false)
 table.add(actual.path,actual)
 expect(writes).toBe(2)
 const before=snapshotState({jobs:rawJobs,table:rawTable,roles:createRoleRegistry()})
 table.update(actual.path,actual,{closing:true})
 expect(snapshotState({jobs:rawJobs,table:rawTable,roles:createRoleRegistry()})).toEqual(before)
 expect(writes).toBe(2)
})

it.each(['mailbox','followup','custom-role'])('preserves required %s persistence and its original failure',async mode=>{
 let armed=false,writes=0
 const wired=wireSubagentPersistence({jobs:createJobRegistry(),table:createAgentTable(),roles:createRoleRegistry()},{
  coordinator:{async putDocument(){writes++;if(armed)throw Error('required '+mode)}} as unknown as Parameters<typeof wireSubagentPersistence>[1]['coordinator'],stateId:'required',parentSessionId:'parent',
 })
 const actual={...entry(),taskId:'copied-task-id'}
 if(mode==='followup'){wired.table.add(actual.path,actual);await wired.flushFacts()}
 armed=true
 if(mode==='mailbox'){actual.mailbox.push('unconsumed');wired.table.add(actual.path,actual)}
 else if(mode==='followup')wired.table.update(actual.path,actual,{lastInboxSeq:7,finalText:'new followup result',status:'waiting'})
 else wired.roles.register({name:'custom',description:'durable configuration',systemPrompt:'custom instructions',tools:[]})
 await expect(wired.flushFacts()).rejects.toThrow('Auxiliary subagent projections require recovery')
 await expect(wired.closeFacts()).rejects.toThrow('Subagent projection cleanup unresolved')
 expect(writes).toBe(mode==='followup'?2:1)
})
