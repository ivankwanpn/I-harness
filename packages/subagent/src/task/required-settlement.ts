import type { SettlementFacts } from '@i-harness/core-session'
import type { TaskRegistry,TaskRecord,TaskTerminalizeInput } from './types.ts'
export interface RequiredTaskSettlement {settle():Promise<Readonly<TaskRecord>>;reconcile():Promise<Readonly<TaskRecord>>;recoverCapturedAcknowledgment():Promise<Readonly<TaskRecord>|undefined>;acknowledgmentRecovery(cause:unknown):Error|undefined;waitProjectionCurrent():Promise<void>;assertProjectionCurrent():void;release():Promise<void>}
export type NotificationTaskAccess=Pick<TaskRegistry,'get'|'notifications'|'updateNotification'|'retainResult'|'save'>
export interface TaskNotificationProgress {readonly tasks:NotificationTaskAccess;close():Promise<void>}
type Bind=(task:TaskRecord,source:SettlementFacts<import('@i-harness/core-session').ProducerFactOutcome>,producer:()=>Promise<TaskTerminalizeInput>)=>Promise<RequiredTaskSettlement|undefined>
type Owner={bind:Bind;recover?:(namespace:string)=>Promise<void>;closeAfter?:(accepted:Promise<void>)=>Promise<void>;notification?:()=>Promise<TaskNotificationProgress|undefined>;children?:(query?:{sessionId:string;taskId?:string})=>readonly Readonly<TaskRecord>[];runtimeData?:()=>()=>void;auxiliaryData?:()=>()=>void}
const registries=new WeakMap<TaskRegistry,Owner>()
export function associateRequiredTaskRegistry(registry:TaskRegistry,bind:Bind,lifecycle:Omit<Owner,'bind'>={}){
 if(registries.has(registry))throw Error('Duplicate required Task owner')
 registries.set(registry,{bind,...lifecycle})
}
export function forwardRequiredTaskRegistry(facade:TaskRegistry,original:TaskRegistry){const bind=registries.get(original);if(!bind)throw Error('Original required Task owner unavailable');registries.set(facade,bind)}
export function bindRequiredTaskSettlement(registry:TaskRegistry,task:TaskRecord,source:SettlementFacts<import('@i-harness/core-session').ProducerFactOutcome>,producer:()=>Promise<TaskTerminalizeInput>){const bind=registries.get(registry);if(!bind)throw Error('Original required Task owner unavailable');return bind.bind(task,source,producer)}

export { prepareOriginalTaskDataReplacement, isInstalledRequiredTaskData, isOriginalTaskDataIncarnation, releaseOriginalTaskData } from '@i-harness/session-persistence/internal/task-persistence'

export async function recoverCanonicalTaskPublications(registry:TaskRegistry,namespace:string){await registries.get(registry)?.recover?.(namespace)}
export function closeTaskOwnerAfterAcceptedWork(registry:TaskRegistry,accepted:Promise<void>){const owner=registries.get(registry);if(!owner?.closeAfter)throw Error('Original Task cleanup owner unavailable');return owner.closeAfter(accepted)}
export function captureOriginalTaskRuntimeData(registry: TaskRegistry) {
  const owner = registries.get(registry)
  if (!owner?.runtimeData) throw Error('Original Task runtime owner unavailable')
  return owner.runtimeData()
}
export function captureOriginalTaskAuxiliaryData(registry: TaskRegistry) {
  const owner = registries.get(registry)
  if (!owner?.auxiliaryData) throw Error('Original Task auxiliary owner unavailable')
  return owner.auxiliaryData()
}
export async function captureTaskNotificationProgress(registry:TaskRegistry){return registries.get(registry)?.notification?.()}
export function canonicalTaskChildren(registry:TaskRegistry){return registries.get(registry)?.children?.()??[]}
export function canonicalTaskChild(registry:TaskRegistry|undefined,sessionId:string,taskId?:string){return registry&&registries.get(registry)?.children?.({sessionId,taskId})[0]}
