import type { PluginContext } from "@i-harness/core-plugin"
import type { ToolRegistry } from "@i-harness/core-tools"
import { createConnectedClient, type ConnectedMcpClient } from "./client.ts"
import { syncTools } from "./bridge.ts"
import { createResourceTools } from "./resources.ts"
import { validateMcpConfig, type McpServerConfig } from "./types.ts"

export interface McpMountHandle {
  serverName: string
  unmount(): Promise<void>
}

// Module-level reservation so a serverName can only ever be live once (a
// second mount with the same name is a hard error, not a silent shadow).
const liveServerNames = new Set<string>()

export async function mountMcpClient(
  _ctx: PluginContext,
  tools: ToolRegistry,
  config: McpServerConfig,
  deps?: { connect?: (c: McpServerConfig) => Promise<ConnectedMcpClient> },
): Promise<McpMountHandle> {
  validateMcpConfig(config)
  if (liveServerNames.has(config.serverName)) {
    throw new Error(`mcp-client: serverName "${config.serverName}" is already reserved by a live instance`)
  }
  liveServerNames.add(config.serverName)

  let client: ConnectedMcpClient | undefined
  let disposers = new Map<string, () => void>()
  let resourceToolNames: string[] = []
  let unmounted = false
  const unmount = async (): Promise<void> => {
    // Idempotent: unmount twice (or after a failed mount) releases once — the
    // flag also guarantees the reservation dies even when connect() failed
    // before anything was registered.
    if (unmounted) return
    unmounted = true
    try {
      for (const dispose of disposers.values()) dispose()
      for (const name of resourceToolNames) tools.unregister(name)
      if (client) await client.close()
    } finally {
      liveServerNames.delete(config.serverName)
      client = undefined
      disposers = new Map()
      resourceToolNames = []
    }
  }

  try {
    client = deps?.connect ? await deps.connect(config) : await createConnectedClient(config)
    disposers = await syncTools(client, tools, config)
    const resourceTools = createResourceTools(client, config.serverName, config)
    resourceToolNames = resourceTools.map((t) => t.name)
    for (const rt of resourceTools) tools.register(rt)
  } catch (err) {
    await unmount()
    if (config.failOnStartupError !== false) throw err
    console.warn(`mcp-client(${config.serverName}): start failed (failOnStartupError=false), mounted empty — ${String(err)}`)
    return { serverName: config.serverName, unmount }
  }

  return { serverName: config.serverName, unmount }
}
