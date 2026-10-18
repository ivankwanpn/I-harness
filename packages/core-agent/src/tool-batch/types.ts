import type { PreparedCall, RetainedToolOutcome } from "@i-harness/core-tools"
import type { Telemetry } from "@i-harness/telemetry"
import type { ToolFacts, SettlementFacts, ProducerFactOutcome, CapturedSettlementFact } from '@i-harness/core-session'

export interface BatchCall {
  callId: string
  name: string
  args: unknown
  // M26 (R-D1): durable seq of the invoking tool/call event (set by runTurn;
  // optional so pre-M26 callers / tests keep compiling).
  eventSeq?: number
}

export interface ExecuteToolCallsOptions {
  modelGeneration?: (call: BatchCall, signal: AbortSignal) => import('@i-harness/llm-seam').ToolModelGeneration
  facts?: ToolFacts<ProducerFactOutcome>
  sourceFacts?: SettlementFacts<ProducerFactOutcome>['tools']
  settlementSource?: SettlementFacts<ProducerFactOutcome>
  requireFactRecovery?: () => void
  registerFactSource?: (drain: () => Promise<void>) => SettlementFacts<ProducerFactOutcome>
  assertFactOpen?: () => void
  maxParallel: number
  signal?: AbortSignal
  // M19 (Ruling 24): the identity of the session whose agent is executing the
  // batch — seeded onto each prepared ToolExec so tool bodies can attribute
  // the caller (the agent-team scheduler resolves team-tool callers from it).
  // Additive: absent → ToolExec.sessionId stays undefined (pre-M19 behavior).
  sessionId?: string
  // M25: optional host telemetry stream (Ruling M25-P3 — independent of the
  // session log, agent-invisible). Absent = no tool events.
  telemetry?: Telemetry
  // M70: optional host checkpoint capability — make the session log durable up
  // to the `tool/dispatch` marker that was just appended, and REJECT when that
  // could not be done. The shipped host passes the coordinator's write-behind
  // drain (`() => coordinator.flush(sessionId)`), which resolves only after the
  // backend write returned; the marker is therefore on disk before the body
  // runs, and a kill cannot lose it. Absent (every subagent host today, and
  // every test that does not opt in) → NO checkpoint and byte-identical pre-M70
  // behavior — this seam is optional exactly like `telemetry` above.
  flush?: () => Promise<void>
}


export interface Slot { name: string; callId: string; prepared: PreparedCall; output: unknown; finalized?: import('@i-harness/core-tools').ToolResult; finalizing?: Promise<import('@i-harness/core-tools').ToolResult>; fact?: CapturedSettlementFact<ProducerFactOutcome>; recorded?: true }
// Synthetic results have no finalize/post-tool authority.
export interface SyntheticSlot { name: string; callId: string; output: unknown; synthetic: true; projected?: { output: unknown }; fact?: CapturedSettlementFact<ProducerFactOutcome>; recorded?: true }
export interface RetainedSlot extends Omit<Slot, 'output'> { retained: RetainedToolOutcome; recoveryCause: unknown; resolved?: { output: unknown } }
export type BatchSlot = Slot | SyntheticSlot | RetainedSlot
