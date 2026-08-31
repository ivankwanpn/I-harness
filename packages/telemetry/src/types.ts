// packages/telemetry/src/types.ts — host 事件流（與 session log 分離；agent 不可見）

export type TelemetryEventType =
  | "session/start"
  | "session/end"
  | "session/request" // an inbound prompt submitted to the SessionService (R-C6)
  | "session/queued" // the submit chained behind an active turn (per-session serial, R-C6)
  | "session/error" // a run failed / rejected (R-C6)
  | "turn/start"
  | "turn/end"
  | "tool/start"
  | "tool/end"
  | "tool/error"
  | "provider/call"
  | "provider/error"
  | "token/usage"
  | "retry/start"
  | "error"
  | "warn"
  | "mcp/server-status"

export interface TelemetryEvent {
  type: TelemetryEventType
  /** Date.now() at emit time */
  ts: number
  /** sessionId?, tool name/callId, provider, tokens, message... */
  data: Record<string, unknown>
}

export interface TelemetrySink {
  /**
   * sync 或 async sink 皆可：Promise 回傳型別可賦值給 void（TS void 回傳共變），
   * emit 以 instanceof Promise 隔離 rejection（fail-visible warn）。
   * 註：規格原文 `void | Promise<void>` 與 verbatim 測試（arrow 回傳 number）在 strict TS 下不相容——
   * union 回傳會失去 void 特殊賦值規則，故此處宣告 void（語義等價）。
   */
  onEvent(ev: TelemetryEvent): void
}

export interface Telemetry {
  /** 多播到所有 sinks；sink 錯誤 → console.warn（fail-visible，不中斷其他 sinks） */
  emit(ev: TelemetryEvent): void
  /** v0 為 no-op flush：需要 flush/close 的 sink 自行處理（如 stream.end()） */
  close(): void
}
