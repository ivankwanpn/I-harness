import type {AgentTable,ChildAgentEntry} from './agent-table.ts'
import type {TaskRecord} from './task/types.ts'
export type OriginalTerminal=Readonly<TaskRecord>
export type TerminalProjection=(terminal:OriginalTerminal)=>Promise<void>
type JobOwner={project:TerminalProjection;original:TerminalProjection;fields:PropertyDescriptorMap;required:boolean;completion:{done:boolean};current?:()=>void;wait?:()=>Promise<void>;retain?:(drive:()=>Promise<void>)=>void}
const jobs=new WeakMap<object,JobOwner>()
type TableProjection=(entry:ChildAgentEntry,current?:()=>void,wait?:()=>Promise<void>)=>TerminalProjection
type TableOwner={capture:TableProjection;original:TableProjection}
const tables=new WeakMap<AgentTable,TableOwner>()
export function associateJobProjection(registration:object,project:TerminalProjection,retain?:(drive:()=>Promise<void>)=>void){
 const prior=jobs.get(registration)
 jobs.set(registration,{project,original:prior?.original??project,fields:prior?.fields??Object.getOwnPropertyDescriptors(registration),required:prior?.required??false,completion:prior?.completion??{done:false},current:prior?.current,wait:prior?.wait,retain:retain??prior?.retain})
}
export function originalJobProjectionFor(registration:object){return jobs.has(registration)?captureJobProjection(registration):undefined}
function checkedJobProjection(registration:object,kind:'project'|'original'):TerminalProjection {
 const original=jobs.get(registration);if(!original)throw Error('Original job projection unavailable')
 const check=()=>{
  if(Reflect.ownKeys(registration).length!==Reflect.ownKeys(original.fields).length)throw Error('Original job registration changed')
  for(const key of Reflect.ownKeys(original.fields)){const expected=Reflect.get(original.fields,key)as PropertyDescriptor,now=Object.getOwnPropertyDescriptor(registration,key);if(!now||!('value'in now)||now.value!==expected.value)throw Error('Original job registration changed')}
 }
 const project=original[kind];check();return terminal=>{check();return project(terminal)}
}
export function captureJobProjection(registration:object){return checkedJobProjection(registration,'project')}
export function inheritOriginalJobProjection(target:object,original:object){const owner=jobs.get(target);if(!owner)throw Error('Original job projection unavailable');owner.original=checkedJobProjection(original,'original')}
/** This receipt was captured live by the same original Task source/run. */
export function assertJobProjectionCurrent(registration:object){jobs.get(registration)?.current?.()}
export async function waitJobProjectionCurrent(registration:object){await jobs.get(registration)?.wait?.()}
export function requireJobProjection(registration:object,current?:()=>void,drive?:()=>Promise<void>,wait?:()=>Promise<void>):TerminalProjection {
 const original=jobs.get(registration),project=captureJobProjection(registration);if(!original)throw Error('Original job projection unavailable')
 original.current??=current
 original.wait??=wait
 const completion=original.completion
 if(!original.required){if(original.retain&&!drive)throw Error('Original job producer unavailable');if(drive)original.retain?.(()=>completion.done?Promise.resolve():drive());original.required=true}
 return async terminal=>{
  if(original.wait)await original.wait();original.current?.()
  const known=terminal.outcome==='completed'||terminal.outcome==='error'||terminal.outcome==='cancelled'
  const pending=(known?checkedJobProjection(registration,'original'):project)(terminal)
  void pending.then(()=>{completion.done=true},()=>{})
  await pending;original.current?.()
 }
}
export function associateTableProjection(table:AgentTable,capture:TableProjection){tables.set(table,{capture,original:tables.get(table)?.original??capture})}
export function inheritOriginalTableProjection(target:AgentTable,original:AgentTable){const owner=tables.get(target),source=tables.get(original);if(!owner||!source)throw Error('Original table projection unavailable');owner.original=source.original}
export function captureTableProjection(table:AgentTable,entry:ChildAgentEntry,current?:()=>void,wait?:()=>Promise<void>){const owner=tables.get(table);if(!owner)throw Error('Original table projection unavailable');return owner.capture(entry,current,wait)}
export function captureTaskTableProjection(table:AgentTable,entry:ChildAgentEntry,current?:()=>void,wait?:()=>Promise<void>):TerminalProjection {
 const owner=tables.get(table);if(!owner)throw Error('Original table projection unavailable')
 const memory=owner.original(entry),persistent=owner.capture(entry,current,wait)
 return async terminal=>{if(terminal.outcome!=='completed'&&terminal.outcome!=='error'&&terminal.outcome!=='cancelled')return persistent(terminal);if(wait)await wait();current?.();await memory(terminal);current?.()}
}
export function forwardTableProjection(table:AgentTable,original:()=>AgentTable){tables.set(table,{capture:(entry,current,wait)=>captureTableProjection(original(),entry,current,wait),original:entry=>{const owner=tables.get(original());if(!owner)throw Error('Original table projection unavailable');return owner.original(entry)}})}
/** One captured persistence attempt; a failed original write remains debt. */
export function persistProjection(project:TerminalProjection,save:()=>Promise<void>,current?:()=>void,settle?:()=>Promise<void>,wait?:()=>Promise<void>):TerminalProjection {
 let saved:Promise<void>|undefined,finishing:Promise<void>|undefined,fixed:OriginalTerminal|undefined,entered=false,acknowledged=false
 return terminal=>{
  fixed??=terminal
  saved??=(async()=>{if(wait)await wait();current?.();await project(fixed!);if(wait)await wait();current?.();entered=true;await save();acknowledged=true})()
  if(!finishing){const original=saved,pending=original.then(async()=>{await settle?.();if(wait)await wait();current?.()});finishing=pending;void pending.catch(()=>{if(finishing===pending&&(!entered||acknowledged)){finishing=undefined;if(!entered&&saved===original)saved=undefined}})}
  return finishing
 }
}
