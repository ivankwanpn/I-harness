import type { PluginContext } from "@i-harness/core-plugin"
import type { ToolRegistry } from "@i-harness/core-tools"
import { createConnectedClient, type ConnectedMcpClient } from "./client.ts"
import { createMcpSupervisor, type McpServerStatusEvent, type McpSupervisor } from "./supervisor.ts"
import { validateMcpConfig, type McpServerConfig } from "./types.ts"

export interface McpMountHandle {
  serverName: string
  unmount(): Promise<void>
}

export interface McpMountDeps {
  // Injection seam (tests): a custom connect — the reconnect supervisor rebuilds
  // each generation through this same seam.
  connect?: (c: McpServerConfig) => Promise<ConnectedMcpClient>
  // mcp/server-status host event sink (NOT a SessionEventMap member). Headless
  // mounts default to a reportBackgroundFailure-style logger below.
  onStatus?: (ev: McpServerStatusEvent) => void
}

// Default host-event sink: only background failures are logged (reportBackgroundFailure
// style, mirroring session-persistence's default); connecting/ready stay quiet.
const defaultStatusLogger = (ev: McpServerStatusEvent): void => {
  if (ev.state === "reconnecting" || ev.state === "lost") {
    const detail = [
      ev.lastError,
      ev.attempts !== undefined ? `attempt ${ev.attempts}` : undefined,
    ]
      .filter(Boolean)
      .join("; ")
    console.warn(`[i-harness] mcp-server(${ev.server}) ${ev.state}${detail ? `: ${detail}` : ""}`)
  }
}

// Module-level reservation so a serverName can only ever be live once (a
// second mount with the same name is a hard error, not a silent shadow).
// Mount-level only: supervisor reconnects reuse the same reservation (same
// server, new generation).
const liveServerNames = new Set<string>()

export async function mountMcpClient(
  _ctx: PluginContext,
  tools: ToolRegistry,
  config: McpServerConfig,
  deps?: McpMountDeps,
): Promise<McpMountHandle> {
  validateMcpConfig(config)
  if (liveServerNames.has(config.serverName)) {
    throw new Error(`mcp-client: serverName "${config.serverName}" is already reserved by a live instance`)
  }
  liveServerNames.add(config.serverName)

  // The supervisor owns the generation lifecycle: connect, per-generation tool
  // re-sync, reconnect/backoff, registry unregistration on "lost", and closing.
  let supervisor: McpSupervisor | undefined
  let unmounted = false
  const unmount = async (): Promise<void> => {
    // Idempotent: unmount twice (or after a failed mount) releases once — the
    // flag also guarantees the reservation dies even when connect() failed
    // before anything was registered.
    if (unmounted) return
    unmounted = true
    try {
      await supervisor?.close()
    } finally {
      liveServerNames.delete(config.serverName)
      supervisor = undefined
    }
  }

  try {
    supervisor = createMcpSupervisor(config, {
      tools,
      connect: deps?.connect ?? ((c) => createConnectedClient(c)),
      onStatus: deps?.onStatus ?? defaultStatusLogger,
    })
    await supervisor.start()
  } catch (err) {
    await unmount()
    if (config.failOnStartupError !== false) throw err
    console.warn(`mcp-client(${config.serverName}): start failed (failOnStartupError=false), mounted empty — ${String(err)}`)
    return { serverName: config.serverName, unmount }
  }

  return { serverName: config.serverName, unmount }
}
