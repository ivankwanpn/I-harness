/** Iterative native JSON property semantics and bounded string escaping. */
interface JsonStreamOptions { lexical?: boolean; lower?: boolean; emit?: boolean; dataOnly?: boolean }
export class UnsupportedJsonData extends TypeError { constructor() { super('Canonical encoding requires JSON data') } }
const nativeJson = JSON as typeof JSON & { isRawJSON?(value: unknown): boolean; rawJSON?(text: string): object }
const isNativeRawJSON = nativeJson.isRawJSON, createNativeRawJSON = nativeJson.rawJSON
type Container = unknown[] | Record<string, unknown>
type Frame = { source: object; target?: Container; keys?: string[]; descriptors?: PropertyDescriptorMap; index: number; length: number; array: boolean; emitted: number }

/** The data wrappers preserve their original supported-data fence. Inspecting
 * descriptors never calls source getters/toJSON before a native fallback. */
function dataContainer(value: object, array: boolean): PropertyDescriptorMap {
  const prototype = Object.getPrototypeOf(value)
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new UnsupportedJsonData()
  if (isNativeRawJSON?.(value)) throw new UnsupportedJsonData()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const toJSON = Object.getOwnPropertyDescriptor(value, 'toJSON') ?? (prototype && Object.getOwnPropertyDescriptor(prototype, 'toJSON')) ?? (array && Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON'))
  if (toJSON && (!('value' in toJSON) || typeof toJSON.value === 'function')) throw new UnsupportedJsonData()
  for (const key of Object.keys(descriptors)) if (descriptors[key]!.enumerable && !('value' in descriptors[key]!)) throw new UnsupportedJsonData()
  return descriptors
}
function dataValue(value: unknown): unknown {
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new UnsupportedJsonData()
  return value
}

function* quote(value: string): Generator<string> {
  yield '"'
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(value.length, offset + 4096)
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--
    if (end === offset) end++
    yield JSON.stringify(value.slice(offset, end)).slice(1, -1)
    offset = end
  }
  yield '"'
}

function normalize(holder: object, key: string): unknown {
  let value = Reflect.get(holder, key)
  if (value !== null && (typeof value === 'object' || typeof value === 'function' || typeof value === 'bigint')) {
    const toJSON = Reflect.get(Object(value), 'toJSON')
    if (typeof toJSON === 'function') value = Reflect.apply(toJSON, value, [key])
  }
  if (value !== null && typeof value === 'object') {
    let brand = -1, primitive: unknown
    for (let index = 0; index < boxedSlots.length; index++) {
      try { primitive = Reflect.apply(boxedSlots[index]!, value, []); brand = index; break } catch { /* Different native internal slot. */ }
    }
    // JSON's Number/String wrappers perform ToNumber/ToString after the
    // internal-slot check. User conversion callbacks belong to that one
    // conversion, outside the mismatch probes; Boolean ignores overrides.
    if (brand === 0) value = +(value as unknown as number)
    else if (brand === 1) value = String(value)
    else if (brand >= 2) value = primitive
  }
  if (typeof value === 'bigint') throw new TypeError('Do not know how to serialize a BigInt')
  return value
}
const boxedSlots = [Number.prototype.valueOf, String.prototype.valueOf, Boolean.prototype.valueOf, BigInt.prototype.valueOf]

/** Return the owned program value when lower is requested. Never join a body. */
export function* streamJsonData(input: unknown, options: JsonStreamOptions = {}): Generator<string, unknown> {
  const ancestors = new Set<object>(), stack: Frame[] = []
  let pending: { value: unknown; target?: Container; key?: string } | undefined = { value: options.dataOnly ? dataValue(input) : normalize({ '': input }, '') }
  let root: unknown
  while (pending || stack.length) {
    if (pending) {
      const { value, target, key } = pending
      pending = undefined
      let lowered: unknown = value
      if (typeof value === 'number') lowered = Number.isFinite(value) ? value === 0 ? 0 : value : null
      if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined
      if (value === null || typeof value !== 'object') {
        if (options.emit !== false) {
          if (typeof value === 'string') yield* quote(value)
          else yield JSON.stringify(value)
        }
      } else {
        if (isNativeRawJSON?.(value)) {
          if (options.dataOnly) throw new UnsupportedJsonData()
          const raw = Reflect.get(value, 'rawJSON') as string
          if (options.emit !== false) for (let offset = 0; offset < raw.length;) {
            let end = Math.min(raw.length, offset + 16384)
            if (end < raw.length && /[\uD800-\uDBFF]/.test(raw[end - 1]!)) end--
            yield raw.slice(offset, end); offset = end
          }
          if (options.lower && !createNativeRawJSON) throw new TypeError('Native raw JSON lowering unavailable')
          lowered = options.lower ? createNativeRawJSON!(raw) : undefined
        } else {
          if (ancestors.has(value)) throw new TypeError('Converting circular structure to JSON')
          const array = Array.isArray(value), descriptors = options.dataOnly ? dataContainer(value, array) : undefined
          const keys = array ? undefined : descriptors ? Object.keys(descriptors).filter(key => descriptors[key]!.enumerable) : Object.keys(value)
          if (options.lexical) keys?.sort()
          lowered = options.lower ? array ? [] : {} : undefined
          ancestors.add(value)
          stack.push({ source: value, ...(options.lower ? { target: lowered as Container } : {}), keys, descriptors, index: 0, length: array ? value.length : keys!.length, array, emitted: 0 })
          if (options.emit !== false) yield array ? '[' : '{'
        }
      }
      if (options.lower) {
        if (target && key !== undefined) Object.defineProperty(target, key, { value: lowered, enumerable: true, writable: true, configurable: true })
        else root = lowered
      }
      continue
    }
    const frame = stack.at(-1)!
    if (frame.index >= frame.length) {
      if (options.emit !== false) yield frame.array ? ']' : '}'
      ancestors.delete(frame.source); stack.pop(); continue
    }
    const index = frame.index++, key = frame.array ? String(index) : frame.keys![index]!
    if (frame.descriptors && (!frame.descriptors[key] && key in frame.source || frame.descriptors[key] && !('value' in frame.descriptors[key]!))) throw new UnsupportedJsonData()
    let value = frame.descriptors ? dataValue(frame.descriptors[key]?.value) : normalize(frame.source, key)
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
      if (!frame.array) continue
      value = null
    }
    if (frame.emitted++ && options.emit !== false) yield ','
    if (!frame.array && options.emit !== false) { yield* quote(key); yield ':' }
    pending = { value, target: frame.target, key }
  }
  return root
}

/** R4A-ENC-01: one synchronous callback-bearing source walk, no encoding. */
export function lowerJsonData(input: unknown): unknown {
  return streamJsonData(input, { lower: true, emit: false }).next().value
}

/** Read only owned lowered data. No source normalization or encoded body is
 * produced. Native markers cannot survive an inline fact's JSON.parse. */
export function containsNativeRawJson(owned: unknown): boolean {
  const pending: unknown[] = [owned]
  while (pending.length) {
    const value = pending.pop()
    if (value === null || typeof value !== 'object') continue
    if (isNativeRawJSON?.(value)) return true
    for (const child of Object.values(value)) pending.push(child)
  }
  return false
}
