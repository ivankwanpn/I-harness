import { isStrictFactData } from '@i-harness/core-session'

/** Metadata capture must not silently omit hidden/undefined properties, sparse
 * array cells or array extensions. The shared fact guard rejects accessors,
 * proxies, symbols, cycles, nonfinite numbers and foreign prototypes first. */
export function isMetadataData(value: unknown): boolean {
  if (!isStrictFactData(value)) return false
  const stack = [value]
  while (stack.length) {
    const current = stack.pop()
    if (current === undefined) return false
    if (current === null || typeof current !== 'object') continue
    if ('toJSON' in current) return false
    const array = Array.isArray(current), fields = Object.getOwnPropertyDescriptors(current)
    if (array && Object.keys(fields).length !== current.length + 1) return false
    for (const [key, descriptor] of Object.entries(fields)) {
      if (array && key === 'length') continue
      if (!descriptor.enumerable || array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length)) return false
      stack.push(descriptor.value)
    }
  }
  return true
}
