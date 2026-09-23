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
  // M5 T2: the provider's OWN usage report for one round-trip — a fact, kept
  // apart from `token/usage`, which carries our estimate of the same surface.
  | "provider/usage"
  // M72 Ⅱ: that round-trip ended at the output cap (the seam's `end.truncated`,
  // decided by each adapter's own terminal literal). One event per truncated
  // round-trip, so the count is the denominator: a run with no event here is a
  // run whose provider stopped on its own, never "we did not look".
  | "provider/truncated"
  // M77: the provider REFUSED to produce content for that round-trip (the
  // seam's `end.refused`, set by each adapter's own refusal literal). Same
  // discipline as the row above: one event per refused round-trip, so the count
  // is the denominator — a run with no event here is a run whose provider never
  // refused. Independent of `provider/truncated`: one round-trip can be both.
  | "provider/refused"
  | "token/usage"
  | "retry/start"
  | "error"
  | "warn"
  | "mcp/server-status"
  // M27 R-B6: skills shadow selector report (deterministic; sinks may ignore)
  | "skill/selector-shadow"
  // M27 R-E10: layered settings hot-reload change notification
  | "settings/changed"
  // M34 ⑦b: compaction attempt conclusion (success | prune-only | failure | skipped)
  | "compaction/attempt"

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
