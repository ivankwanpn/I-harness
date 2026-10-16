import { append } from '@i-harness/core-session'
import type { CodeModeMountOptions } from '../types.ts'
import type { Queued } from './types.ts'

export const message = (error: unknown) => error instanceof Error ? error.message : String(error)
export const fatal = (error: unknown) => Object.assign(new Error(message(error)), { policyRefusal: true as const })

export function createCodeModeRecords(options: Pick<CodeModeMountOptions, 'session'>) {
  return {
    record(item: Queued, output: unknown, error = false) {
      if (item.recorded) return
      item.recorded = true
      append(options.session, { type: 'code/result', cellId: item.call.cellId, callId: item.call.invocationId, name: item.call.name, output, ...(error ? { isError: true } : {}) })
    },
    settle(item: Queued, outcome: { value: unknown } | { error: unknown }) {
      if (item.finished) return
      item.finished = true; item.unsubscribe()
      if ('error' in outcome) item.reject(outcome.error)
      else item.resolve(outcome.value)
    },
  }
}
