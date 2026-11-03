import type { PreparedRequestMeasurement } from "@i-harness/token-meter"
import type { LLMRequest, LLMStreamEvent } from "../index.ts"
export interface PreparedStreamControl {
  generation?: import('./generation.ts').GenerationControl
  onTransportIssue?: () => void
  confirmExecution?: (confirmation: import("./execution.ts").ExecutionConfirmation) => void
  /** Owned synchronous validation after execution-time awaits, immediately before send. */
  validateBeforeTransport?: () => void
  signal?: AbortSignal
  onStreamActivity?: LLMRequest['onStreamActivity']
  onTerminalResponse?: LLMRequest['onTerminalResponse']
}
export interface PreparedModelRequest {
  readonly localExecutionIdentity?: object
  readonly retryPolicy?: import('@i-harness/core-session').GenerationRetry
  readonly textOutput?: import('./text-output.ts').PreparedTextOutput
  readonly measurement: PreparedRequestMeasurement
  readonly validation?: import('./validation.ts').PreparedValidation
  withOutputCap(cap: number | undefined): PreparedModelRequest
  stream(control?: PreparedStreamControl): AsyncIterable<LLMStreamEvent>
}
