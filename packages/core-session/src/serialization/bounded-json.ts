import { types } from 'node:util'
export const MAX_STORE_BYTES = 4 * 1024 * 1024
export const DEFAULT_STORE_BYTES = 1024 * 1024
function invalidSelectedData(): never { throw new TypeError('Invalid semantic seed') }
export function json(value: unknown, bytes: number, label: string, strict = false): string {
  let consumed = 0
  let root = true
  const counts = new WeakMap<object, number>()
  const overflow = () => { throw new Error(`${label} transfer limit exceeded`) }
  const stringBytes = (text: string) => {
    if (Buffer.byteLength(text) > bytes) return overflow()
    return Buffer.byteLength(JSON.stringify(text))
  }
  // The replacer sees each leaf before JSON.stringify materializes it into the
  // result. In particular, a huge string refuses before later getters run.
  const encoded = JSON.stringify(value === undefined ? null : value,function(key,current: unknown) {
    const array = Array.isArray(this)
    const omitted = current === undefined || typeof current === 'function' || typeof current === 'symbol'
    if (strict && (omitted || typeof current === 'bigint' || typeof current === 'number' && !Number.isFinite(current))) throw new Error(`${label} must contain JSON values only`)
    let size = 0
    if (root) root = false
    else if (!omitted || array) {
      const count = counts.get(this) ?? 0
      counts.set(this,count + 1)
      size += count ? 1 : 0
      if (!array) size += stringBytes(key) + 1
    }
    if (typeof current === 'string') size += stringBytes(current)
    else if (current === null || (omitted && array)) size += 4
    else if (typeof current === 'boolean') size += current ? 4 : 5
    else if (typeof current === 'number') size += Number.isFinite(current) ? String(current).length : 4
    else if (typeof current === 'object') {
      if (Array.isArray(current) && current.length > bytes) overflow()
      size += 2
    }
    consumed += size
    if (consumed > bytes) overflow()
    return current
  })
  if (encoded === undefined || Buffer.byteLength(encoded) > bytes) throw new Error(`${label} transfer limit exceeded`)
  return encoded
}
export function captureSelectedData(input: unknown): unknown {
  let result: unknown
  const ancestors = new Set<object>()
  type Task = { value: unknown; put(value: unknown): void } | { leave: object }
  const tasks: Task[] = [{ value: input, put: value => { result = value } }]
  while (tasks.length) {
    const task = tasks.pop()!
    if ('leave' in task) { ancestors.delete(task.leave); continue }
    const value = task.value
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) { task.put(value); continue }
    if (!value || typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) invalidSelectedData()
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalidSelectedData()
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors)
    if (keys.some(key => typeof key !== 'string') || array && keys.length !== value.length + 1) invalidSelectedData()
    const copy: unknown[] | Record<string, unknown> = array ? [] : {}
    task.put(copy); ancestors.add(value); tasks.push({ leave: value })
    for (const key of (keys as string[]).reverse()) {
      if (array && key === 'length') continue
      const descriptor = descriptors[key]!
      if (!descriptor.enumerable || !('value' in descriptor)) invalidSelectedData()
      tasks.push({ value: descriptor.value, put: child => { Object.defineProperty(copy, key, { value: child, enumerable: true, writable: true, configurable: true }) } })
    }
  }
  return result
}


export function decodeStoreValueJson(encoded: string) {
  const value = captureSelectedData(JSON.parse(encoded))
  if (json(value, MAX_STORE_BYTES, 'Session store', true) !== encoded) invalidSelectedData()
  return value
}
