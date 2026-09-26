import { forkSession, type SessionCoordinator } from "@i-harness/session-persistence"
import type { SessionService } from "@i-harness/session-executor"

export function createSessionManagement(coordinator: SessionCoordinator, service: SessionService) {
  return {
    async archived() {
      const rows = await Promise.all((await coordinator.list()).map(async (id) => {
        const profile = await coordinator.profile(id)
        return profile.meta.archived ? { id, title: profile.meta.title, updatedAt: profile.updatedAt } : undefined
      }))
      return rows.filter((row) => row !== undefined)
    },
    async mutate(sessionId: string, action: "rename" | "archive" | "restore" | "fork", title?: string) {
      await coordinator.profile(sessionId)
      const queue = service.queueState(sessionId)
      if (queue.running || queue.queued || service.tasks(sessionId).some((task) => ["queued", "running", "waiting"].includes(task.status))) throw new Error("Session is busy")
      if (action === "fork") {
        await coordinator.flush(sessionId)
        return forkSession(coordinator, sessionId)
      }
      await coordinator.updateMeta(sessionId, action === "rename" ? { title: title! } : { archived: action === "archive" })
      return { sessionId }
    },
  }
}
