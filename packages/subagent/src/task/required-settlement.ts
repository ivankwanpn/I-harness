import type { SettlementFacts } from '@i-harness/core-session'
import type { TaskRegistry,TaskRecord,TaskTerminalizeInput } from './types.ts'
export interface RequiredTaskSettlement {settle():Promise<Readonly<TaskRecord>>;reconcile():Promise<Readonly<TaskRecord>>;assertProjectionCurrent():void;release():Promise<void>}
type Bind=(task:TaskRecord,source:SettlementFacts<import('@i-harness/core-session').ProducerFactOutcome>,producer:()=>Promise<TaskTerminalizeInput>)=>Promise<RequiredTaskSettlement|undefined>
const registries=new WeakMap<TaskRegistry,Bind>()
export function associateRequiredTaskRegistry(registry:TaskRegistry,bind:Bind){if(registries.has(registry))throw Error('Duplicate required Task owner');registries.set(registry,bind)}
export function forwardRequiredTaskRegistry(facade:TaskRegistry,original:TaskRegistry){const bind=registries.get(original);if(!bind)throw Error('Original required Task owner unavailable');registries.set(facade,bind)}
export function bindRequiredTaskSettlement(registry:TaskRegistry,task:TaskRecord,source:SettlementFacts<import('@i-harness/core-session').ProducerFactOutcome>,producer:()=>Promise<TaskTerminalizeInput>){const bind=registries.get(registry);if(!bind)throw Error('Original required Task owner unavailable');return bind(task,source,producer)}

const installedData=new WeakMap<object,Map<string,object>>()
export function installRequiredTaskData(operations:object,stateId:string,data:object){let states=installedData.get(operations);if(!states){states=new Map();installedData.set(operations,states)}states.set(stateId,data)}
export function isInstalledRequiredTaskData(operations:object,stateId:string,data:object){return installedData.get(operations)?.get(stateId)===data}
