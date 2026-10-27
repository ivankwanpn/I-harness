import { canonicalJsonData, freezeJsonData, isStrictFactData, type BootstrapInvocation } from '@i-harness/core-session'
import { bootstrapHash } from '../semantic-seed.ts'
import { bootstrapFields, captureBootstrapInvocation } from './bootstrap-header.ts'

export type BootstrapProjectIntent = { kind: 'unmanaged' } | { kind: 'unassigned' } | { kind: 'project'; projectId: string }
export interface BootstrapRequestIntent { version: 1; requestCoreDigest: string; project: BootstrapProjectIntent }

export function captureBootstrapProjectIntent(value: BootstrapProjectIntent): BootstrapProjectIntent {
  bootstrapFields(value, ['kind'], ['projectId'])
  if (value.kind === 'project') {
    bootstrapFields(value, ['kind', 'projectId'])
    if (typeof value.projectId !== 'string' || !value.projectId || value.projectId.length > 256 || /[\u0000-\u001f\u007f]/.test(value.projectId)) throw new TypeError('Invalid bootstrap project')
    return Object.freeze({ kind: 'project', projectId: value.projectId })
  }
  bootstrapFields(value, ['kind'])
  if (value.kind !== 'unmanaged' && value.kind !== 'unassigned') throw new TypeError('Invalid bootstrap project mode')
  return Object.freeze({ kind: value.kind })
}
function captureCore(value: unknown): unknown {
  if (!isStrictFactData(value)) throw new TypeError('Invalid bootstrap request core')
  const pending = [value]
  while (pending.length) {
    const next = pending.pop()
    if (next === undefined) throw new TypeError('Undefined bootstrap request field')
    if (next === null || typeof next !== 'object') continue
    const fields = Object.getOwnPropertyDescriptors(next), array = Array.isArray(next)
    if (array && Object.keys(fields).length !== next.length + 1) throw new TypeError('Sparse bootstrap request array')
    for (const [key, field] of Object.entries(fields)) {
      if (array && key === 'length') continue
      if (!field.enumerable || array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= next.length)) throw new TypeError('Hidden bootstrap request field')
      pending.push(field.value)
    }
  }
  return JSON.parse(canonicalJsonData(value))
}
export function createBootstrapRequestIntent(core: unknown, project: BootstrapProjectIntent): { intent: BootstrapRequestIntent; requestDigest: string } {
  const intent: BootstrapRequestIntent = { version: 1, requestCoreDigest: bootstrapHash('ih.bootstrap.request.core.v1', captureCore(core)), project: captureBootstrapProjectIntent(project) }
  return { intent: freezeJsonData(intent) as BootstrapRequestIntent, requestDigest: bootstrapHash('ih.bootstrap.request.v1', intent) }
}
export function captureBootstrapRequestIntent(invocation: BootstrapInvocation, value: BootstrapRequestIntent): BootstrapRequestIntent {
  const original = captureBootstrapInvocation(invocation)
  bootstrapFields(value, ['version', 'requestCoreDigest', 'project'])
  if (value.version !== 1 || typeof value.requestCoreDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.requestCoreDigest)) throw new TypeError('Invalid bootstrap request intent')
  const intent: BootstrapRequestIntent = Object.freeze({ version: 1, requestCoreDigest: value.requestCoreDigest, project: captureBootstrapProjectIntent(value.project) })
  if (bootstrapHash('ih.bootstrap.request.v1', intent) !== original.requestDigest) throw new TypeError('Bootstrap request intent mismatch')
  return intent
}
