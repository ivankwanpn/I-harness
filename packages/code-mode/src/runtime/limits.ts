import type { CodeModeConfig } from '../types.js'

export const TEXT_CAP = 16 * 1024
export const ITEM_CAP = 256
export function limit(value: number | undefined, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${label}`)
  return Math.min(max, Math.max(min, Math.floor(value)))
}
export function limits(config: CodeModeConfig = {}) {
  return {
    memoryLimitMb: limit(config.memoryLimitMb, 64, 8, 256, 'memoryLimitMb'),
    cpuTimeMs: limit(config.cpuTimeMs, 1000, 10, 10_000, 'cpuTimeMs'),
    maxActiveCells: limit(config.maxActiveCells, 4, 1, 16, 'maxActiveCells'),
    maxPendingCalls: limit(config.maxPendingCalls, 64, 1, 256, 'maxPendingCalls'),
    maxSourceBytes: limit(config.maxSourceBytes, 128 * 1024, 1, 1024 * 1024, 'maxSourceBytes'),
    maxResultBytes: limit(config.maxResultBytes, 4 * 1024 * 1024, 1, 16 * 1024 * 1024, 'maxResultBytes'),
    maxStoreBytes: limit(config.maxStoreBytes, 1024 * 1024, 1, 4 * 1024 * 1024, 'maxStoreBytes'),
    defaultYieldTimeMs: limit(config.defaultYieldTimeMs, 1000, 0, 60_000, 'defaultYieldTimeMs'),
    defaultOutputTokens: limit(config.defaultOutputTokens, 4096, 0, 4096, 'defaultOutputTokens'),
  }
}
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
export function message(error: unknown): string {
  try { return typeof error === 'object' && error !== null ? 'message' in error && typeof error.message === 'string' ? error.message : 'Host error' : String(error) }
  catch { return 'Host error message unavailable' }
}
export function diagnostic(error: unknown, bytes: number): {text:string; truncated:boolean} {
  const raw = message(error)
  // Slice before encoding to avoid allocating a copy of an oversized message.
  const text = textSlice(raw.slice(0,bytes),bytes)
  return {text,truncated:text !== raw}
}
export function textSlice(value: string, bytes: number): string {
  let result = Buffer.from(value).subarray(0, bytes).toString('utf8')
  while (Buffer.byteLength(result) > bytes) result = result.slice(0, -1)
  return result
}
export type RuntimeLimits = ReturnType<typeof limits>
