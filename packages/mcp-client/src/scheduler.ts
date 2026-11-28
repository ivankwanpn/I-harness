import type { PluginContext } from "@i-harness/core-plugin"
import { diagnosticsFor } from "@i-harness/diagnostics"
import type { ToolRegistry } from "@i-harness/core-tools"
import type { ConnectedMcpClient, McpConnectOptions } from "./client.ts"
import type { McpServerStatusEvent, McpSupervisor } from "./supervisor.ts"
import { McpServerUnavailableError } from "./errors.ts"
import { validateMcpConfig, type McpServerConfig } from "./types.ts"

// W6 T6: ONE module-scope handle for this file's reports; the phase is
// `mount` because both are the MCP seam's own reports about a server it is
// mounting: a background reconnect/lost status, and a start failure kept soft
// by failOnStartupError=false. With nothing installed the handle delegates to
// console.warn verbatim (one argument), so unset mode is the pre-migration
// bytes.
const d = diagnosticsFor("mount")

export interface McpMountHandle {
  serverName: string
  /** M6-D3: the server announced `notifications/tools/list_changed` and no
   *  rebuild has consumed it (per generation). The consumer — session-executor's
   *  `agent/pre-step` handler — asks this before rebuilding; it is never true
   *  for a mount that came up empty (failOnStartupError=false). */
  catalogDirty(): boolean
  /** M6-D3: rebuild the catalogue in place on the current generation. Throws
   *  McpServerUnavailableError when nothing is live (mount-empty or outage).
   *  Resolves WITHOUT draining when no rebuild is due yet — the generation is
   *  mid-connect/reconnect (its own drain is the rebuild), or a previous drain
   *  failed inside its backoff window. Either way `catalogDirty()` stays true,
   *  so "ask the flag, then refresh" is the caller's contract. */
  refreshCatalog(signal?: AbortSignal): Promise<void>
  unmount(): Promise<void>
}

export interface McpMountDeps {
  workspace?: string
  // Injection seam (tests): a custom connect — the reconnect supervisor rebuilds
  // each generation through this same seam. `opts` carries the list_changed
  // observation point (M6-D3); a fake that ignores it simply never reports.
  connect?: (c: McpServerConfig, opts?: McpConnectOptions) => Promise<ConnectedMcpClient>
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
    d.warn(`[i-harness] mcp-server(${ev.server}) ${ev.state}${detail ? `: ${detail}` : ""}`)
  }
}

// Reserve within the owning tool registry. Independent session registries may
// use the same logical server name without shadowing each other's tools.
// Mount-level only: supervisor reconnects reuse the same reservation (same
// server, new generation).
const reservations = new WeakMap<ToolRegistry, Map<string, object>>()
const failedMountCleanups = new WeakMap<object, () => Promise<void>>()

/** Recover only the exact unpublished owner exposed by a failed mount. */
export function readMcpFailedMountCleanup(error: unknown): (() => Promise<void>) | undefined {
  return typeof error === "object" && error !== null ? failedMountCleanups.get(error) : undefined
}

export async function mountMcpClient(
  _ctx: PluginContext,
  tools: ToolRegistry,
  config: McpServerConfig,
  deps?: McpMountDeps,
): Promise<McpMountHandle> {
  validateMcpConfig(config)
  let liveServerNames = reservations.get(tools)
  if (!liveServerNames) { liveServerNames = new Map(); reservations.set(tools, liveServerNames) }
  const serverName = config.serverName
  if (liveServerNames.has(serverName)) {
    throw new Error(`mcp-client: serverName "${serverName}" is already reserved by a live instance`)
  }
  const reservation = {}
  liveServerNames.set(serverName, reservation)

  // The supervisor owns the generation lifecycle: connect, per-generation tool
  // re-sync, reconnect/backoff, registry unregistration on "lost", and closing.
  let supervisor: McpSupervisor | undefined
  const release = () => {
    if (liveServerNames.get(serverName) === reservation) liveServerNames.delete(serverName)
    supervisor = undefined
  }
  const unmount = (): Promise<void> => {
    if (!supervisor) {
      release()
      return Promise.resolve()
    }
    return supervisor.close()
  }

  // M6-D3: the two catalogue surfaces. Both route through the MUTABLE
  // `supervisor` binding (never a captured one), so a boundary that arrives
  // after unmount — or after a mount that came up empty — sees "nothing live":
  // clean, and unavailable on refresh, instead of a stale handle.
  const handle: McpMountHandle = {
    serverName,
    catalogDirty: () => supervisor?.catalogDirty() ?? false,
    refreshCatalog: async (signal) => {
      const live = supervisor
      if (live === undefined) throw new McpServerUnavailableError(config.serverName)
      await live.refreshCatalog(signal)
    },
    unmount,
  }

  try {
    const [{ createMcpSupervisorOwner }, { createConnectedClient }] = await Promise.all([
      import("./supervisor.ts"), import("./client.ts"),
    ])
    const owned = createMcpSupervisorOwner(config, {
      tools,
      connect: (c, o) => (deps?.connect ?? createConnectedClient)(c, deps?.workspace === undefined ? o : { ...o, workspace: deps.workspace }),
      onStatus: deps?.onStatus ?? defaultStatusLogger,
    })
    supervisor = owned.supervisor
    void owned.released.then(release)
    await supervisor.start()
  } catch (err) {
    try { await unmount() }
    catch (cleanup) {
      const failure = new AggregateError([err, cleanup], `MCP ${serverName} startup and original cleanup failed`, { cause: err })
      failedMountCleanups.set(failure, unmount)
      throw failure
    }
    if (config.failOnStartupError !== false) throw err
    d.warn(`mcp-client(${config.serverName}): start failed (failOnStartupError=false), mounted empty — ${String(err)}`)
  }

  return handle
}
