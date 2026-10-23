import { types } from 'node:util'
import { captureBootstrapRequestIntent, type BootstrapInvocation, type BootstrapRequestIntent, type BootstrapTargetPreparationPort } from '@i-harness/session-persistence'
import type { SessionProjectContext } from '@i-harness/session-executor'

export interface BootstrapProjectCapture {
  invocation: BootstrapInvocation; requestIntent: BootstrapRequestIntent; sourceSessionId?: string;
  sourceAvailable(): boolean; assertNewWorkCurrent(): void; targetAvailable(): boolean;
}
export interface BootstrapTargetScope { projectId?: string; scope?: SessionProjectContext; revision: string }
export interface BootstrapProjectPreparation {
  targetPreparation: BootstrapTargetPreparationPort;
  targetScope(): BootstrapTargetScope;
  assertSourceCurrent(): void;
  close(): void;
}
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
