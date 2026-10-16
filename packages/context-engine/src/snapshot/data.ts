import type { Captured } from "../contracts/snapshot.ts"

export class UnsupportedData extends Error {
  constructor() { super("CONTEXT_SNAPSHOT_UNSUPPORTED") }
}

/** Own only supported JSON data. Descriptors precede all unknown child reads.
 * Reflective inspection of a Proxy can itself have effects; no purity claim is
 * made for arbitrary Proxies. Originals are never modified or frozen.
 */
export function captureData<T>(input: T): Captured<T> {
  let result: unknown
  const ancestors = new Set<object>()
  type Task = { value: unknown; put: (value: unknown) => void } | { finish: object; original: object }
  const tasks: Task[] = [{ value: input, put: value => { result = value } }]
  while (tasks.length) {
    const task = tasks.pop()!
    if ("finish" in task) { Object.freeze(task.finish); ancestors.delete(task.original); continue }
    const value = task.value
    if (value === null || typeof value === "string" || typeof value === "boolean") { task.put(value); continue }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Object.is(value, -0) || Number.isInteger(value) && !Number.isSafeInteger(value)) throw new UnsupportedData()
      task.put(value); continue
    }
    if (typeof value !== "object") throw new UnsupportedData()
    if (ancestors.has(value)) throw new UnsupportedData()
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value)
    if (array && prototype !== Array.prototype) throw new UnsupportedData()
    if (!array && prototype !== Object.prototype && prototype !== null) throw new UnsupportedData()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.some(key => typeof key !== "string")) throw new UnsupportedData()
    const copy: unknown[] | Record<string, unknown> = array ? [] : {}
    const entries: { key: string; value: unknown }[] = []
    if (array) {
      const length = descriptors.length?.value
      if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1) throw new UnsupportedData()
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)]
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || descriptor.value === undefined) throw new UnsupportedData()
        entries.push({ key: String(index), value: descriptor.value })
      }
    } else {
      for (const key of keys as string[]) {
        const descriptor = descriptors[key]!
        if (!descriptor.enumerable || !("value" in descriptor)) throw new UnsupportedData()
        if (descriptor.value !== undefined) entries.push({ key, value: descriptor.value })
      }
    }
    task.put(copy); ancestors.add(value)
    tasks.push({ finish: copy, original: value })
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]!
      tasks.push({ value: entry.value, put: child => Object.defineProperty(copy, entry.key, { value: child, enumerable: true, configurable: true, writable: true }) })
    }
  }
  // The descriptor walk establishes this narrowing, including every unknown leaf.
  return result as Captured<T>
}
