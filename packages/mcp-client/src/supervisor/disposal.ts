import type { ConnectedMcpClient } from "../client.ts"
import type { SupervisorStatus } from "./status.ts"
import type { SupervisorCatalogue } from "./catalogue.ts"

// dsh overlap guard: never allow two live stdio children for one server.
export const OVERLAP_GUARD_MS = 5_000

// Timers must never keep the process alive past unmount.
export const unref = (timer: ReturnType<typeof setTimeout>): void => {
  ;(timer as unknown as { unref?: () => void }).unref?.()
}

// A rejected close of an already-dead client still means it is gone.
export const closeWithin = async (gen: ConnectedMcpClient, ms: number): Promise<boolean> => {
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

/** Mark closed before timer, registry or client callbacks can fire. */
export function createSupervisorClose(
  status: Pick<SupervisorStatus, "isClosed" | "markClosed" | "setState">,
  generation: { current(): ConnectedMcpClient | undefined; withdraw(): void },
  catalogue: Pick<SupervisorCatalogue, "clearDirty" | "unregisterAll">,
  clearRetry: () => void,
  clearStability: () => void,
): () => Promise<void> {
  const close = async (): Promise<void> => {
    if (status.isClosed()) return
    status.markClosed() // FIRST: no further emits; death notifications become no-ops
    clearRetry()
    clearStability()
    const gen = generation.current()
    generation.withdraw()
    catalogue.clearDirty() // M6-D3: a closed mount has no catalogue to rebuild
    status.setState("lost")
    catalogue.unregisterAll()
    if (gen !== undefined) await closeWithin(gen, OVERLAP_GUARD_MS)
  }
  return close
}
