import type { PreparedRequestMeasurement } from "@i-harness/token-meter"
import type { LLMRequest, LLMStreamEvent } from "../index.ts"
export interface PreparedStreamControl {
  signal?: AbortSignal
  onStreamActivity?: LLMRequest['onStreamActivity']
  onTerminalResponse?: LLMRequest['onTerminalResponse']
}
export interface PreparedModelRequest {
  readonly measurement: PreparedRequestMeasurement
  withOutputCap(cap: number | undefined): PreparedModelRequest
  stream(control?: PreparedStreamControl): AsyncIterable<LLMStreamEvent>
}
