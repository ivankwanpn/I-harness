import {expect,it} from 'vitest'
import {createJobRegistry,createAgentTable} from '@i-harness/subagent'
import {persistentJobRegistry} from '../../subagent/src/persist.ts'
import {createOwnedIndexJobs} from '../src/owned-index-jobs.ts'

it('retains original job cancellation and joins producer completion before cleanup',async()=>{
 const cleanups:Array<()=>void|Promise<void>>=[],jobs=persistentJobRegistry(createJobRegistry(),async()=>{}),table=createAgentTable();let current=true,cancelled=0
 const original={domain:{sessionId:'main'},assertCurrent(){if(!current)throw Error('retired')},retain(cleanup:()=>void|Promise<void>){cleanups.push(cleanup)}} as any
 const owner=createOwnedIndexJobs(original,{jobs,table} as any),cancel=()=>{cancelled++}
 const job=owner.register({id:'index',kind:'code-context',label:'index',cancel})
 expect(owner.owns('main')).toBe(true);expect(jobs.read('index').status).toBe('running')
 expect(owner.register({id:'index',kind:'code-context',label:'index',cancel}).finish).toBe(job.finish)
 let finished=false;const closing=Promise.resolve(cleanups[0]!()).then(()=>{finished=true});await Promise.resolve();expect(cancelled).toBe(1);expect(finished).toBe(false)
 job.finish('killed','cancelled');await closing;expect(jobs.read('index').status).toBe('killed');expect(()=>owner.register({id:'next',kind:'code-context',label:'index',cancel})).toThrow(/unavailable/);current=false
})

it('retains and terminates a registration when the wrapper throws after acquisition',()=>{
 const real=persistentJobRegistry(createJobRegistry(),async()=>{}),table=createAgentTable(),cleanups:Array<()=>void|Promise<void>>=[]
 const original={domain:{sessionId:'main'},assertCurrent(){},retain(cleanup:()=>void|Promise<void>){cleanups.push(cleanup)}} as any
 const jobs={...real,registerJob(...args:Parameters<typeof real.registerJob>){real.registerJob(...args);throw Error('post-acquire failure')}}
 const owner=createOwnedIndexJobs(original,{jobs,table} as any)
 expect(()=>owner.register({id:'failed',kind:'code-context',label:'index',cancel(){}})).toThrow('post-acquire failure')
 expect(real.read('failed').status).toBe('error')
})

it('retains the original failed terminal save as cleanup debt without replay',async()=>{
 let saves=0,fail=false;const real=persistentJobRegistry(createJobRegistry(),async()=>{saves++;if(fail)throw Error('save uncertain')}),table=createAgentTable(),cleanups:Array<()=>void|Promise<void>>=[]
 const original={domain:{sessionId:'main'},assertCurrent(){},retain(cleanup:()=>void|Promise<void>){cleanups.push(cleanup)}} as any,owner=createOwnedIndexJobs(original,{jobs:real,table} as any)
 const job=owner.register({id:'held',kind:'code-context',label:'index',cancel(){}});await Promise.resolve();fail=true;job.finish('completed','result');await Promise.resolve();const count=saves
 await expect(Promise.resolve(cleanups[0]!())).rejects.toThrow('Index job cleanup incomplete');await expect(Promise.resolve(cleanups[0]!())).rejects.toThrow('Index job cleanup incomplete');expect(saves).toBe(count)
})
