import type {AgentTable,ChildAgentEntry} from './agent-table.ts'
import type {JobRegistry} from './jobs.ts'

/** Cleanup only: no registration, admission, or replacement authority. */
export interface OriginalTeamChildCleanup {markClosing():void;killJob():void;detach():boolean}
export function createOriginalTeamCleanup(path:string,entry:ChildAgentEntry,staged:{table:AgentTable;jobs:JobRegistry},target:()=>{table:AgentTable;jobs:JobRegistry}):OriginalTeamChildCleanup{
 if(staged.table.get(path)!==entry||entry.path!==path)throw TypeError('Original Team child entry required')
 const jobId=entry.jobId,sessionId=entry.sessionId
 if(jobId){const job=staged.jobs.read(jobId);if(job.agentPath!==path||job.sessionId!==sessionId)throw TypeError('Original Team child job required')}
 let marked=false,killed=false,detached=false,removed=false
 const port:OriginalTeamChildCleanup=Object.freeze({
  markClosing(){if(this!==port)throw TypeError('Original Team cleanup receiver required');if(marked)return;const actual=staged.table.get(path);if(actual&&actual!==entry)throw TypeError('Original Team child replaced');if(actual)target().table.update(path,entry,{closing:true});marked=true},
  killJob(){if(this!==port||!marked)throw TypeError('Original Team child closing required');if(killed)return;if(entry.jobId!==jobId||entry.sessionId!==sessionId)throw TypeError('Original Team child identity changed');if(jobId){const job=staged.jobs.read(jobId);if(job.agentPath!==path||job.sessionId!==sessionId)throw TypeError('Original Team child job changed');target().jobs.kill(jobId)}killed=true},
  detach(){if(this!==port||!marked||!killed)throw TypeError('Original Team child settlement required');if(detached)return removed;const actual=staged.table.get(path);if(actual===entry){target().table.remove(path);removed=true}detached=true;return removed},
 });return port
}
type TeamParent=import('@i-harness/core-session/internal/execution').OriginalManagedTeamParent
const factories=new WeakMap<AgentTable,{birth(path:string,entry:ChildAgentEntry):OriginalTeamChildCleanup;resident(parent:TeamParent,path:string,entry:ChildAgentEntry):OriginalTeamChildCleanup}>()
const ports=new WeakMap<ChildAgentEntry,{table:AgentTable;path:string;port:OriginalTeamChildCleanup}>()
const boundParents=new WeakMap<OriginalTeamChildCleanup,{parent:TeamParent;path:string;entry:ChildAgentEntry}>()
export function associateOriginalTeamCleanup(table:AgentTable,factory:{birth(path:string,entry:ChildAgentEntry):OriginalTeamChildCleanup;resident(parent:TeamParent,path:string,entry:ChildAgentEntry):OriginalTeamChildCleanup}){if(factories.has(table))throw TypeError('Original Team cleanup owner already associated');factories.set(table,factory)}
/** Called synchronously only after the exact original Team birth is branded. */
export function bindOriginalTeamCleanup(table:AgentTable,path:string,entry:ChildAgentEntry){if(ports.has(entry))throw TypeError('Original Team cleanup already bound');const factory=factories.get(table);if(!factory)throw TypeError('Original Team cleanup owner unavailable');const port=factory.birth(path,entry);ports.set(entry,{table,path,port});return port}
export function readOriginalTeamCleanup(table:AgentTable,path:string,entry:ChildAgentEntry){const original=ports.get(entry);return original?.table===table&&original.path===path?original.port:undefined}
/** The original Task owner calls this only after validating its retained Team ledger. */
export function retainOriginalResidentTeamCleanup(table:AgentTable,parent:TeamParent,path:string,entry:ChildAgentEntry){if(ports.has(entry))throw TypeError('Original Team cleanup already bound');const factory=factories.get(table);if(!factory)throw TypeError('Original Team cleanup owner unavailable');const port=factory.resident(parent,path,entry);ports.set(entry,{table,path,port});return port}
/** Bind only a port already retained by this original Task table. */
export function bindOriginalTeamCleanupParent(table:AgentTable,parent:TeamParent,path:string,entry:ChildAgentEntry,port:OriginalTeamChildCleanup){if(readOriginalTeamCleanup(table,path,entry)!==port)throw TypeError('Original Team cleanup port required');const bound=boundParents.get(port);if(bound&&(bound.parent!==parent||bound.path!==path||bound.entry!==entry))throw TypeError('Original Team cleanup parent changed');if(!bound)boundParents.set(port,{parent,path,entry});return port}
export function assertOriginalTeamChildCleanup(port:OriginalTeamChildCleanup,parent:TeamParent,path:string,entry:ChildAgentEntry){const bound=boundParents.get(port);if(!bound||bound.parent!==parent||bound.path!==path||bound.entry!==entry)throw TypeError('Original Team child cleanup required')}
