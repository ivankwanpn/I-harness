import type { SessionCoordinator } from "@i-harness/session-persistence"
import { createHash } from "node:crypto"
export function createDraftSession(coordinator: SessionCoordinator) {
  const pending = new Map<string, Promise<{ sessionId: string }>>()
  return async (clientToken: string) => {
    if (typeof clientToken !== "string" || clientToken.length < 8 || clientToken.length > 128) throw new Error("Invalid draft creation token")
    const sessionId = `desktop-draft-${createHash("sha256").update(clientToken).digest("hex")}`
    const existing = pending.get(sessionId)
    if (existing) return existing
    const job = (async () => {
      if ((await coordinator.list()).includes(sessionId)) await coordinator.profile(sessionId)
      else await coordinator.create({ sessionId })
      await coordinator.flush(sessionId)
      return { sessionId }
    })()
    pending.set(sessionId, job)
    try { return await job } finally { pending.delete(sessionId) }
  }
}
