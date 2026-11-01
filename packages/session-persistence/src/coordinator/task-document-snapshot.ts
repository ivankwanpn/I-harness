import { types } from 'node:util'
import { freezeJsonData } from '@i-harness/core-session'

/** Capture closed JSON data without invoking caller accessors or toJSON. */
export function captureTaskSnapshot(value: unknown): unknown {
  const ancestors = new Set<object>(), stack: ({ value: unknown } | { leave: object })[] = [{ value }]
  while (stack.length) {
    const entry = stack.pop()!
    if ('leave' in entry) { ancestors.delete(entry.leave); continue }
    const item = entry.value
    if (item === null || typeof item === 'string' || typeof item === 'boolean') continue
    if (typeof item === 'number' && Number.isFinite(item)) continue
    if (typeof item !== 'object' || types.isProxy(item) || ancestors.has(item)) throw new TypeError('Invalid task snapshot')
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new TypeError('Invalid task snapshot')
    const fields = Object.getOwnPropertyDescriptors(item), keys = Reflect.ownKeys(item)
    if (keys.some(key => typeof key !== 'string') || Object.values(fields).some(field => !('value' in field))) throw new TypeError('Invalid task snapshot')
    if (array) {
      const length = fields.length?.value
      if (!Number.isSafeInteger(length) || keys.length !== length + 1) throw new TypeError('Invalid task snapshot')
      for (let index = 0; index < length; index++) if (!fields[String(index)]?.enumerable) throw new TypeError('Invalid task snapshot')
    } else if (Object.values(fields).some(field => !field.enumerable)) throw new TypeError('Invalid task snapshot')
    ancestors.add(item); stack.push({ leave: item })
    for (const [key, field] of Object.entries(fields)) if (!array || key !== 'length') stack.push({ value: field.value })
  }
  return freezeJsonData(structuredClone(value))
}
