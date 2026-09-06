import { createSession, type Session } from "@i-harness/core-session"
import type { SessionCoordinator } from "@i-harness/session-persistence"

/** Build the SessionService.sessionFor adapter for an already-created and
 * already-owned durable session. Restored events are copied without running
 * append hooks; only new live events enter the coordinator write-behind. */
export function createDurableSessionLoader(
  coordinator: SessionCoordinator,
): (sessionId: string) => Promise<Session> {
  return async (sessionId: string): Promise<Session> => {
    const restored = (await coordinator.loadOwned(sessionId)).session
    const live = createSession((event) => {
      coordinator.enqueue(sessionId, [event])
      if (event.type === "turn/end") void coordinator.flush(sessionId).catch(() => {})
    })
    live.events.push(...restored.events)
    live.formatVersion = restored.formatVersion
    live.header = restored.header
    return live
  }
}
