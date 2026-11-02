import type { PreparedCall, RetainedToolOutcome, Tool, ToolResult, InstructionCellOrigin, InstructionReplanData, CapturedToolCall, AcceptedInstructionCall } from '@i-harness/core-tools'
import type { ManagedAction, SettlementFacts, CapturedSettlementFact, ProducerFactOutcome } from '@i-harness/core-session'
import type { CodeModeInvocation } from '../types.ts'

export interface Cell { admissionAction?:ManagedAction<import('@i-harness/core-session').FactOutcome>; delegation?:import('@i-harness/core-tools/internal/code-origin').PrivateCodeCellDelegation; tools: Map<string, Tool>; stop: AbortController; seen: Set<string>; preflights: Set<Promise<void>>; instructionOrigin?: InstructionCellOrigin; replan?: InstructionReplanData; terminalCommitted?: boolean; ending: ReturnType<typeof Promise.withResolvers<void>>; finishing?: Promise<void>; finished?: true }
export interface Queued {
  call: CodeModeInvocation; tool: Tool; signal: AbortSignal; eventSeq?: number
  resolve(value: unknown): void; reject(error: unknown): void; unsubscribe(): void
  admitted(): void; finished: boolean; recorded: boolean
  action: ManagedAction<ProducerFactOutcome>; source: SettlementFacts<ProducerFactOutcome>
  done: ReturnType<typeof Promise.withResolvers<void>>
  hasOutput: boolean; bodyOutput?: unknown; finalizing?: Promise<ToolResult>
  finalized?: ToolResult; finalization?: import('@i-harness/core-tools').ResultFinalization; syntheticFinalization?: import('@i-harness/core-tools').ResultFinalization; postToolStarted?: true
  prepared?: PreparedCall; retained?: RetainedToolOutcome; recoveryCause?: unknown; completion?: Promise<unknown>
  capture?: CapturedToolCall; instructionOrigin?: AcceptedInstructionCall; captureFailure?: unknown
  generation?: import('@i-harness/core-tools').CodeGenerationScope
  callPin?:ReturnType<typeof import('@i-harness/core-session/internal/execution').retainAcknowledgedExecutionMembers>
  callCapture?:import('@i-harness/core-session').CapturedActionFact<ProducerFactOutcome>; callOutcome?:Extract<ProducerFactOutcome,{kind:'committed'}>
  result?: CapturedSettlementFact<ProducerFactOutcome>
}


