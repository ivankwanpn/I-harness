import { DEFAULT_STORE_BYTES, MAX_STORE_BYTES } from '@i-harness/core-session/internal/bootstrap'
export { json } from '@i-harness/core-session/internal/bootstrap'
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
    maxStoreBytes: limit(config.maxStoreBytes, DEFAULT_STORE_BYTES, 1, MAX_STORE_BYTES, 'maxStoreBytes'),
    defaultYieldTimeMs: limit(config.defaultYieldTimeMs, 1000, 0, 60_000, 'defaultYieldTimeMs'),
    defaultOutputTokens: limit(config.defaultOutputTokens, 4096, 0, 4096, 'defaultOutputTokens'),
  }
}
export function message(error: unknown): string {
  try { return typeof error === 'object' && error !== null ? 'message' in error && typeof error.message === 'string' ? error.message : 'Host error' : String(error) }
  catch { return 'Host error message unavailable' }
}
export function diagnostic(error: unknown, bytes: number): {text:string; truncated:boolean} {
  const raw = message(error)
  const text = textSlice(raw,bytes)
  return {text,truncated:text !== raw}
}
const encoder = new TextEncoder()
export function textSlice(value: string, bytes: number): string {
  if (bytes <= 0) return ''
  const prefix = value.slice(0, bytes)
  if (Buffer.byteLength(prefix) <= bytes) return prefix
  const { read } = encoder.encodeInto(prefix, new Uint8Array(bytes))
  return prefix.slice(0, read)
}
export type RuntimeLimits = ReturnType<typeof limits>
