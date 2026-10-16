import type { Tool } from '@i-harness/core-tools'
import type { CodeModeInvocation } from '../types.ts'

export interface Cell { tools: Map<string, Tool>; stop: AbortController; seen: Set<string> }
export interface Queued {
  call: CodeModeInvocation; tool: Tool; signal: AbortSignal; eventSeq?: number
  resolve(value: unknown): void; reject(error: unknown): void; unsubscribe(): void
  admitted(): void; finished: boolean; recorded: boolean
}
