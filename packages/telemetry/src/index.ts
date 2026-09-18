// packages/telemetry/src/index.ts — public API
export type { TelemetryEventType, TelemetryEvent, TelemetrySink, Telemetry } from "./types.ts"
export { createTelemetry } from "./telemetry.ts"
export { createJsonlSink } from "./jsonl.ts"
// `createMetricsSink` alone: its two result types are not named by any consumer
// (the CLI reads `snapshot()` structurally), and re-exporting them anyway put two
// rows on the reachability gate the moment this landed — the instrument doing its
// job, the same way it did for `toSubagentRoles`. They stay exported from
// metrics.ts, where the signature that produces them lives.
export { createMetricsSink } from "./metrics.ts"
export { TELEMETRY_MANIFEST, TELEMETRY_EVENT_TYPES } from "./manifest.ts"
export type { TelemetryEventCodeDoc } from "./manifest.ts"
