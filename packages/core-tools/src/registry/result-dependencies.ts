import { AsyncLocalStorage } from 'node:async_hooks'
import type { ResultDependency } from '@i-harness/core-session'
import type { ToolExec } from '../types.ts'

export interface ToolResultDependency {
  readonly sourceId: string
  settle(): Promise<{ kind: 'ready'; dependency: ResultDependency } | { kind: 'recovery-required' }>
}
const producers = new WeakSet<ToolExec>(), current = new AsyncLocalStorage<ToolExec>()
const sources = new WeakMap<ToolExec, Map<string, ToolResultDependency>>()
export function registerResultProducer(exec: ToolExec): void { producers.add(exec) }
export function withToolResultProducer<T>(exec: ToolExec, call: () => T): T {
  if (!producers.has(exec)) throw new Error('Result producer unavailable')
  return current.run(exec, call)
}
export function currentToolResultProducer(): ToolExec | undefined { const exec = current.getStore(); return exec && producers.has(exec) ? exec : undefined }
/** Only actual host callbacks register native sources; return data is ignored. */
export function registerToolResultDependency(exec: ToolExec, source: ToolResultDependency): boolean {
  if (!producers.has(exec)) return false
  if (typeof source.sourceId !== 'string' || !source.sourceId || Buffer.byteLength(source.sourceId) > 1024 || source.sourceId.includes('\0')) throw new Error('Result dependency identity unavailable')
  let entries = sources.get(exec)
  if (!entries) { entries = new Map(); sources.set(exec, entries) }
  const existing = entries.get(source.sourceId)
  if (existing === source) return true
  if (existing) {
    // Retain both original handles on conflict. No payload can erase them or
    // turn an uncertain dependency into a completed result.
    const originals = [existing, source]
    entries.set(source.sourceId, { sourceId: source.sourceId, async settle() { void originals; return { kind: 'recovery-required' } } })
    return false
  }
  entries.set(source.sourceId, source)
  return true
}
export function toolResultDependencies(exec: ToolExec): readonly ToolResultDependency[] { return [...(sources.get(exec)?.values() ?? [])] }
