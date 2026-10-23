import { types } from 'node:util'
import { bootstrapFields, captureBootstrapInvocation } from './bootstrap-header.ts'
import type { BootstrapTargetPreparationRequest, BootstrapTargetPreparationOutcome, BootstrapTargetPreparationPort } from './bootstrap-types.ts'

export function captureBootstrapTargetPreparationRequest(value: BootstrapTargetPreparationRequest): BootstrapTargetPreparationRequest {
  bootstrapFields(value, ['invocation', 'manifestDigest'])
  const invocation = captureBootstrapInvocation(value.invocation)
  if (typeof value.manifestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.manifestDigest)) throw new TypeError('Invalid bootstrap manifest')
  return Object.freeze({ invocation, manifestDigest: value.manifestDigest })
}
export function captureBootstrapTargetPreparationOutcome(value: unknown): BootstrapTargetPreparationOutcome {
  bootstrapFields(value, ['kind'], ['reason'])
  if (value.kind === 'confirmed') { bootstrapFields(value, ['kind']); return { kind: 'confirmed' } }
  if (value.kind !== 'blocked' || !['unknown','unavailable','conflict','policy'].includes(value.reason)) throw new TypeError('Invalid target preparation outcome')
  return { kind: 'blocked', reason: value.reason }
}
export function captureBootstrapTargetPreparationPort(value: BootstrapTargetPreparationPort): BootstrapTargetPreparationPort {
  if (!value || typeof value !== 'object' || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Invalid target preparation port')
  const fields = Object.getOwnPropertyDescriptors(value), names = ['confirm', 'reconcile', 'assertTargetCurrent']
  if (Reflect.ownKeys(value).length !== names.length || names.some(key => !fields[key]?.enumerable || !('value' in fields[key]!) || typeof fields[key]!.value !== 'function' || types.isProxy(fields[key]!.value))) throw new TypeError('Invalid target preparation port')
  return Object.freeze({ confirm: fields.confirm!.value!, reconcile: fields.reconcile!.value!, assertTargetCurrent: fields.assertTargetCurrent!.value! })
}
