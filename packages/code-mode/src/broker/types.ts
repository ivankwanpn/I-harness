import type { PreparedCall, RetainedToolOutcome, Tool, ToolResult } from '@i-harness/core-tools'
import type { ManagedAction, SettlementFacts, CapturedSettlementFact, ProducerFactOutcome } from '@i-harness/core-session'
import type { CodeModeInvocation } from '../types.ts'

export interface Cell { tools: Map<string, Tool>; stop: AbortController; seen: Set<string> }
export interface Queued {
  call: CodeModeInvocation; tool: Tool; signal: AbortSignal; eventSeq?: number
  resolve(value: unknown): void; reject(error: unknown): void; unsubscribe(): void
  admitted(): void; finished: boolean; recorded: boolean
  action: ManagedAction<ProducerFactOutcome>; source: SettlementFacts<ProducerFactOutcome>
  done: ReturnType<typeof Promise.withResolvers<void>>
  hasOutput: boolean; bodyOutput?: unknown; finalizing?: Promise<ToolResult>
  prepared?: PreparedCall; retained?: RetainedToolOutcome; recoveryCause?: unknown; completion?: Promise<unknown>
  generation?: import('@i-harness/core-tools').CodeGenerationScope
  result?: CapturedSettlementFact<ProducerFactOutcome>
}
