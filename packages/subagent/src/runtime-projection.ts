import type {AgentTable,ChildAgentEntry} from './agent-table.ts'
import type {TaskRecord} from './task/types.ts'
export type OriginalTerminal=Readonly<TaskRecord>
export type TerminalProjection=(terminal:OriginalTerminal)=>Promise<void>
type JobOwner={project:TerminalProjection;fields:PropertyDescriptorMap;required:boolean;completion:{done:boolean};current?:()=>void;retain?:(drive:()=>Promise<void>)=>void}
const jobs=new WeakMap<object,JobOwner>()
const tables=new WeakMap<AgentTable,(entry:ChildAgentEntry,current?:()=>void)=>TerminalProjection>()
export function associateJobProjection(registration:object,project:TerminalProjection,retain?:(drive:()=>Promise<void>)=>void){
 const prior=jobs.get(registration)
 jobs.set(registration,{project,fields:prior?.fields??Object.getOwnPropertyDescriptors(registration),required:prior?.required??false,completion:prior?.completion??{done:false},current:prior?.current,retain:retain??prior?.retain})
}
export function originalJobProjectionFor(registration:object){return jobs.has(registration)?captureJobProjection(registration):undefined}
export function captureJobProjection(registration:object):TerminalProjection {
 const original=jobs.get(registration);if(!original)throw Error('Original job projection unavailable')
 const check=()=>{
  if(Reflect.ownKeys(registration).length!==Reflect.ownKeys(original.fields).length)throw Error('Original job registration changed')
  for(const key of Reflect.ownKeys(original.fields)){const expected=Reflect.get(original.fields,key)as PropertyDescriptor,now=Object.getOwnPropertyDescriptor(registration,key);if(!now||!('value'in now)||now.value!==expected.value)throw Error('Original job registration changed')}
 }
 check();return terminal=>{check();return original.project(terminal)}
}
/** This receipt was captured live by the same original Task source/run. */
export function assertJobProjectionCurrent(registration:object){jobs.get(registration)?.current?.()}
export function requireJobProjection(registration:object,current?:()=>void,drive?:()=>Promise<void>):TerminalProjection {
 const original=jobs.get(registration),project=captureJobProjection(registration);if(!original)throw Error('Original job projection unavailable')
 original.current??=current
 const completion=original.completion
 if(!original.required){if(original.retain&&!drive)throw Error('Original job producer unavailable');if(drive)original.retain?.(()=>completion.done?Promise.resolve():drive());original.required=true}
 return terminal=>{original.current?.();const pending=project(terminal);void pending.then(()=>{completion.done=true},()=>{});return pending}
}
export function associateTableProjection(table:AgentTable,capture:(entry:ChildAgentEntry,current?:()=>void)=>TerminalProjection){tables.set(table,capture)}
export function captureTableProjection(table:AgentTable,entry:ChildAgentEntry,current?:()=>void){const capture=tables.get(table);if(!capture)throw Error('Original table projection unavailable');return capture(entry,current)}
export function forwardTableProjection(table:AgentTable,original:()=>AgentTable){associateTableProjection(table,(entry,current)=>captureTableProjection(original(),entry,current))}
/** One captured persistence attempt; a failed original write remains debt. */
export function persistProjection(project:TerminalProjection,save:()=>Promise<void>,current?:()=>void,settle?:()=>Promise<void>):TerminalProjection {
 let saved:Promise<void>|undefined,finishing:Promise<void>|undefined,fixed:OriginalTerminal|undefined,entered=false,acknowledged=false
 return terminal=>{
  fixed??=terminal
  saved??=(async()=>{current?.();await project(fixed!);current?.();entered=true;await save();acknowledged=true})()
  if(!finishing){const original=saved,pending=original.then(async()=>{await settle?.();current?.()});finishing=pending;void pending.catch(()=>{if(finishing===pending&&(!entered||acknowledged)){finishing=undefined;if(!entered&&saved===original)saved=undefined}})}
  return finishing
 }
}
