import type { ConnectedMcpClient } from "../client.ts"
import type { SupervisorStatus } from "./status.ts"
import type { SupervisorCatalogue } from "./catalogue.ts"

// dsh overlap guard: never allow two live stdio children for one server.
export const OVERLAP_GUARD_MS = 5_000

// Timers must never keep the process alive past unmount.
export const unref = (timer: ReturnType<typeof setTimeout>): void => {
  ;(timer as unknown as { unref?: () => void }).unref?.()
}

/** A caller waits only for a bounded time. The original cleanup keeps its ownership. */
export async function waitForMcpClose(pending: Promise<void>, serverName: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`MCP ${serverName} cleanup did not finish within ${OVERLAP_GUARD_MS}ms`), { code: 'MCP_CLEANUP_PENDING' })), OVERLAP_GUARD_MS)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Track the original physical acquisition from before connect until cleanup. */
export function createSupervisorLifetime(serverName: string) {
  type OriginalClose = Pick<ConnectedMcpClient, "close">
  const released = Promise.withResolvers<void>()
  let acquisition: { completion: Promise<void>; cleanup?: Promise<void> } | undefined
  let owner: { client: OriginalClose; cleanup?: Promise<void> } | undefined
  let stopped = false
  const checkReleased = () => { if (stopped && !acquisition && !owner) released.resolve() }

  function retire(client: OriginalClose): Promise<void> {
    const original = owner
    if (original?.client !== client) return Promise.resolve()
    if (original.cleanup) return original.cleanup
    const cleanup = Promise.resolve().then(() => client.close())
    original.cleanup = cleanup
    void cleanup.then(() => { owner = undefined; checkReleased() }, () => { original.cleanup = undefined })
    return cleanup
  }

  function closeClient(): Promise<void> {
    if (owner) return retire(owner.client)
    checkReleased()
    return Promise.resolve()
  }

  return {
    beginConnect() {
      if (acquisition || stopped || owner) throw new Error(`MCP ${serverName} original generation is still owned`)
      const completed = Promise.withResolvers<void>()
      acquisition = { completion: completed.promise }
      return (client?: OriginalClose): void => {
        if (client) owner = { client }
        acquisition = undefined
        checkReleased()
        completed.resolve()
      }
    },
    retire,
    stop(): Promise<void> {
      stopped = true
      if (!acquisition) return closeClient()
      return acquisition.cleanup ??= acquisition.completion.then(closeClient)
    },
    released: released.promise,
  }
}

export type SupervisorLifetime = ReturnType<typeof createSupervisorLifetime>

/** Cut off access immediately, retaining unproved physical and registry cleanup. */
export function createSupervisorClose(
  serverName: string,
  status: Pick<SupervisorStatus, "isClosed" | "markClosed" | "setState">,
  generation: { withdraw(): void },
  catalogue: Pick<SupervisorCatalogue, "clearDirty" | "unregisterAll">,
  lifetime: Pick<SupervisorLifetime, "stop" | "released">,
  clearRetry: () => void,
  clearStability: () => void,
) {
  const released = Promise.withResolvers<void>()
  let closeFlight: Promise<void> | undefined, catalogueReleased = false

  function close(): Promise<void> {
    if (closeFlight) return closeFlight
    const attempt = Promise.withResolvers<void>()
    closeFlight = attempt.promise
    void (async () => {
      let resources: Promise<void>
      try {
        if (!status.isClosed()) {
          status.markClosed()
          clearRetry()
          clearStability()
          generation.withdraw()
          catalogue.clearDirty()
          status.setState("lost")
        }
        if (!catalogueReleased) {
          catalogue.unregisterAll()
          catalogueReleased = true
          void lifetime.released.then(() => released.resolve())
        }
      } finally {
        resources = lifetime.stop()
        // Cleanup still runs if registry unregistration throws before our await.
        void resources.catch(() => {})
      }
      await waitForMcpClose(resources, serverName)
    })().then(attempt.resolve, error => {
      if (closeFlight === attempt.promise) closeFlight = undefined
      attempt.reject(error)
    })
    return attempt.promise
  }
  return { close, released: released.promise }
}
