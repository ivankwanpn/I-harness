import { types } from 'node:util'

/** Named own data only. In particular this never walks opaque envelope bodies. */
export function resultData(object: unknown, key: string): unknown {
  if (!object || typeof object !== 'object') return undefined
  if (types.isProxy(object)) throw new TypeError('Unsafe result metadata proxy')
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  if (!descriptor) return undefined
  if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Unsafe result metadata: ' + key)
  return descriptor.value
}
export function closedResultMetadata(object: unknown, keys: readonly string[]): void {
  if (!object || typeof object !== 'object' || types.isProxy(object) || Array.isArray(object)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(object))) throw new TypeError('Invalid result metadata record')
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key !== 'string' || !keys.includes(key)) throw new TypeError('Unknown result metadata field')
    resultData(object, key)
  }
}
export function resultScalars(object: unknown, keys: readonly string[]): Record<string, string | number | boolean> {
  const fields: Record<string, string | number | boolean> = {}
  for (const key of keys) {
    const value = resultData(object, key)
    if (value === undefined) continue
    if (!['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Invalid result scalar: ' + key)
    fields[key] = value as string | number | boolean
  }
  return fields
}
