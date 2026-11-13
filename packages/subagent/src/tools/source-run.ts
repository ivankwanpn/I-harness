import type {ChildAgentEntry,AgentTable} from '../agent-table.ts'
import {captureJobProjection,requireJobProjection,captureTaskTableProjection,type TerminalProjection} from '../runtime-projection.ts'

type Binding={
 local?:()=>Promise<void>
 current?:()=>void
 wait?:()=>Promise<void>
 required():boolean
 bind(entry:ChildAgentEntry,run:Promise<unknown>,project:TerminalProjection):void
 job?:{registration:object;project:TerminalProjection}
 chain?:Promise<void>
 recoveryFailure?:Error
 recoveryReleased?:()=>boolean
 entry?:ChildAgentEntry
}
// One existing source association owns its published callback and the exact
// receipts/entry it acquired. Copies and ordinary registries never enroll.
const runs=new WeakMap<object,Binding>()
export function registerOriginalSpawnRun(
  published: Function,
  required: () => boolean,
  bind: Binding['bind'],
  current?: () => void,
  local?: () => Promise<void>,
  wait?: () => Promise<void>,
  recoveryReleased?: () => boolean,
) {
 if(runs.has(published))throw Error('Original spawn callback already bound')
 runs.set(published,{required,bind,current,local,wait,recoveryReleased})
}
export function bindOriginalSpawnJob(published:Function|undefined,registration:object){
 const owner=published&&runs.get(published)
 if(!owner||!owner.required())return
 if(owner.job){
  if(owner.job.registration!==registration)throw Error('Original spawn job replaced')
  return
 }
 if(runs.has(registration))throw Error('Original spawn job already owned')
 owner.job={registration,project:requireJobProjection(registration,owner.current,owner.local,owner.wait)}
 runs.set(registration,owner)
}
export function bindOriginalSpawnRun(
  published: Function | undefined,
  entry: ChildAgentEntry,
  run: Promise<unknown>,
  table: AgentTable,
  chain?: Promise<void>,
) {
 const owner=published&&runs.get(published)
 if(!owner||!owner.required())return
 const job=owner.job
 if(!job)throw Error('Original spawn registration unavailable')
 if(owner.entry&&owner.entry!==entry||runs.has(entry)&&runs.get(entry)!==owner)throw Error('Original spawn entry replaced')
 captureJobProjection(job.registration)
 const projectTable=captureTaskTableProjection(table,entry,owner.current,owner.wait)
 owner.bind(entry,run,async terminal=>{await Promise.all([projectTable(terminal),job.project(terminal)])})
 owner.entry=entry
 owner.chain=chain
 runs.set(entry,owner)
}
export function isOriginalRequiredSpawnJob(registration:object){
 const owner=runs.get(registration)
 if(!owner||owner.job?.registration!==registration||!owner.required())return false
 captureJobProjection(registration)
 return true
}
export function isOriginalRequiredSpawnEntry(entry:ChildAgentEntry){
 const owner=runs.get(entry)
 return owner?.entry===entry&&owner.required()===true
}
export function projectOriginalSpawnJob(published:Function,terminal:import('../runtime-projection.ts').OriginalTerminal){
 return runs.get(published)?.job?.project(terminal)??Promise.resolve()
}
export function hasRequiredOriginalSpawn(published:Function|undefined){return !!published&&runs.get(published)?.required()===true}

/** Called only by the original source after its bound RequiredTaskSettlement
 * issues a nominal ACK-recovery error. Keep the first initial-chain occurrence. */
export function retainOriginalSpawnRecoveryFailure(published: Function, failure: Error): void {
  const owner = runs.get(published)
  if (!owner || !owner.required()) throw Error('Original required spawn unavailable')
  owner.recoveryFailure ??= failure
}

/** A nominal marker alone is insufficient: the exact source and completion
 * chain must have acknowledged all original result/source cleanup. */
export function isOriginalSpawnChainAcknowledged(
  entry: ChildAgentEntry,
  chain: Promise<void> | undefined,
  cause: unknown,
): boolean {
  const owner = runs.get(entry)
  if (!chain || !owner || owner.entry !== entry || owner.chain !== chain || !owner.required()) return false
  return owner.recoveryFailure !== undefined && owner.recoveryFailure === cause
    && owner.recoveryReleased?.() === true
}
