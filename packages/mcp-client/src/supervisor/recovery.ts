import type { ConnectedMcpClient } from "../client.ts"
import type { McpServerConfig } from "../types.ts"
import type { SupervisorDeps } from "./types.ts"
import type { SupervisorStatus } from "./status.ts"
import { errText } from "./status.ts"
import type { SupervisorCatalogue } from "./catalogue.ts"
import type { SupervisorGeneration } from "./generation.ts"
import { unref, waitForMcpClose, type SupervisorLifetime } from "./disposal.ts"

/** Owns retry/stability timers and cycle decisions; it never mirrors the generation. */
export function createSupervisorRecovery(
  config: McpServerConfig,
  deps: Pick<SupervisorDeps, "connect">,
  serverName: string,
  initialDelayMs: number,
  maxDelayMs: number,
  maxRetries: number,
  status: Pick<SupervisorStatus,
    "state" | "setState" | "isClosed" | "attempts" | "setAttempts" | "lastError" | "recordError" | "emitStatus">,
  generation: Pick<SupervisorGeneration, "current" | "withdraw" | "beginConnect">,
  catalogue: Pick<SupervisorCatalogue, "clearDirty" | "unregisterAll" | "resyncTools">,
  lifetime: Pick<SupervisorLifetime, "retire">,
) {
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let stabilityTimer: ReturnType<typeof setTimeout> | undefined

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

  const goLost = (err?: unknown): void => {
    if (status.state() === "lost") return // idempotent: "lost" is terminal — never emitted twice
    clearRetry()
    clearStability()
    generation.withdraw()
    catalogue.clearDirty() // M6-D3: nothing live to rebuild on; the tools go too
    status.setState("lost")
    if (err !== undefined) status.recordError(err)
    catalogue.unregisterAll()
    status.emitStatus("lost", status.attempts(), status.lastError())
  }

  const failCycle = (err: unknown | undefined, predecessor?: Promise<void>): void => {
    if (status.isClosed()) return
    if (err !== undefined) status.recordError(err)
    const next = status.attempts() + 1
    if (next > maxRetries) {
      goLost()
      return
    }
    status.setState("reconnecting")
    status.emitStatus("reconnecting", next, status.lastError())
    if (status.isClosed()) return
    // Idempotent scheduling: drop any pending retry timer BEFORE arming the
    // next one — two failCycle runs for one failed cycle must never leave two
    // armed timers (both would fire → attempt(n+1) runs twice → deps.connect
    // spawns two overlapping generations, exactly what the overlap guard
    // forbids).
    clearRetry()
    const delay = Math.min(maxDelayMs, initialDelayMs * 2 ** (next - 1))
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void attempt(next, predecessor)
    }, delay)
    unref(retryTimer)
  }

  const generationDown = (gen: ConnectedMcpClient): void => {
    if (status.isClosed()) return
    if (gen !== generation.current()) return
    generation.withdraw()
    // M6-D3: the dirtiness dies with its generation. The reconnect path drains
    // a fresh catalogue anyway (attempt → resyncTools), so carrying the flag
    // over would only make the next boundary rebuild a catalogue that was
    // already rebuilt.
    catalogue.clearDirty()
    clearStability()
    failCycle(undefined, lifetime.retire(gen))
  }

  const armStability = (gen: ConnectedMcpClient): void => {
    clearStability()
    stabilityTimer = setTimeout(() => {
      stabilityTimer = undefined
      // Stability window: a generation alive ≥ maxDelayMs resets the attempt
      // budget, so a long-lived server never accumulates stale failures.
      if (!status.isClosed() && generation.current() === gen) status.setAttempts(0)
    }, maxDelayMs)
    unref(stabilityTimer)
  }

  const attempt = async (n: number, predecessor?: Promise<void>): Promise<void> => {
    if (status.isClosed()) return
    status.setAttempts(n)
    if (predecessor) {
      try { await waitForMcpClose(predecessor, serverName) }
      catch (error) {
        if (!status.isClosed()) goLost(`Original generation still owned (overlap guard): ${errText(error)}`)
        return
      }
    }
    if (status.isClosed()) return
    const connection = generation.beginConnect()
    let gen: ConnectedMcpClient
    try {
      gen = await deps.connect(config, connection.options)
    } catch (err) {
      const owner = connection.finishFailure(err)
      if (!status.isClosed()) failCycle(err, owner ? lifetime.retire(owner) : undefined)
      return
    }
    connection.finish(gen)
    if (status.isClosed()) return
    try {
      connection.adopt(gen)
      if (!connection.isCurrent()) return
      await catalogue.resyncTools()
    } catch (err) {
      // Close or transport death already owns cleanup and any retry when the
      // in-flight catalogue returned after this connection lost currentness.
      if (!connection.isCurrent()) return
      generation.withdraw()
      try { await waitForMcpClose(lifetime.retire(gen), serverName) }
      catch (cleanup) {
        if (!status.isClosed()) goLost(`${errText(err)} (overlap guard: ${errText(cleanup)})`)
        return
      }
      failCycle(err)
      return
    }
    if (!connection.isCurrent()) return
    status.setState("ready")
    status.emitStatus("ready")
    if (connection.isCurrent()) armStability(gen)
  }

  return { clearRetry, clearStability, generationDown, armStability }
}
