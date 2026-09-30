import { forkSession, type SessionCoordinator, type SessionMeta } from "@i-harness/session-persistence"
import type { SessionService } from "@i-harness/session-executor"
import { createHash } from "node:crypto"

export type SessionManagementAction = "rename" | "archive" | "restore" | "fork" | "pin" | "unpin" | "read" | "unread"
export interface SessionNavigation { pinned: boolean; unread: boolean; projectId?: string }
export interface SessionManagementOptions {
  projectFor?(sessionId: string): Promise<string | undefined>
  onFork?(sourceSessionId: string, childSessionId: string): Promise<void>
}
const actions = new Set<SessionManagementAction>(["rename", "archive", "restore", "fork", "pin", "unpin", "read", "unread"])
const navigationActions = new Set<SessionManagementAction>(["pin", "unpin", "read", "unread"])

export function createSessionManagement(coordinator: SessionCoordinator, service: SessionService, visible: (id: string, meta: SessionMeta) => Promise<boolean> = async () => true, options: SessionManagementOptions = {}) {
  const writes = new Map<string, Promise<unknown>>()
  const documentKey = (id: string) => `desktop-navigation-${createHash("sha256").update(id).digest("hex")}`
  async function navigationFor(id: string): Promise<SessionNavigation> {
    const document = await coordinator.getDocument(documentKey(id))
    if (document === undefined) return { pinned: false, unread: false }
    if (document === null || typeof document !== "object" || Array.isArray(document)) throw new Error("Session navigation metadata is invalid")
    const row = document as { version?: unknown; pinned?: unknown; unread?: unknown }
    if (row.version !== 1 || typeof row.pinned !== "boolean" || typeof row.unread !== "boolean") throw new Error("Session navigation metadata is invalid")
    return { pinned: row.pinned, unread: row.unread }
  }
  function serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const job = (writes.get(id) ?? Promise.resolve()).catch(() => undefined).then(action)
    writes.set(id, job)
    void job.finally(() => { if (writes.get(id) === job) writes.delete(id) }).catch(() => undefined)
    return job
  }
  return {
    async navigation(): Promise<Record<string, SessionNavigation>> {
      const entries = await Promise.all((await coordinator.list()).map(async (id) => {
        const profile = await coordinator.profile(id)
        if (!await visible(id, profile.meta)) return undefined
        await writes.get(id)
        const projectId = await options.projectFor?.(id)
        return [id, { ...await navigationFor(id), ...(projectId ? { projectId } : {}) }] as const
      }))
      return Object.fromEntries(entries.filter((entry) => entry !== undefined))
    },
    async archived() {
      const rows = await Promise.all((await coordinator.list()).map(async (id) => {
        const profile = await coordinator.profile(id)
        if (!profile.meta.archived || !await visible(id, profile.meta)) return undefined
        const projectId = await options.projectFor?.(id)
        return { id, title: profile.meta.title, updatedAt: profile.updatedAt, ...(projectId ? { projectId } : {}) }
      }))
      return rows.filter((row) => row !== undefined)
    },
    mutate(sessionId: string, action: SessionManagementAction, title?: string) {
      return serial(sessionId, async () => {
        if (!actions.has(action)) throw new Error("Invalid session action")
        if (action === "rename" && (typeof title !== "string" || !title.trim() || title.length > 256)) throw new Error("Invalid session title")
        const profile = await coordinator.profile(sessionId)
        if (!await visible(sessionId, profile.meta)) throw new Error("Session is unavailable")
        if (navigationActions.has(action)) {
          const navigation = await navigationFor(sessionId)
          const updated = { ...navigation, ...(action === "pin" || action === "unpin" ? { pinned: action === "pin" } : { unread: action === "unread" }) }
          await coordinator.putDocument(documentKey(sessionId), { version: 1, ...updated })
          return { sessionId }
        }
        const queue = service.queueState(sessionId)
        if (queue.running || queue.queued || service.tasks(sessionId).some((task) => ["queued", "running", "waiting"].includes(task.status))) throw new Error("Session is busy")
        if (action === "fork") {
          await coordinator.flush(sessionId)
          const child = await forkSession(coordinator, sessionId)
          await options.onFork?.(sessionId, child.sessionId)
          return child
        }
        await coordinator.updateMeta(sessionId, action === "rename" ? { title: title!.trim() } : { archived: action === "archive" })
        return { sessionId }
      })
    },
  }
}
