import type { ConnectedMcpClient } from "../client.ts"
import type { McpServerConfig } from "../types.ts"
import type { SupervisorDeps } from "./types.ts"
import type { SupervisorStatus } from "./status.ts"
import { errText } from "./status.ts"
import type { SupervisorCatalogue } from "./catalogue.ts"
import type { SupervisorGeneration } from "./generation.ts"
import { closeWithin, OVERLAP_GUARD_MS, unref } from "./disposal.ts"

/** Owns retry/stability timers and cycle decisions; it never mirrors the generation. */
export function createSupervisorRecovery(
  config: McpServerConfig,
  deps: Pick<SupervisorDeps, "connect">,
  initialDelayMs: number,
  maxDelayMs: number,
  maxRetries: number,
  status: Pick<SupervisorStatus,
    "state" | "setState" | "isClosed" | "attempts" | "setAttempts" | "lastError" | "recordError" | "emitStatus">,
  generation: Pick<SupervisorGeneration, "current" | "withdraw" | "connectOptions" | "adopt">,
  catalogue: Pick<SupervisorCatalogue, "clearDirty" | "unregisterAll" | "resyncTools">,
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

  const failCycle = (err: unknown | undefined): void => {
    if (status.isClosed()) return
    if (err !== undefined) status.recordError(err)
    const next = status.attempts() + 1
    if (next > maxRetries) {
      goLost()
      return
    }
    status.setState("reconnecting")
    status.emitStatus("reconnecting", next, status.lastError())
    // Idempotent scheduling: drop any pending retry timer BEFORE arming the
    // next one — two failCycle runs for one failed cycle must never leave two
    // armed timers (both would fire → attempt(n+1) runs twice → deps.connect
    // spawns two overlapping generations, exactly what the overlap guard
    // forbids).
    clearRetry()
    const delay = Math.min(maxDelayMs, initialDelayMs * 2 ** (next - 1))
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void attempt(next)
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
    failCycle(undefined)
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

  const attempt = async (n: number): Promise<void> => {
    if (status.isClosed()) return
    status.setAttempts(n)
    let gen: ConnectedMcpClient
    try {
      gen = await deps.connect(config, generation.connectOptions)
    } catch (err) {
      failCycle(err)
      return
    }
    if (status.isClosed()) {
      await closeWithin(gen, OVERLAP_GUARD_MS)
      return
    }
    generation.adopt(gen)
    try {
      await catalogue.resyncTools()
    } catch (err) {
      if (status.isClosed()) {
        await closeWithin(gen, OVERLAP_GUARD_MS)
        return
      }
      // Ownership guard (mid-resync death race): if the transport died while
      // resync was in flight, the synchronous generationDown path has already
      // claimed this generation (gen !== generation.current()), run failCycle and scheduled
      // the retry. Running failCycle again here would double-schedule the
      // retry (leaked timer → attempt(n+1) fires twice → two overlapping
      // generations) or emit "lost" twice. generationDown owns this failure —
      // only make sure the dead generation is closed and let the
      // already-scheduled retry proceed.
      if (gen !== generation.current()) {
        await closeWithin(gen, OVERLAP_GUARD_MS)
        return
      }
      // We still own the generation (its death has not been observed): fail
      // this cycle. The failed generation must be closed before the next one
      // spawns — if it cannot close within the overlap guard, stop
      // reconnecting rather than risk two overlapping stdio child processes.
      generation.withdraw()
      const didClose = await closeWithin(gen, OVERLAP_GUARD_MS)
      if (status.isClosed()) return
      if (!didClose) {
        goLost(`${errText(err)} (generation failed to close within ${OVERLAP_GUARD_MS}ms — overlap guard)`)
        return
      }
      failCycle(err)
      return
    }
    // Ready guard: the generation may die while resync is in flight even
    // though resync itself completes — generationDown has then already
    // claimed the death (gen !== generation.current()), run failCycle and scheduled the
    // retry. Declaring "ready" here would emit ready while the server is
    // actually down (current undefined, retry pending); treat the attempt as
    // failed instead — same ownership path as the catch above (no second
    // failCycle).
    if (gen !== generation.current()) {
      await closeWithin(gen, OVERLAP_GUARD_MS)
      return
    }
    status.setState("ready")
    status.emitStatus("ready")
    armStability(gen)
  }

  return { clearRetry, clearStability, generationDown, armStability }
}
