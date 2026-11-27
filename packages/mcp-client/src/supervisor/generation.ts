import { readMcpFailedConnectionCleanup, type ConnectedMcpClient, type McpConnectOptions } from "../client.ts"
import { McpServerUnavailableError } from "../errors.ts"
import type { McpServerConfig } from "../types.ts"
import type { SupervisorDeps } from "./types.ts"
import type { SupervisorStatus } from "./status.ts"
import type { SupervisorCatalogue } from "./catalogue.ts"
import { waitForMcpClose, type SupervisorLifetime } from "./disposal.ts"

/** Sole current-generation authority and stable proxy; startup remains a mount failure. */
export function createSupervisorGeneration(
  config: McpServerConfig,
  deps: Pick<SupervisorDeps, "connect" | "onToolUnavailable">,
  serverName: string,
  reconnectEnabled: boolean,
  status: Pick<SupervisorStatus, "isClosed" | "emitStatus" | "recordError" | "setState">,
  catalogue: Pick<SupervisorCatalogue, "resetForGeneration" | "resyncTools" | "markCatalogDirty">,
  lifetime: Pick<SupervisorLifetime, "beginConnect" | "retire">,
  generationDown: (gen: ConnectedMcpClient) => void,
  armStability: (gen: ConnectedMcpClient) => void,
) {
  let current: ConnectedMcpClient | undefined, currentAttempt: object | undefined

  const unavailable = (): McpServerUnavailableError => {
    deps.onToolUnavailable?.()
    return new McpServerUnavailableError(serverName)
  }

  // Stable proxy handed to the registry (tool closures bind THIS object, never
  // a raw generation client): every call consults the current generation at
  // call time, so a call during an outage fails fast instead of hanging on a
  // dead transport.
  const proxy: ConnectedMcpClient = {
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
    async listResourceTemplates(signal) {
      const gen = current
      if (gen === undefined) throw unavailable()
      if (!gen.listResourceTemplates) throw new Error(`mcp-server(${serverName}): resources/templates/list unsupported by this build's client`)
      return gen.listResourceTemplates(signal)
    },
    async readResource(server, uri, signal) {
      const gen = current
      if (gen === undefined) throw unavailable()
      return gen.readResource(server, uri, signal)
    },
    async close() {
      const gen = current
      if (gen === undefined) throw unavailable()
      return lifetime.retire(gen)
    },
  }

  const withdraw = () => { current = undefined; currentAttempt = undefined }
  const beginConnect = () => {
    const finish = lifetime.beginConnect(), token = {}
    const finishFailure = (error: unknown) => {
      const close = readMcpFailedConnectionCleanup(error)
      const owner = close ? { close } : undefined
      finish(owner)
      return owner
    }
    const isCurrent = () => currentAttempt === token && !status.isClosed()
    const options: McpConnectOptions = { onToolsChanged() {
      if (isCurrent()) catalogue.markCatalogDirty()
    } }
    return { finish, finishFailure, options, isCurrent, adopt(gen: ConnectedMcpClient) {
      current = gen
      currentAttempt = token
      // The first full drain observes startup announcements. After adoption
      // only this generation may mark its catalogue dirty.
      catalogue.resetForGeneration()
      if (reconnectEnabled) gen.onDisconnect?.(() => { if (isCurrent()) generationDown(gen) })
    } }
  }

  const start = async (): Promise<void> => {
    if (status.isClosed()) throw new Error(`mcp-client(${serverName}): supervisor already closed`)
    status.emitStatus("connecting")
    if (status.isClosed()) throw new Error(`mcp-client(${serverName}): supervisor closed during startup`)
    const attempt = beginConnect()
    let gen: ConnectedMcpClient
    try {
      gen = await deps.connect(config, attempt.options)
    } catch (err) {
      attempt.finishFailure(err)
      // Startup failure is a MOUNT failure (scheduler applies failOnStartupError
      // semantics) — the reconnect loop only engages once a generation exists.
      status.recordError(err)
      throw err
    }
    attempt.finish(gen)
    if (status.isClosed()) {
      await waitForMcpClose(lifetime.retire(gen), serverName).catch(() => { /* Close still owns unresolved cleanup. */ })
      throw new Error(`mcp-client(${serverName}): supervisor closed during startup`)
    }
    try {
      attempt.adopt(gen)
      if (!attempt.isCurrent()) throw new Error(`mcp-client(${serverName}): generation retired during startup`)
      await catalogue.resyncTools()
      if (!attempt.isCurrent()) throw new Error(`mcp-client(${serverName}): generation retired during startup`)
    } catch (err) {
      if (attempt.isCurrent()) {
        status.recordError(err)
        withdraw()
        await waitForMcpClose(lifetime.retire(gen), serverName).catch(() => { /* The original mount retains cleanup. */ })
      }
      throw err
    }
    status.setState("ready")
    status.emitStatus("ready")
    if (reconnectEnabled && attempt.isCurrent()) armStability(gen)
  }

  return {
    current: () => current,
    withdraw,
    proxy,
    beginConnect,
    start,
  }
}

export type SupervisorGeneration = ReturnType<typeof createSupervisorGeneration>
