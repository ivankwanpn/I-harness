import type { ToolRegistry } from "@i-harness/core-tools"
import type { ConnectedMcpClient, McpConnectOptions } from "../client.ts"
import type { McpServerConfig } from "../types.ts"

export type McpServerState = "connecting" | "ready" | "reconnecting" | "lost"

// Host event (NOT a SessionEventMap member): emitted through the injected
// onStatus callback — headless mounts default to a reportBackgroundFailure-style
// logger; a frontend can subscribe by passing its own onStatus.
export interface McpServerStatusEvent {
  server: string
  state: McpServerState
  attempts?: number
  lastError?: string
  /** M56 (additive): a proactive OAuth refresh failed. Fail-soft — the stored
   *  token is kept and the lifecycle state does NOT change (the 401/M53
   *  reconnect path owns recovery), so `state` stays what it was and the detail
   *  rides in this dedicated field rather than overloading `lastError`. */
  authRefreshFailed?: string
}

export interface SupervisorDeps {
  /** `opts.onToolsChanged` (M6-D3) is the generation's list_changed observation
   *  point — the supervisor passes its own marker, so a connect implementation
   *  that ignores the second argument (a test fake) simply never reports. */
  connect: (c: McpServerConfig, opts?: McpConnectOptions) => Promise<ConnectedMcpClient>
  tools: ToolRegistry
  onStatus?: (ev: McpServerStatusEvent) => void
  /** Invoked when a tool call is rejected because the server is unavailable. */
  onToolUnavailable?: () => void
}

export interface McpSupervisor {
  /** Stable client proxy: routes to the current generation; fails fast with McpServerUnavailableError while the server is unavailable. */
  client(): ConnectedMcpClient
  /** Current server state (mirror of the host-event stream). */
  state(): McpServerState
  /** Establish the first generation (connect + tool sync). Startup failure rejects — mount-level semantics, not the reconnect loop. */
  start(): Promise<void>
  /** Stop the reconnect loop, unregister all tools, close the current generation. Idempotent; no events after close. */
  close(): Promise<void>
  /** M6-D3: true when the server announced `notifications/tools/list_changed`
   *  and no rebuild has consumed it yet. The consumer — session-executor's
   *  `agent/pre-step` handler — reads this to decide whether a rebuild is due;
   *  the flag is per generation (adopt/death both clear it). */
  catalogDirty(): boolean
  /** M6-D3: rebuild the catalogue IN PLACE on the current generation (a fresh
   *  drain of tools/list, no reconnect, no new process). Throws
   *  McpServerUnavailableError when no generation is live — the same fail-fast
   *  error a tool call gets during an outage.
   *
   *  Two paths RESOLVE WITHOUT DRAINING (both leave `catalogDirty()` true, so a
   *  caller that answers "is a rebuild due?" from the flag and retries at the
   *  next boundary is correct — see the two checks in the implementation):
   *  the generation is not `ready` (its own initial/refresh drain is in flight:
   *  that drain IS the rebuild), or a previous drain FAILED within the last
   *  `catalogTimeoutMs` (the failed drain's own budget of quiet, which is what
   *  keeps a stalled server from costing a drain timeout at every boundary). */
  refreshCatalog(): Promise<void>
}
