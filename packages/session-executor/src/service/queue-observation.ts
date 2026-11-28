import { readInbox } from "@i-harness/core-session"
import type { PendingInputSummary, SessionCoordinator } from "@i-harness/session-persistence"
import type { SessionService } from "../service.ts"

/** Passive queue projection. A newly published live session supersedes an
 * earlier disk observation, including cancellations made while it was read. */
export async function observeSessionQueue(service: Pick<SessionService, "liveSession" | "queue">, coordinator: Pick<SessionCoordinator, "readPendingInputs" | "snapshot">, id: string) {
  let pending: readonly PendingInputSummary[]
  const current = service.liveSession(id)
  if (current) pending = readInbox(current).pending()
  else if (coordinator.readPendingInputs) {
    const saved = await coordinator.readPendingInputs(id)
    const live = service.liveSession(id)
    pending = live ? readInbox(live).pending() : saved
  } else {
    if (!coordinator.snapshot) throw new Error("Read-only input snapshots unavailable")
    const saved = (await coordinator.snapshot(id)).session
    pending = readInbox(service.liveSession(id) ?? saved).pending()
  }
  const rows = new Map(service.queue(id).map(row => [row.id, row]))
  for (const input of pending) if (!rows.has(input.inputId)) {
    rows.set(input.inputId, { id: input.inputId, text: input.text, delivery: input.delivery, intent: input.intent, state: "queued", order: input.admittedSeq })
  }
  return { items: [...rows.values()], pendingIds: pending.map(input => input.inputId) }
}
