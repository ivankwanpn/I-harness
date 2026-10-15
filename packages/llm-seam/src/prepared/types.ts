import type { PreparedRequestMeasurement } from "@i-harness/token-meter"
import type { LLMRequest, LLMStreamEvent } from "../index.ts"
export interface PreparedStreamControl {
  confirmExecution?: (confirmation: import("./execution.ts").ExecutionConfirmation) => void
  /** Owned synchronous validation after execution-time awaits, immediately before send. */
  validateBeforeTransport?: () => void
  signal?: AbortSignal
  onStreamActivity?: LLMRequest['onStreamActivity']
  onTerminalResponse?: LLMRequest['onTerminalResponse']
}
export interface PreparedModelRequest {
  readonly measurement: PreparedRequestMeasurement
  withOutputCap(cap: number | undefined): PreparedModelRequest
  stream(control?: PreparedStreamControl): AsyncIterable<LLMStreamEvent>
}
