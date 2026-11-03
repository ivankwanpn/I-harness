import { stringifyJsonData } from '../serialization/json-data.ts'
import { types } from 'node:util'
import type { DeepReadonly } from './types.ts'

/** Strict new DTOs never execute legacy accessors/toJSON while being admitted. */
export function isStrictFactData(value: unknown): boolean {
  type Work = { value: unknown } | { leave: object }
  const stack: Work[] = [{ value }], ancestors = new Set<object>()
  while (stack.length) {
    const work = stack.pop()!
    if ('leave' in work) { ancestors.delete(work.leave); continue }
    const current = work.value
    if (current === undefined || current === null || typeof current === 'string' || typeof current === 'boolean') continue
    if (typeof current === 'number') { if (!Number.isFinite(current)) return false; continue }
    if (typeof current !== 'object' || types.isProxy(current) || ancestors.has(current)) return false
    const array = Array.isArray(current), prototype = Object.getPrototypeOf(current)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false
    const fields = Object.getOwnPropertyDescriptors(current)
    if (Reflect.ownKeys(current).some(key => typeof key !== 'string') || Object.values(fields).some(field => !('value' in field))) return false
    ancestors.add(current); stack.push({ leave: current })
    for (const [key, field] of Object.entries(fields)) if (key !== 'length' || !array) stack.push({ value: field.value })
  }
  return true
}

/** Only owned, parsed JSON reaches the writer. Legacy conversion runs here,
 * once, before joining any allocation/storage lane. */
export function captureLegacyFact<T>(value: T):
  | { kind: 'captured'; value: DeepReadonly<T> }
  | { kind: 'not-issued'; code: 'FACT_CAPTURE_FAILED' } {
  try {
    const encoded = stringifyJsonData(value)
    if (encoded === undefined) throw new TypeError('No JSON representation')
    return { kind: 'captured', value: freezeJsonData(JSON.parse(encoded)) }
  } catch { return { kind: 'not-issued', code: 'FACT_CAPTURE_FAILED' } }
}

/** Stack-safe: capture and replay must support the existing deep native data. */
export function freezeJsonData<T>(value: T): DeepReadonly<T> {
  const pending: unknown[] = [value]
  while (pending.length) {
    const current = pending.pop()
    if (current === null || typeof current !== 'object' || Object.isFrozen(current)) continue
    for (const child of Object.values(current)) pending.push(child)
    Object.freeze(current)
  }
  return value as DeepReadonly<T>
}
