import { canonicalJsonData } from "@i-harness/core-session"

/** Every node is tagged, including containers. User objects cannot impersonate
 * bytes, arrays or the encoding itself. This estimates command data only; AWS
 * owns the eventual HTTP/base64 serialization. Work stays on an explicit stack. */
export function encodeSdkCommandData(value: unknown): string {
  type Work = { value: unknown; put: (value: unknown) => void } | { leave: object }
  let result: unknown
  const ancestors = new Set<object>(), work: Work[] = [{ value, put: item => { result = item } }]
  while (work.length) {
    const task = work.pop()!
    if ("leave" in task) { ancestors.delete(task.leave); continue }
    const item = task.value
    if (item instanceof Uint8Array) { task.put(["bytes", Buffer.from(item).toString("base64")]); continue }
    // The existing snapshot contract preserves Dates as Dates. Include their
    // value instead of collapsing their empty enumerable properties to {}.
    if (item instanceof Date) { task.put(["date", item.toISOString()]); continue }
    if (item === null) { task.put(["null"]); continue }
    if (item === undefined) { task.put(["undefined"]); continue }
    if (typeof item !== "object") {
      if (!["string", "boolean", "number"].includes(typeof item) || typeof item === "number" && !Number.isFinite(item)) throw new TypeError("SDK command identity requires finite data")
      task.put([typeof item, item]); continue
    }
    if (ancestors.has(item)) throw new TypeError("SDK command identity requires acyclic data")
    ancestors.add(item); work.push({ leave: item })
    const array = Array.isArray(item), keys = array ? Array.from({ length: item.length }, (_, index) => String(index)) : Object.keys(item).sort()
    const entries: unknown[] = new Array(keys.length)
    task.put([array ? "array" : "object", entries])
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]!
      work.push({ value: (item as Record<string, unknown>)[key], put: child => { entries[index] = array ? child : [key, child] } })
    }
  }
  return canonicalJsonData(result)
}
