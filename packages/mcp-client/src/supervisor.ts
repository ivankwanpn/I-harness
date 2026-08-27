import type { ToolRegistry } from "@i-harness/core-tools"
import type { ConnectedMcpClient } from "./client.ts"
import { syncTools } from "./bridge.ts"
import { createResourceTools } from "./resources.ts"
import { McpServerUnavailableError } from "./errors.ts"
import type { McpServerConfig } from "./types.ts"

// Generation-based reconnect supervisor — absorbed from dsh
// packages/mcp/mcp-client/src/connection.ts (MIT — see THIRD_PARTY_NOTICES):
//   - every reconnect builds a NEW client + transport (a "generation");
//   - transport death → generationDown (isCurrent guard makes it idempotent);
//   - backoff min(maxDelayMs, initialDelayMs * 2^(n-1)); a generation that
//     stays alive ≥ maxDelayMs (stability window) resets the attempt budget;
//   - beyond maxRetries: unregister ALL tools, stop reconnecting, emit "lost";
//   - overlap guard: a failing generation must close within 5s or reconnecting
//     stops, so stdio child processes for one server never overlap;
//   - every generation re-syncs: syncTools two-phase swap + resource tools
//     re-bound (unregister old names → register new).

export type McpServerState = "connecting" | "ready" | "reconnecting" | "lost"

// Host event (NOT a SessionEventMap member): emitted through the injected
// onStatus callback — headless mounts default to a reportBackgroundFailure-style
// logger; a frontend can subscribe by passing its own onStatus.
export interface McpServerStatusEvent {
  server: string
  state: McpServerState
  attempts?: number
  lastError?: string
}

export interface SupervisorDeps {
  connect: (c: McpServerConfig) => Promise<ConnectedMcpClient>
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
}

const DEFAULT_INITIAL_DELAY_MS = 1_000
const DEFAULT_MAX_DELAY_MS = 30_000
const DEFAULT_MAX_RETRIES = 5
// dsh overlap guard: a failing generation must close within 5s or reconnecting
// stops (never two live stdio children for one server).
const OVERLAP_GUARD_MS = 5_000

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// Timers must never keep the process alive past unmount (see lifecycle tests):
// every supervisor timer is cleared on close, and unref'd as belt-and-braces.
const unref = (timer: ReturnType<typeof setTimeout>): void => {
  ;(timer as unknown as { unref?: () => void }).unref?.()
}

export function createMcpSupervisor(config: McpServerConfig, deps: SupervisorDeps): McpSupervisor {
  const { serverName } = config
  const reconnectEnabled = config.reconnect?.enabled === true
  const initialDelayMs = config.reconnect?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  const maxDelayMs = config.reconnect?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const maxRetries = config.reconnect?.maxRetries ?? DEFAULT_MAX_RETRIES

  let state: McpServerState = "connecting"
  let current: ConnectedMcpClient | undefined
  let closed = false
  let attempts = 0
  let lastError: string | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let stabilityTimer: ReturnType<typeof setTimeout> | undefined
  let disposers = new Map<string, () => void>()
  let resourceToolNames: string[] = []

  const emitStatus = (next: McpServerState, attemptCount?: number, err?: string): void => {
    if (closed) return
    deps.onStatus?.({
      server: serverName,
      state: next,
      ...(attemptCount !== undefined ? { attempts: attemptCount } : {}),
      ...(err !== undefined ? { lastError: err } : {}),
    })
  }

  const unavailable = (): McpServerUnavailableError => {
    deps.onToolUnavailable?.()
    return new McpServerUnavailableError(serverName)
  }

  // Stable proxy handed to the registry (tool closures bind THIS object, never
  // a raw generation client): every call consults the current generation at
  // call time, so a call during an outage fails fast instead of hanging on a
  // dead transport.
  const proxy: ConnectedMcpClient = {
    async listTools(cursor) {
      const gen = current
      if (gen === undefined) throw unavailable()
      return gen.listTools(cursor)
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

  const clearRetry = (): void => {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
  }

  const clearStability = (): void => {
    if (stabilityTimer !== undefined) {
      clearTimeout(stabilityTimer)
      stabilityTimer = undefined
    }
  }

  // Close a generation, bounded by `ms` (the overlap guard). Resolves true when
  // the generation closed (or its close errored — an errored close of an
  // already-dead client still means it is gone), false on timeout.
  const closeWithin = async (gen: ConnectedMcpClient, ms: number): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race<boolean>([
        gen.close().then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), ms)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  const unregisterAll = (): void => {
    for (const dispose of disposers.values()) dispose()
    disposers = new Map()
    for (const name of resourceToolNames) deps.tools.unregister(name)
    resourceToolNames = []
  }

  // Terminal state: stop reconnecting, drop every tool of this server, emit
  // "lost" (once — guarded by closed/state transitions in the callers).
  const goLost = (err?: unknown): void => {
    clearRetry()
    clearStability()
    current = undefined
    state = "lost"
    if (err !== undefined) lastError = errText(err)
    unregisterAll()
    emitStatus("lost", attempts, lastError)
  }

  // Failure of the CURRENT cycle (the generation is already down or never
  // came up): decide retry-vs-lost and schedule the next attempt with
  // exponential backoff. Exactly one caller per cycle — the generationDown
  // isCurrent guard and the attempt flow guarantee that.
  const failCycle = (err: unknown | undefined): void => {
    if (closed) return
    if (err !== undefined) lastError = errText(err)
    const next = attempts + 1
    if (next > maxRetries) {
      goLost()
      return
    }
    state = "reconnecting"
    emitStatus("reconnecting", next, lastError)
    const delay = Math.min(maxDelayMs, initialDelayMs * 2 ** (next - 1))
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void attempt(next)
    }, delay)
    unref(retryTimer)
  }

  // Death of the current generation (transport closed on its own). The
  // isCurrent guard makes this idempotent: stale or duplicate notifications
  // (e.g. a late onclose from a deliberately closed old generation) are no-ops.
  const generationDown = (gen: ConnectedMcpClient): void => {
    if (closed) return
    if (gen !== current) return
    current = undefined
    clearStability()
    failCycle(undefined)
  }

  const resyncTools = async (): Promise<void> => {
    // Two-phase swap (bridge.ts): dispose the previous generation's tools,
    // then fetch + register the fresh list from the new generation. Resource
    // tools are re-bound per generation as well.
    disposers = await syncTools(proxy, deps.tools, config, disposers)
    for (const name of resourceToolNames) deps.tools.unregister(name)
    const resourceTools = createResourceTools(proxy, serverName, config)
    resourceToolNames = resourceTools.map((t) => t.name)
    for (const rt of resourceTools) deps.tools.register(rt)
  }

  const armStability = (gen: ConnectedMcpClient): void => {
    clearStability()
    stabilityTimer = setTimeout(() => {
      stabilityTimer = undefined
      // Stability window: a generation alive ≥ maxDelayMs resets the attempt
      // budget, so a long-lived server never accumulates stale failures.
      if (!closed && current === gen) attempts = 0
    }, maxDelayMs)
    unref(stabilityTimer)
  }

  const adoptGeneration = (gen: ConnectedMcpClient): void => {
    current = gen
    // Observe transport death only when the reconnect machinery is on — the
    // default (no reconnect config) must behave exactly like a one-shot mount.
    if (reconnectEnabled) gen.onDisconnect?.(() => generationDown(gen))
  }

  const attempt = async (n: number): Promise<void> => {
    if (closed) return
    attempts = n
    let gen: ConnectedMcpClient
    try {
      gen = await deps.connect(config)
    } catch (err) {
      failCycle(err)
      return
    }
    if (closed) {
      await closeWithin(gen, OVERLAP_GUARD_MS)
      return
    }
    adoptGeneration(gen)
    try {
      await resyncTools()
    } catch (err) {
      if (closed) {
        await closeWithin(gen, OVERLAP_GUARD_MS)
        return
      }
      // The failed generation must be closed before the next one spawns — if
      // it cannot close within the overlap guard, stop reconnecting rather
      // than risk two overlapping stdio child processes.
      current = undefined
      const didClose = await closeWithin(gen, OVERLAP_GUARD_MS)
      if (closed) return
      if (!didClose) {
        goLost(`${errText(err)} (generation failed to close within ${OVERLAP_GUARD_MS}ms — overlap guard)`)
        return
      }
      failCycle(err)
      return
    }
    state = "ready"
    emitStatus("ready")
    armStability(gen)
  }

  const start = async (): Promise<void> => {
    if (closed) throw new Error(`mcp-client(${serverName}): supervisor already closed`)
    emitStatus("connecting")
    let gen: ConnectedMcpClient
    try {
      gen = await deps.connect(config)
    } catch (err) {
      // Startup failure is a MOUNT failure (scheduler applies failOnStartupError
      // semantics) — the reconnect loop only engages once a generation exists.
      lastError = errText(err)
      throw err
    }
    if (closed) {
      await closeWithin(gen, OVERLAP_GUARD_MS)
      throw new Error(`mcp-client(${serverName}): supervisor closed during startup`)
    }
    adoptGeneration(gen)
    try {
      await resyncTools()
    } catch (err) {
      // Startup sync failure: also a mount failure — close the live generation
      // (bounded by the overlap guard so no child process lingers) and propagate.
      current = undefined
      await closeWithin(gen, OVERLAP_GUARD_MS)
      lastError = errText(err)
      throw err
    }
    state = "ready"
    emitStatus("ready")
    if (reconnectEnabled) armStability(gen)
  }

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true // FIRST: no further emits; death notifications become no-ops
    clearRetry()
    clearStability()
    const gen = current
    current = undefined
    state = "lost"
    unregisterAll()
    if (gen !== undefined) await closeWithin(gen, OVERLAP_GUARD_MS)
  }

  return {
    client: () => proxy,
    state: () => state,
    start,
    close,
  }
}
