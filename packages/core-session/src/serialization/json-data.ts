const unsupported = Symbol("non-data-serialization")

/** One stack-based data encoder. Source order matches JSON.stringify's own
 * property enumeration (including numeric keys); lexical order preserves the
 * context/prefix canonical encoding. Native JSON handles non-data legacy graphs.
 * Descriptor reflection does not promise side-effect-free Proxy inspection.
 */
function encodeData(input: unknown, lexical: boolean): string | undefined | typeof unsupported {
  type Work = { value: unknown; array?: boolean } | { text: string } | { leave: object }
  const work: Work[] = [{ value: input }], output: string[] = [], ancestors = new Set<object>()
  while (work.length) {
    const task = work.pop()!
    if ("text" in task) { output.push(task.text); continue }
    if ("leave" in task) { ancestors.delete(task.leave); continue }
    const value = task.value
    if (value === undefined) {
      if (task.array) { output.push("null"); continue }
      return undefined
    }
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) { output.push(JSON.stringify(value)); continue }
    if (typeof value !== "object") return unsupported
    const nativeRaw = (JSON as typeof JSON & { isRawJSON?(value: unknown): boolean }).isRawJSON
    if (nativeRaw?.(value)) return unsupported
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return unsupported
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const toJSON = Object.getOwnPropertyDescriptor(value, "toJSON") ?? (prototype && Object.getOwnPropertyDescriptor(prototype, "toJSON")) ?? (array && Object.getOwnPropertyDescriptor(Object.prototype, "toJSON"))
    if (toJSON && (!("value" in toJSON) || typeof toJSON.value === "function")) return unsupported
    if (ancestors.has(value)) return unsupported
    const keys = array ? Array.from({ length: value.length }, (_, index) => String(index))
      : Object.keys(descriptors).filter(key => descriptors[key]!.enumerable)
    if (array && keys.some(key => !descriptors[key] && key in value)) return unsupported
    if (keys.some(key => descriptors[key] && !("value" in descriptors[key]!))) return unsupported
    const retained = array ? keys : keys.filter(key => descriptors[key]!.value !== undefined)
    if (lexical && !array) retained.sort()
    ancestors.add(value); output.push(array ? "[" : "{")
    work.push({ leave: value }, { text: array ? "]" : "}" })
    for (let index = retained.length - 1; index >= 0; index--) {
      const key = retained[index]!
      work.push({ value: descriptors[key]?.value, array })
      if (!array) work.push({ text: `${JSON.stringify(key)}:` })
      if (index > 0) work.push({ text: "," })
    }
  }
  return output.join("")
}

/** Stack-safe JSON data serialization, preserving native legacy behavior for
 * classes, accessors, callable toJSON, functions, symbols, bigint and cycles.
 * It is not the snapshot validator and does not widen its supported-data policy.
 */
export function stringifyJsonData(value: unknown): string | undefined {
  const result = encodeData(value, false)
  return result === unsupported ? JSON.stringify(value) : result
}

/** Canonical encoding for already validated JSON-shaped context data only. */
export function canonicalJsonData(value: unknown): string {
  const result = encodeData(value, true)
  if (result === unsupported) throw new TypeError("Canonical encoding requires JSON data")
  return result ?? "null"
}
