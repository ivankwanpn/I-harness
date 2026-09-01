// packages/telemetry/src/manifest.ts — R-C6: the manifest-level event code
// registry. One row per code the runtime ACTUALLY emits (never a code without
// a producer). `refs` maps to the five-source audit's names (opencode ~60
// codes / codex event notification sets) so the vocabulary drift questions are
// answered inside the repo (audit 2026-08-31 §6), while the i-harness codes
// stay OUR stable set.
import type { TelemetryEventType } from "./types.ts"

export interface TelemetryEventCodeDoc {
  code: TelemetryEventType
  domain: "session" | "turn" | "tool" | "provider" | "token" | "retry" | "mcp" | "system"
  description: string
  refs?: string[]
}

export const TELEMETRY_MANIFEST = [
  { code: "session/start", domain: "session", description: "A session run/assembly started", refs: ["opencode session/start"] },
  { code: "session/end", domain: "session", description: "A session run ended with exitCode", refs: ["opencode session/end"] },
  { code: "session/request", domain: "session", description: "An inbound prompt submitted to the session service", refs: ["opencode session.next.prompt"] },
  { code: "session/queued", domain: "session", description: "The submit chained behind an active turn of the same session", refs: ["opencode session.next.admit", "codex queue"] },
  { code: "session/error", domain: "session", description: "A run failed / rejected", refs: ["codex turn error"] },
  { code: "turn/start", domain: "turn", description: "An agent turn started", refs: ["opencode turn/start"] },
  { code: "turn/end", domain: "turn", description: "An agent turn ended", refs: ["opencode turn/end"] },
  { code: "tool/start", domain: "tool", description: "A tool call started", refs: ["opencode tool/start"] },
  { code: "tool/end", domain: "tool", description: "A tool call ended successfully", refs: ["opencode tool/end"] },
  { code: "tool/error", domain: "tool", description: "A tool call failed", refs: ["opencode tool/error"] },
  { code: "provider/call", domain: "provider", description: "A provider round-trip began", refs: ["opencode provider/start"] },
  { code: "provider/error", domain: "provider", description: "A provider round-trip failed", refs: ["opencode provider/error"] },
  { code: "token/usage", domain: "token", description: "Token usage accounted after a turn", refs: ["opencode token/usage", "codex token/usage"] },
  { code: "retry/start", domain: "retry", description: "A tool retry (guard-retry) started", refs: ["codex retry"] },
  { code: "mcp/server-status", domain: "mcp", description: "MCP server mount/status transition", refs: ["opencode mcp/*"] },
  { code: "skill/selector-shadow", domain: "system", description: "Skills shadow selector candidate report (deterministic; sinks may ignore)", refs: ["codex shadow selector"] },
  { code: "settings/changed", domain: "system", description: "Layered settings document changed on disk (hot-reload)", refs: ["dsh settings-file watcher"] },
  { code: "error", domain: "system", description: "Unclassified host error", refs: [] },
  { code: "warn", domain: "system", description: "Unclassified host warning", refs: [] },
] as const satisfies readonly TelemetryEventCodeDoc[]

export const TELEMETRY_EVENT_TYPES: readonly TelemetryEventType[] = TELEMETRY_MANIFEST.map((row) => row.code)
