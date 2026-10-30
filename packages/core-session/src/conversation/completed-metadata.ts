/** Clone only the factory's explicitly assembled, payload-free metadata graph.
 * Preserve aliases across history/selection/maps; never walk a SessionView,
 * owner, event array, message, argument, media or passive value here. */
export function immutableCompletedMetadata<T>(metadata: T): T {
  const copied = structuredClone(metadata), seen = new WeakMap<object, object>()
  const deny = (): never => { throw new TypeError('Completed selection metadata is immutable') }
  const protect = (value: any): any => {
    if (!value || typeof value !== 'object') return value
    const prior = seen.get(value); if (prior) return prior
    if (value instanceof Map || value instanceof Set) {
      const map = value instanceof Map, entries = [...value.entries()]
      const proxy = new Proxy(value, { get(target, key, receiver) {
        if (['set', 'add', 'delete', 'clear'].includes(String(key))) return deny
        if (key === 'size') return target.size
        if (key === 'forEach') return (callback: (...args: any[]) => void, thisArg?: unknown) => target.forEach((item: unknown, index: unknown) => callback.call(thisArg, item, index, proxy))
        if (key === Symbol.iterator || ['get', 'has', 'entries', 'keys', 'values'].includes(String(key))) return Reflect.get(target, key, target).bind(target)
        return Reflect.get(target, key, receiver)
      }, set: deny, defineProperty: deny, deleteProperty: deny, setPrototypeOf: deny })
      seen.set(value, proxy)
      value.clear()
      for (const [key, item] of entries) { if (map) value.set(protect(key), protect(item)); else value.add(protect(item)) }
      Object.freeze(value)
      return proxy
    }
    seen.set(value, value)
    for (const key of Object.keys(value)) value[key] = protect(value[key])
    return Object.freeze(value)
  }
  return protect(copied)
}
