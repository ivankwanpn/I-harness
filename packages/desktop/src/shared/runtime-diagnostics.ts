import type { ModelRetryInfo, ModelActivityInfo } from "../../../core-session/src/index.ts"
import type { ModelFailureFacts } from "@i-harness/sdk"

export type RuntimeDiagnosticLevel = "info" | "warning" | "error"
export type RuntimeDiagnosticKind = "model/retry" | "model/recovered" | "model/connecting" | "model/quiet" | "model/settled" | "session/error" | "session/cancelled" | "gateway/disconnected" | "runtime/error" | "context/budget" | "context/request" | "context/compaction"
export interface RuntimeActivity { workspaceId: string; sessionId: string; activity: ModelActivityInfo }
/** Native generated facts only; no request bodies, tool arguments or stderr. */
export interface RuntimeDiagnosticEntry {
  projectId?: string
  providerId?: string
  modelId?: string
  runtimeGeneration?: number
  requestMetrics?: import("@i-harness/usage-stats").RequestMetrics
  compaction?: import("@i-harness/desktop-gateway/src/context-diagnostics.ts").CompactionDiagnostic
  contextBudget?: { estimatedInputTokens: number; outputReserve: number; contextWindow?: number; effectiveOutputCap?: number; safetyMargin: number; coverage: string; estimateSource: string; capSupport: string; admission: string; recoveryRequired: boolean; fullByProvider: boolean }
  close?: { generation: number; reason: "scope-changed" | "subprocess-exited" | "manager-closed" }
  id: string
  timestamp: number
  level: RuntimeDiagnosticLevel
  kind: RuntimeDiagnosticKind
  message: string
  workspaceId?: string
  sessionId?: string
  requestId?: string
  /** A legacy terminal notification arrived while execution was still busy;
   * retain the diagnostic without settling or attributing current feedback. */
  executionUncorrelated?: true
  code?: string
  httpStatus?: number
  modelFailure?: ModelFailureFacts
  retry?: ModelRetryInfo
  waitingFor?: ModelActivityInfo["waitingFor"]
  outcome?: ModelActivityInfo["outcome"]
}
export interface RuntimeDiagnosticFilter {
  workspaceId?: string
  sessionId?: string
  level?: RuntimeDiagnosticLevel
  query?: string
}
export interface RuntimeDiagnosticList { entries: RuntimeDiagnosticEntry[]; storageError?: string }
export type RuntimeDiagnosticsRequest =
  | ({ kind: "desktop/diagnostics/list" | "desktop/diagnostics/export" } & RuntimeDiagnosticFilter)
  | { kind: "desktop/diagnostics/copy"; id: string }
  | { kind: "desktop/diagnostics/reveal" }
export type GlobalRetryRequest =
  | { kind: "desktop/global-retry/state" }
  | { kind: "desktop/global-retry/configure"; maxRetries: number }
export interface GlobalRetryState { maxRetries: number }
export type GlobalModelWaitRequest =
  | { kind: "desktop/global-model-wait/state" }
  | { kind: "desktop/global-model-wait/configure"; firstResponseSeconds: number; progressSeconds: number }
export interface GlobalModelWaitState { firstResponseSeconds: number; progressSeconds: number }
