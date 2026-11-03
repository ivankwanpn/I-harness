import type { ConnectedMcpClient, McpConnectOptions } from "../client.ts"
import { McpServerUnavailableError } from "../errors.ts"
import type { McpServerConfig } from "../types.ts"
import type { SupervisorDeps } from "./types.ts"
import type { SupervisorStatus } from "./status.ts"
import type { SupervisorCatalogue } from "./catalogue.ts"
import { closeWithin, OVERLAP_GUARD_MS } from "./disposal.ts"

/** Sole current-generation authority and stable proxy; startup remains a mount failure. */
export function createSupervisorGeneration(
  config: McpServerConfig,
  deps: Pick<SupervisorDeps, "connect" | "onToolUnavailable">,
  serverName: string,
  reconnectEnabled: boolean,
  status: Pick<SupervisorStatus, "isClosed" | "emitStatus" | "recordError" | "setState">,
  catalogue: Pick<SupervisorCatalogue, "resetForGeneration" | "resyncTools" | "markCatalogDirty">,
  generationDown: (gen: ConnectedMcpClient) => void,
  armStability: (gen: ConnectedMcpClient) => void,
) {
  let current: ConnectedMcpClient | undefined

  const unavailable = (): McpServerUnavailableError => {
    deps.onToolUnavailable?.()
    return new McpServerUnavailableError(serverName)
  }

  // Stable proxy handed to the registry (tool closures bind THIS object, never
  // a raw generation client): every call consults the current generation at
  // call time, so a call during an outage fails fast instead of hanging on a
  // dead transport.
  const proxy: ConnectedMcpClient = {
    // M6-D2/D3: `opts` travels with the call. Dropping it here would keep the
    // drain's per-page bound (timeout / maxTotalTimeout) from ever reaching the
    // SDK on the production path — the drain would be bounded in total but no
    // single page request would carry its share of the budget.
    async listTools(cursor, opts) {
      const gen = current
      if (gen === undefined) throw unavailable()
      return gen.listTools(cursor, opts)
    },
    async callTool(name, args, signal) {
      const gen = current
      if (gen === undefined) throw unavailable()
      return gen.callTool(name, args, signal)
    },
    async listResources(server, signal) {
      const gen = current
      if (gen === undefined) throw unavailable()
      return gen.listResources(server, signal)
    },
    async readResource(server, uri, signal) {
      const gen = current
      if (gen === undefined) throw unavailable()
      return gen.readResource(server, uri, signal)
    },
    async close() {
      const gen = current
      if (gen === undefined) throw unavailable()
      return gen.close()
    },
  }

  const adopt = (gen: ConnectedMcpClient): void => {
    current = gen
    // M6-D3: a new generation starts CLEAN — its connect() just drained the
    // catalogue, and anything the previous generation announced is about a
    // list that no longer exists. Its failed-refresh backoff dies with it too:
    // the generation drains itself below (attempt/start), and whatever went
    // wrong on the previous generation's drain is not this one's.
    catalogue.resetForGeneration()
    // Observe transport death only when the reconnect machinery is on — the
    // default (no reconnect config) must behave exactly like a one-shot mount.
    if (reconnectEnabled) gen.onDisconnect?.(() => generationDown(gen))
  }

  // Preserve the shared marker's original callback lifetime, including retired clients.
  const connectOptions: McpConnectOptions = { onToolsChanged: catalogue.markCatalogDirty }

  const start = async (): Promise<void> => {
    if (status.isClosed()) throw new Error(`mcp-client(${serverName}): supervisor already closed`)
    status.emitStatus("connecting")
    let gen: ConnectedMcpClient
    try {
      gen = await deps.connect(config, connectOptions)
    } catch (err) {
      // Startup failure is a MOUNT failure (scheduler applies failOnStartupError
      // semantics) — the reconnect loop only engages once a generation exists.
      status.recordError(err)
      throw err
    }
    if (status.isClosed()) {
      await closeWithin(gen, OVERLAP_GUARD_MS)
      throw new Error(`mcp-client(${serverName}): supervisor closed during startup`)
    }
    adopt(gen)
    try {
      await catalogue.resyncTools()
    } catch (err) {
      // Startup sync failure: also a mount failure — close the live generation
      // (bounded by the overlap guard so no child process lingers) and propagate.
      current = undefined
      await closeWithin(gen, OVERLAP_GUARD_MS)
      status.recordError(err)
      throw err
    }
    status.setState("ready")
    status.emitStatus("ready")
    if (reconnectEnabled) armStability(gen)
  }

  return {
    current: () => current,
    withdraw: (): void => { current = undefined },
    proxy,
    connectOptions,
    adopt,
    start,
  }
}

export type SupervisorGeneration = ReturnType<typeof createSupervisorGeneration>
