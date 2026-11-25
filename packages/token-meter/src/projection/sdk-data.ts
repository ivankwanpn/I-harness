import { canonicalJsonData } from "@i-harness/core-session"

/** Every node is tagged, including containers. User objects cannot impersonate
 * bytes, arrays or the encoding itself. This estimates command data only; AWS
 * owns the eventual HTTP/base64 serialization. Work stays on an explicit stack. */
export function encodeSdkCommandData(value: unknown): string {
  type Work = { value: unknown; before: string; after: string } | { leave: object; after: string }
  const parts: string[] = [], ancestors = new Set<object>(), work: Work[] = [{ value, before: "", after: "" }]
  let deferred: { at: number; tuple: readonly [string, unknown] }[] | undefined
  const taggedValue = (tag: string, data: unknown, after: string) => {
    if (typeof data === "string") parts.push(`["${tag}",${JSON.stringify(data)}]${after}`)
    else {
      // A replaced Date/Buffer method may supply a non-string value. Keep its
      // old canonical validation after the input has been traversed.
      (deferred ??= []).push({ at: parts.length, tuple: [tag, data] })
      parts.push("", after)
    }
  }
  while (work.length) {
    const task = work.pop()!
    if ("leave" in task) { ancestors.delete(task.leave); parts.push(`]]${task.after}`); continue }
    const item = task.value
    if (task.before) parts.push(task.before)
    if (item instanceof Uint8Array) { taggedValue("bytes", Buffer.from(item).toString("base64"), task.after); continue }
    // The existing snapshot contract preserves Dates as Dates. Include their
    // value instead of collapsing their empty enumerable properties to {}.
    if (item instanceof Date) { taggedValue("date", item.toISOString(), task.after); continue }
    if (item === null) { parts.push(`["null"]${task.after}`); continue }
    if (item === undefined) { parts.push(`["undefined"]${task.after}`); continue }
    const type = typeof item
    if (typeof item !== "object") {
      if (type !== "string" && type !== "boolean" && (type !== "number" || !Number.isFinite(item))) throw new TypeError("SDK command identity requires finite data")
      parts.push(`["${type}",${JSON.stringify(item)}]${task.after}`)
      continue
    }
    if (ancestors.has(item)) throw new TypeError("SDK command identity requires acyclic data")
    ancestors.add(item); work.push({ leave: item, after: task.after })
    const array = Array.isArray(item), keys = array ? Array.from({ length: item.length }, (_, index) => String(index)) : Object.keys(item).sort()
    parts.push(array ? '["array",[' : '["object",[')
    // Read sibling properties in the original order before descending. The
    // stack then emits them in lexical object or positional array order.
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]!
      const child = (item as Record<string, unknown>)[key], comma = index === 0 ? "" : ","
      work.push({ value: child, before: array ? comma : `${comma}[${JSON.stringify(key)},`, after: array ? "" : "]" })
    }
  }
  // Validate the synthesized array prototype once, as the old canonical walk
  // did for each tagged tuple. Inherited serializers remain unsupported.
  canonicalJsonData([])
  for (const entry of deferred ?? []) parts[entry.at] = canonicalJsonData(entry.tuple)
  return parts.join("")
}
