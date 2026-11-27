import type { SessionCoordinator } from "@i-harness/session-persistence"
import { createHash } from "node:crypto"
export function createDraftSession(coordinator: Pick<SessionCoordinator, "list" | "profile" | "create" | "flush" | "deletionReceipt">) {
  const pending = new Map<string, Promise<{ sessionId: string }>>()
  return async (clientToken: string) => {
    if (typeof clientToken !== "string" || clientToken.length < 8 || clientToken.length > 128) throw new Error("Invalid draft creation token")
    const sessionId = `desktop-draft-${createHash("sha256").update(clientToken).digest("hex")}`
    const existing = pending.get(sessionId)
    if (existing) return existing
    const job = Promise.resolve().then(async () => {
      if ((await coordinator.list(undefined, sessionId)).includes(sessionId)) {
        const { meta } = await coordinator.profile(sessionId)
        if (meta.archived) throw new Error("Draft session is archived")
      } else {
        // Some stores allow an explicit new incarnation. A draft retry still
        // names the original conversation, which a deletion receipt retires.
        if (await coordinator.deletionReceipt?.(sessionId)) throw new Error("Draft session was deleted")
        await coordinator.create({ sessionId }, { recreateDeleted: false })
      }
      await coordinator.flush(sessionId)
      return { sessionId }
    })
    pending.set(sessionId, job)
    try { return await job } finally { pending.delete(sessionId) }
  }
}
