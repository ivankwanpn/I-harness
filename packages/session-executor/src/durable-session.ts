import { createSession, type Session } from "@i-harness/core-session"
import type { SessionCoordinator } from "@i-harness/session-persistence"

// Different adapters in one host share an in-flight owned load. Retaining only
// the promise avoids stale completed caches across an explicit close/reopen.
const pendingLoads = new WeakMap<SessionCoordinator, Map<string, Promise<Session>>>()

/** Build the SessionService.sessionFor adapter for an already-created and
 * already-owned durable session. Restored events are copied without running
 * append hooks; only new live events enter the coordinator write-behind. */
export function createDurableSessionLoader(
  coordinator: SessionCoordinator,
): (sessionId: string) => Promise<Session> {
  return (sessionId: string): Promise<Session> => {
    let loads = pendingLoads.get(coordinator)
    if (!loads) { loads = new Map(); pendingLoads.set(coordinator, loads) }
    const existing = loads.get(sessionId)
    if (existing) return existing
    const entries = loads
    const pending = (async () => {
      const restored = (await coordinator.loadOwned(sessionId)).session
      const live = createSession((event) => {
        coordinator.enqueue(sessionId, [event])
        if (event.type === "turn/end") void coordinator.flush(sessionId).catch(() => {})
      })
      live.events.push(...restored.events)
      live.formatVersion = restored.formatVersion
      live.header = restored.header
      return live
    })().finally(() => { if (entries.get(sessionId) === pending) entries.delete(sessionId) })
    entries.set(sessionId, pending)
    return pending
  }
}
