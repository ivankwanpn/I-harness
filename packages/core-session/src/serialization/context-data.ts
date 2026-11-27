import type { ConversationProvenance, ConversationSourceRef } from '../conversation/types.ts'
import type { ConversationItemRef } from '../events/replacement.ts'

export type ImmutableJson = null | boolean | number | string | readonly ImmutableJson[] | { readonly [key: string]: ImmutableJson }
export type Captured<T> = unknown extends T ? ImmutableJson : T extends readonly (infer E)[] ? readonly Captured<E>[] : T extends object ? { readonly [K in keyof T]: Captured<T[K]> } : T

// Only nodes constructed and deeply frozen by this module may be reused.
// Frozen caller objects and proxies carry no ownership evidence.
const capturedNodes = new WeakSet<object>()
const originalObject = Object, originalArray = Array, originalNumber = Number, originalReflect = Reflect
const originalFreeze = Object.freeze, originalDefineProperty = Object.defineProperty, originalDescriptor = Object.getOwnPropertyDescriptor
const originalArraySpecies = originalDescriptor(Array, Symbol.species)
const closedCaptureOperations = [
  [Object, 'freeze', originalFreeze], [Object, 'defineProperty', originalDefineProperty],
  [Object, 'getOwnPropertyDescriptor', originalDescriptor], [Object, 'getOwnPropertyDescriptors', Object.getOwnPropertyDescriptors],
  [Object, 'getPrototypeOf', Object.getPrototypeOf], [Object, 'is', Object.is], [Reflect, 'ownKeys', Reflect.ownKeys],
  [Array, 'isArray', Array.isArray], [Number, 'isFinite', Number.isFinite], [Number, 'isInteger', Number.isInteger],
  [Number, 'isSafeInteger', Number.isSafeInteger],
] as const

/** Keep the old capture when reflective validation or array construction was customized. */
export function hasOriginalClosedCaptureOperations(): boolean {
  if (Object !== originalObject || Array !== originalArray || Number !== originalNumber || Reflect !== originalReflect) return false
  for (let index = 0; index < closedCaptureOperations.length; index++) {
    const operation = closedCaptureOperations[index]!
    if (originalDescriptor(operation[0], operation[1])?.value !== operation[2]) return false
  }
  const species = originalDescriptor(Array, Symbol.species)
  return species?.get === originalArraySpecies?.get && species?.set === originalArraySpecies?.set
}

/** Object identity is proof of an immutable, data-only capture by this module. */
export function isCapturedData(value: unknown): boolean {
  return !!value && typeof value === "object" && capturedNodes.has(value)
}

export class UnsupportedData extends Error {
  constructor() { super("CONTEXT_SNAPSHOT_UNSUPPORTED") }
}

function supportsCapturedNumber(value: number): boolean {
  return Number.isFinite(value) && !Object.is(value, -0) && (!Number.isInteger(value) || Number.isSafeInteger(value))
}

/** Construct the closed scalar DTO so the projection can share the reference.
 * Legacy coordinates outside the capture domain still use the ordinary validator. */
export function createConversationSourceRef(id: string, eventIndex: number, part: string, seq: number | undefined): ConversationSourceRef {
  const addressable = seq !== undefined
  const reference = Object.freeze({ id, eventIndex, ...(addressable ? { seq } : {}), part, addressable })
  if (typeof id === 'string' && typeof part === 'string' && supportsCapturedNumber(eventIndex) && (!addressable || supportsCapturedNumber(seq))) {
    capturedNodes.add(reference)
  }
  return reference
}

/** Construct dense arrays here so the capture owns the container as well as its references. */
export function createCapturedConversationSources(length: number, read: (index: number) => ConversationSourceRef): readonly ConversationSourceRef[] {
  const sources: ConversationSourceRef[] = []
  let captured = true
  for (let index = 0; index < length; index++) {
    const source = read(index)
    originalDefineProperty(sources, index, { value: source, enumerable: true, configurable: true, writable: true })
    captured = captured && isCapturedData(source) && source.addressable
  }
  const result = originalFreeze(sources)
  if (captured) capturedNodes.add(result)
  return result
}

export function createCapturedConversationProvenance(
  kind: ConversationProvenance['kind'], authority: ConversationProvenance['authority'], scope: ConversationProvenance['scope'],
  source: ConversationSourceRef, admission: ConversationSourceRef | undefined, producer: string | undefined, originSessionId: string | undefined,
): ConversationProvenance {
  const evidence = originalFreeze(admission === undefined ? [source] : [source, admission])
  const result = originalFreeze({ kind, authority, scope, evidence,
    ...(producer === undefined ? {} : { producer }), ...(originSessionId === undefined ? {} : { originSessionId }) })
  if (typeof kind === 'string' && typeof authority === 'string' && typeof scope === 'string'
    && (producer === undefined || typeof producer === 'string') && (originSessionId === undefined || typeof originSessionId === 'string')
    && isCapturedData(source) && source.addressable && (admission === undefined || isCapturedData(admission) && admission.addressable)) {
    capturedNodes.add(evidence)
    capturedNodes.add(result)
  }
  return result
}

export function createCapturedConversationItemAddress(kind: ConversationItemRef['kind'], seq: number, part: string): ConversationItemRef {
  const at = originalFreeze({ seq, part })
  const result = originalFreeze({ kind, at })
  if (typeof kind === 'string' && typeof seq === 'number' && supportsCapturedNumber(seq)
    && Number.isSafeInteger(seq) && seq >= 0 && typeof part === 'string') {
    capturedNodes.add(at)
    capturedNodes.add(result)
  }
  return result
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
    if ("finish" in task) { Object.freeze(task.finish); capturedNodes.add(task.finish); ancestors.delete(task.original); continue }
    const value = task.value
    if (value === null || typeof value === "string" || typeof value === "boolean") { task.put(value); continue }
    if (typeof value === "number") {
      if (!supportsCapturedNumber(value)) throw new UnsupportedData()
      task.put(value); continue
    }
    if (typeof value !== "object") throw new UnsupportedData()
    if (capturedNodes.has(value)) { task.put(value); continue }
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
