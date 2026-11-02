import { types } from 'node:util'
import { captureBootstrapRequestIntent, type BootstrapInvocation, type BootstrapRequestIntent, type BootstrapTargetPreparationPort } from '@i-harness/session-persistence'
import {captureChildBootstrapCaptureRequest,type ChildBootstrapCaptureRequest} from '@i-harness/session-persistence'
import type { SessionProjectContext } from '@i-harness/session-executor'
import {inspectTaskChildHistory,assertOriginalTeamChildHostRequest,assertOriginalColdTeamChildHostRequest,isOriginalColdTeamChildHostInput} from '@i-harness/subagent'
import {canonicalJsonData} from '@i-harness/core-session'

export interface BootstrapProjectCapture {
  invocation: BootstrapInvocation; requestIntent: BootstrapRequestIntent; sourceSessionId?: string;
  sourceAvailable(): boolean; assertNewWorkCurrent(): void; targetAvailable(): boolean;
}
export interface TaskChildProjectCapture {
 history?:import('@i-harness/subagent').TaskChildHostInput['history'];
 teamHost?:import('@i-harness/subagent').TaskChildHostInput;
 request:ChildBootstrapCaptureRequest;sourceSessionId:string;
 sourceAvailable():boolean;assertNewWorkCurrent():void;targetAvailable():boolean;
}
export function captureTaskChildProject(value:TaskChildProjectCapture){
 if(!value||typeof value!=='object'||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw TypeError('Invalid task child project capture')
 const keys=['request','sourceSessionId','sourceAvailable','assertNewWorkCurrent','targetAvailable'],fields=Object.getOwnPropertyDescriptors(value)
 if(Reflect.ownKeys(value).some(key=>typeof key!=='string'||!keys.includes(key)&&key!=='history'&&key!=='teamHost')||keys.some(key=>!fields[key]?.enumerable||!('value'in fields[key]!))||fields.history&&(!('value'in fields.history)||!fields.history.enumerable)||fields.teamHost&&(!('value'in fields.teamHost)||!fields.teamHost.enumerable)||keys.slice(2).some(key=>typeof fields[key]!.value!=='function'||types.isProxy(fields[key]!.value)))throw TypeError('Invalid task child project fields')
 const request=captureChildBootstrapCaptureRequest(value.request)
 if(request.requestIntent.project.kind==='unmanaged')throw TypeError('Foreign task child project source')
 if(request.core.caller.kind==='team'){if(!value.teamHost||typeof value.teamHost!=='object'||types.isProxy(value.teamHost))throw TypeError('Original Team child host required');(isOriginalColdTeamChildHostInput(value.teamHost)?assertOriginalColdTeamChildHostRequest:assertOriginalTeamChildHostRequest)(value.teamHost,request);if(value.teamHost.parentSessionId!==value.sourceSessionId)throw TypeError('Original Team parent mismatch')}
 else if(request.core.caller.kind!=='task'||request.core.caller.parentSessionId!==value.sourceSessionId||value.teamHost)throw TypeError('Foreign task child project source')
 if(request.core.history.selection.kind!=='none'){
   if(!value.history||canonicalJsonData(inspectTaskChildHistory(value.history,value.sourceSessionId).history)!==canonicalJsonData(request.core.history))throw TypeError('Original task semantic project source required')
 }else if(value.history)throw TypeError('Unexpected task semantic project source')
 return Object.freeze({request,invocation:request.invocation,requestIntent:request.requestIntent,sourceSessionId:value.sourceSessionId,sourceAvailable:value.sourceAvailable,assertNewWorkCurrent:value.assertNewWorkCurrent,targetAvailable:value.targetAvailable})
}
export interface BootstrapTargetScope { projectId?: string; scope?: SessionProjectContext; revision: string }
export interface ExistingBootstrapProjectPreparation {
  targetPreparation: BootstrapTargetPreparationPort;
  targetScope(): BootstrapTargetScope;
  assertSourceCurrent(): void;
  close(): void;
}
/** Original broker variant: active observes source and target together; passive observes target only. */
export interface CoherentBootstrapProjectPreparation extends ExistingBootstrapProjectPreparation {
  kind:'coherent-project-observation-v1';
  observeCurrent(mode:'active'|'passive'):BootstrapTargetScope;
}
export type BootstrapProjectPreparation=ExistingBootstrapProjectPreparation|CoherentBootstrapProjectPreparation
export function captureBootstrapProject(value: BootstrapProjectCapture): BootstrapProjectCapture {
  if (!value || typeof value !== 'object' || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Invalid bootstrap project capture')
  const required = ['invocation', 'requestIntent', 'sourceAvailable', 'assertNewWorkCurrent', 'targetAvailable'], optional = ['sourceSessionId']
  const fields = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key))
    || required.some(key => !Object.hasOwn(fields, key)) || Object.values(fields).some(field => !field.enumerable || !('value' in field) || field.value === undefined)
    || ['sourceAvailable', 'assertNewWorkCurrent', 'targetAvailable'].some(key => typeof fields[key]!.value !== 'function' || types.isProxy(fields[key]!.value))) throw new TypeError('Invalid bootstrap project capture fields')
  const requestIntent = captureBootstrapRequestIntent(value.invocation, value.requestIntent)
  if (requestIntent.project.kind === 'unmanaged') throw new TypeError('Project broker cannot prepare unmanaged bootstrap')
  if (value.sourceSessionId !== undefined && (typeof value.sourceSessionId !== 'string' || !value.sourceSessionId || value.sourceSessionId.length > 256 || /[\u0000-\u001f\u007f]/.test(value.sourceSessionId) || value.sourceSessionId === value.invocation.targetSessionId)) throw new TypeError('Invalid bootstrap source')
  return Object.freeze({ invocation: Object.freeze({ ...value.invocation }), requestIntent,
    ...(value.sourceSessionId === undefined ? {} : { sourceSessionId: value.sourceSessionId }),
    sourceAvailable: value.sourceAvailable, assertNewWorkCurrent: value.assertNewWorkCurrent, targetAvailable: value.targetAvailable })
}
import { readSelectedResultsOperation, type ForkOperationV2 } from '../../session-persistence/src/selected-results-fork-contract.ts'
/** Trusted selected-runtime construction; inspection closes over the original entry identity. */
export interface SelectedProjectCapture {
  operation: ForkOperationV2; sourceAvailable(): boolean; assertNewWorkCurrent(): void; targetAvailable(): boolean;
  target: object;
}
export function captureSelectedProject(value: SelectedProjectCapture) {
  if(!value||typeof value!=='object'||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw TypeError('Invalid selected project capture')
  const fields=Object.getOwnPropertyDescriptors(value),keys=['operation','sourceAvailable','assertNewWorkCurrent','targetAvailable','target']
  if(Reflect.ownKeys(value).length!==keys.length||keys.some(key=>!fields[key]||!fields[key]!.enumerable||!('value' in fields[key]!))||keys.slice(1,4).some(key=>typeof fields[key]!.value!=='function'||types.isProxy(fields[key]!.value))||!fields.target!.value||typeof fields.target!.value!=='object'||types.isProxy(fields.target!.value))throw TypeError('Invalid selected project capture')
  const operation=readSelectedResultsOperation(fields.operation!.value)
  if(operation.prepared.requestIntent.project.kind==='unmanaged')throw TypeError('Project broker cannot prepare unmanaged bootstrap')
  return Object.freeze({invocation:operation.invocation,requestIntent:operation.prepared.requestIntent,sourceSessionId:operation.prepared.core.sourceSessionId,
    sourceAvailable:fields.sourceAvailable!.value as ()=>boolean,assertNewWorkCurrent:fields.assertNewWorkCurrent!.value as ()=>void,
    targetAvailable:fields.targetAvailable!.value as ()=>boolean,target:fields.target!.value as object})
}
