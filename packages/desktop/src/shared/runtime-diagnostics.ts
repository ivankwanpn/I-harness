import type { ModelRetryInfo } from "../../../core-session/src/index.ts"

export type RuntimeDiagnosticLevel = "info" | "warning" | "error"
export type RuntimeDiagnosticKind = "model/retry" | "model/recovered" | "session/error" | "session/cancelled" | "gateway/disconnected" | "runtime/error"
/** Native generated facts only; no request bodies, tool arguments or stderr. */
export interface RuntimeDiagnosticEntry {
  id: string
  timestamp: number
  level: RuntimeDiagnosticLevel
  kind: RuntimeDiagnosticKind
  message: string
  workspaceId?: string
  sessionId?: string
  requestId?: string
  code?: string
  httpStatus?: number
  retry?: ModelRetryInfo
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
