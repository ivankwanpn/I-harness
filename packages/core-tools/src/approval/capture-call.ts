import { types } from 'node:util'
import { copyConversationData } from '@i-harness/core-session'
import type { ToolCall } from '../types.ts'

/** Prove the subset on which the stack-safe data copier has structuredClone
 * semantics. Classification never invokes a getter or inspects a Proxy. */
function ordinaryJson(value: unknown): boolean {
  type Work = { value: unknown } | { leave: object }
  const pending: Work[] = [{ value }]
  const ancestors = new Set<object>()
  while (pending.length) {
    const work = pending.pop()!
    if ('leave' in work) { ancestors.delete(work.leave); continue }
    const current = work.value
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue
    if (typeof current === 'number') { if (!Number.isFinite(current)) return false; continue }
    if (typeof current !== 'object' || types.isProxy(current) || ancestors.has(current)) return false
    const array = Array.isArray(current)
    const prototype = Object.getPrototypeOf(current)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false
    const fields = Object.getOwnPropertyDescriptors(current)
    const keys = Reflect.ownKeys(fields)
    if (keys.some(key => typeof key !== 'string')) return false
    if (array && keys.length !== current.length + 1) return false
    for (const key of keys as string[]) {
      const field = fields[key]!
      if (!('value' in field)) return false
      if (array && key === 'length') continue
      if (!field.enumerable) return false
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length)) return false
    }
    ancestors.add(current)
    pending.push({ leave: current })
    for (const key of keys as string[]) {
      if (!array || key !== 'length') pending.push({ value: fields[key]!.value })
    }
  }
  return true
}

export function captureToolCall(call: ToolCall): ToolCall {
  return ordinaryJson(call) ? copyConversationData(call) : structuredClone(call)
}
