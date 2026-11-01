import {it,expect} from 'vitest'
import {createJobRegistry,type JobRegistration} from '../src/jobs.ts'
import {createAgentTable,type ChildAgentEntry} from '../src/agent-table.ts'
import {createSession} from '@i-harness/core-session'
import {persistentAgentTable,persistentJobRegistry} from '../src/persist.ts'
import {captureJobProjection,captureTableProjection} from '../src/runtime-projection.ts'
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

it('refuses changed original registration fields before terminal mutation or a save',async()=>{
 const original=createJobRegistry();let saves=0,receipt:JobRegistration|undefined;const jobs=persistentJobRegistry(original,async()=>{saves++});jobs.registerJob('root','subagent','one',undefined,undefined,undefined,{agentPath:'root/one'},registration=>{receipt=registration});const project=captureJobProjection(receipt!),id=receipt!.id,before=saves;receipt!.id='foreign'
 expect(()=>project(terminal())).toThrow('registration changed');expect(original.read(id).status).toBe('running');expect(saves).toBe(before);receipt!.id=id
})

it('does not turn an unproved producer outcome into terminal job or body success',async()=>{
 const tasks=createTaskRegistry(),task=tasks.submit({identity:{parentSessionId:'parent'},agentPath:'root/one',description:'one',prompt:'work',agent:'general',delivery:'tool'});tasks.terminalize({taskId:task.id,outcome:'recovery-required',recoveryReason:'dispatch-unknown'})
 const jobs=createJobRegistry(),registration=jobs.registerJob('root','subagent','one',undefined,undefined,undefined,{agentPath:'root/one'}),table=createAgentTable(),actual=entry();table.add(actual.path,actual)
 await expect(captureJobProjection(registration)(task)).rejects.toThrow('outcome unavailable');await expect(captureTableProjection(table,actual)(task)).rejects.toThrow('outcome unavailable');expect(jobs.read(registration.id).status).toBe('running');expect(jobs.read(registration.id).result).toBeUndefined();expect(actual.status).toBe('running');expect(actual.finalText).toBeUndefined()
})
