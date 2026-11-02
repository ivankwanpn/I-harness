import {settlePersistentJob,type RegisterSubagentResult} from '@i-harness/subagent'
import type {JobRegistration} from '../../subagent/src/jobs.ts'
import type {ManagedRegistryConstruction} from '../../session-executor/src/managed-assembly.ts'

type Status='completed'|'killed'|'error'
type Row={cancel:()=>void;cancelled:boolean;kind:string;label:string;finish:(status:Status,output:string)=>void;done:Promise<void>;terminal?:{status:Status;output:string}}
/** Index jobs remain pinned to the exact persistent Task registration and its
 * original terminal save receipt until cancellation and completion acknowledge. */
export function createOwnedIndexJobs(original:ManagedRegistryConstruction,task:RegisterSubagentResult) {
 const jobsOwner=task.jobs,table=task.table,register=jobsOwner.registerJob,entries=table.entries
 const jobs=new Map<string,Row>()
 let closing=false
 const check=()=>{original.assertCurrent();if(task.jobs!==jobsOwner||task.table!==table||jobsOwner.registerJob!==register||table.entries!==entries)throw Error('Original index job owner changed')}
 const close=async()=>{closing=true;const failures:unknown[]=[],drains:Promise<void>[]=[];for(const job of jobs.values())try{if(!job.terminal&&!job.cancelled){job.cancel();job.cancelled=true}drains.push(job.done)}catch(error){failures.push(error)};const settled=await Promise.allSettled(drains);for(const item of settled)if(item.status==='rejected')failures.push(item.reason);if(failures.length)throw new AggregateError(failures,'Index job cleanup incomplete')}
 original.retain(close)
 return Object.freeze({
  owns(sessionId:string){check();if(closing)return false;const found=sessionId===original.domain.sessionId||[...Reflect.apply(entries,table,[]).values()].some(entry=>entry.sessionId===sessionId&&entry.status==='running');check();return found},
  register(input:{id:string;kind:string;label:string;cancel:()=>void}){
   check();if(closing)throw Error('Background job owner is unavailable')
   const existing=jobs.get(input.id)
   if(existing){if(existing.kind!==input.kind||existing.label!==input.label||existing.cancel!==input.cancel)throw Error(`duplicate job id: ${input.id}`);return {finish:existing.finish}}
   const cancel=input.cancel,id=input.id,kind=input.kind,label=input.label
   let producer:JobRegistration|undefined,resolve!:()=>void,reject!:(error:unknown)=>void
   const done=new Promise<void>((ok,fail)=>{resolve=ok;reject=fail});void done.catch(()=>{})
   let row:Row|undefined
   const finish=(status:Status,output:string)=>{
    if(!producer||!row)throw Error('Original job registration unavailable')
    if(row.terminal){if(row.terminal.status!==status||row.terminal.output!==output)throw Error('Original index job outcome changed');return}
    row.terminal={status,output}
    void settlePersistentJob(producer,status,output).then(ok=>{if(!ok)throw Error('Original index job settlement unavailable');if(jobs.get(id)===row)jobs.delete(id);resolve()},reject).catch(reject)
   }
   try {
    const mounted=Reflect.apply(register,jobsOwner,['root',kind,label,id,undefined,cancel,undefined,(registration:JobRegistration)=>{producer=registration;row={cancel,cancelled:false,kind,label,finish,done};jobs.set(id,row)}])
    if(!producer||mounted!==producer||mounted.id!==id||!mounted.finish)throw Error('Original job acquisition unavailable')
    check()
   } catch(error) {
    if(producer&&row)try{finish('error','Index job registration failed')}catch(cleanup){throw new AggregateError([error,cleanup],'Index job registration cleanup failed',{cause:error})}
    throw error
   }
   return {finish}
  },
 })
}

/** Registry for original runtime mounts, removed before their retained drains. */
export function createOwnedIndexJobBindings() {
 const owners=new Map<string,ReturnType<typeof createOwnedIndexJobs>>()
 return Object.freeze({
  mount(original:ManagedRegistryConstruction,task:RegisterSubagentResult){
   const id=original.domain.sessionId
   if(owners.has(id))throw Error('Index job owner already mounted')
   const owner=createOwnedIndexJobs(original,task)
   owners.set(id,owner)
   try{original.retain(()=>{if(owners.get(id)===owner)owners.delete(id)})}catch(error){owners.delete(id);throw error}
   return owner
  },
  register(sessionId:string,input:{id:string;kind:string;label:string;cancel:()=>void}){
   const matching=[...owners.values()].filter(owner=>owner.owns(sessionId))
   if(matching.length!==1)throw Error('Code Context job owner is unavailable or ambiguous')
   return matching[0]!.register(input)
  },
 })
}
