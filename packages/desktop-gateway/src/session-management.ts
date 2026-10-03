import { forkSession, type SessionCoordinator, type SessionMeta } from "@i-harness/session-persistence"
import type { SessionService } from "@i-harness/session-executor"
import { createHash } from "node:crypto"
import { Inbox } from "@i-harness/core-session"
import { sessionArtifactManifest } from "./session-artifacts.ts"
import { createSessionManagementFence, type SessionManagementFence } from "./session-management-fence.ts"

export type SessionManagementAction = "rename" | "archive" | "restore" | "fork" | "pin" | "unpin" | "read" | "unread" | "delete"
export interface SessionBatchCommand { action: "archive" | "restore" | "delete" | "move"; sessionIds: string[]; projectId?: string; expectedOwners?: Record<string, string | null> }
export interface SessionBatchResult { results: ({ sessionId: string; ok: true; projectId?: string; executionWorkspace?: string } | { sessionId: string; ok: false; error: string })[] }
export interface SessionNavigation { pinned: boolean; unread: boolean; projectId?: string }
export interface SessionManagementOptions {
  projectFor?(sessionId: string): Promise<string | undefined>
  onFork?(sourceSessionId: string, childSessionId: string): Promise<void>
  workspace?: string
  sessionDir?: string
  fence?: SessionManagementFence
  pendingInteractions?(sessionId: string): Promise<readonly unknown[]>
  /** Host-owned work that can be between turns, such as the automatic Goal loop. */
  activeWork?(sessionId: string): Promise<boolean>
  /** Stop idle runtime/title/approval producers and await their persistence. */
  drainSession?(sessionId: string): Promise<void>
  moveProject?(sessionId: string, expectedOwner: string | undefined, projectId: string | undefined): Promise<{ sessionId: string; projectId?: string; executionWorkspace: string }>
}
const actions = new Set<SessionManagementAction>(["rename", "archive", "restore", "fork", "pin", "unpin", "read", "unread", "delete"])
const navigationActions = new Set<SessionManagementAction>(["pin", "unpin", "read", "unread"])

export function createSessionManagement(coordinator: SessionCoordinator, service: SessionService, visible: (id: string, meta: SessionMeta) => Promise<boolean> = async (_id, meta) => meta.origin !== "subagent" && meta.origin !== "approval-review" && !(meta.origin === "team" && meta.parentSession), options: SessionManagementOptions = {}) {
  const writes = new Map<string, Promise<unknown>>()
  const fence = options.fence ?? createSessionManagementFence()
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
  async function assertIdle(id: string): Promise<void> {
    if (await options.activeWork?.(id)) throw new Error("Session has active workflow work")
    const queue = service.queueState(id)
    if (queue.running || queue.queued || service.tasks(id).some(task => ["queued", "running", "waiting"].includes(task.status))) throw new Error("Session is busy")
    const assembly = service.liveAssembly?.(id)
    if (assembly) {
      if (!assembly.liveResources) throw new Error("Live resource inspection is unavailable")
      const resources = assembly.liveResources()
      if (resources.codeCells.some(cell => cell.status === "running") || resources.terminals.some(terminal => terminal.status === "running")) throw new Error("Session has active Code Mode cells or processes")
    }
    if (!coordinator.snapshot) throw new Error("Durable session inspection is unavailable")
    await coordinator.flush(id)
    const snapshot = (await coordinator.snapshot(id)).session
    if (new Inbox(snapshot).pending().length) throw new Error("Session has pending durable inputs")
    let inTurn = false
    for (const event of snapshot.events) { if (event.type === "turn/start") inTurn = true; if (event.type === "turn/end") inTurn = false }
    if (inTurn) throw new Error("Session has an unfinished durable turn")
    const state = await coordinator.getDocument(id) as { formatVersion?: unknown; agentTable?: { status?: string; mailbox?: unknown[] }[]; jobs?: { status?: string }[] } | undefined
    if (state !== undefined) {
      if (!state || state.formatVersion !== 1 || !Array.isArray(state.agentTable) || !Array.isArray(state.jobs)) throw new Error("Session durable agent state is invalid")
      if (state.agentTable.some(row => !row || !["running", "waiting", "completed", "killed", "error"].includes(row.status ?? "") || !Array.isArray(row.mailbox)) || state.jobs.some(row => !row || !["running", "completed", "killed", "error"].includes(row.status ?? ""))) throw new Error("Session durable agent rows are invalid")
      if (state.agentTable.some(row => ["running", "waiting"].includes(row.status ?? "") || (row.mailbox?.length ?? 0) > 0) || state.jobs.some(row => row.status === "running")) throw new Error("Session has active or pending durable agents/inbox")
    }
    const tasks = await coordinator.getDocument(`task-${id}`) as { formatVersion?: unknown; tasks?: { status?: string }[]; notifications?: { status?: string }[] } | undefined
    if (tasks !== undefined) {
      if (!tasks || tasks.formatVersion !== 1 || !Array.isArray(tasks.tasks) || !Array.isArray(tasks.notifications)) throw new Error("Session durable task state is invalid")
      if (tasks.tasks.some(row => !row || !["accepted", "running", "completed", "error", "cancelled", "recovery-required"].includes(row.status ?? "")) || tasks.notifications.some(row => !row || !["pending", "delivered", "woken", "error", "suppressed"].includes(row.status ?? ""))) throw new Error("Session durable task rows are invalid")
      if (tasks.tasks.some(row => ["accepted", "running", "recovery-required"].includes(row.status ?? "")) || tasks.notifications.some(row => ["pending", "delivered", "error"].includes(row.status ?? ""))) throw new Error("Session has pending durable tasks/outbox")
    }
    if ((await options.pendingInteractions?.(id))?.length) throw new Error("Session has pending interactions")
    if (options.sessionDir && options.workspace) await sessionArtifactManifest(options.sessionDir, options.workspace, id)
    // A previously admitted short writer can schedule a turn while the durable
    // inspection awaits. Refuse that new live work before entering the drain.
    const latestQueue = service.queueState(id)
    if (latestQueue.running || latestQueue.queued) throw new Error("Session is busy")
  }
  const manager = {
    fence,
    assertIdle,
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
        if (action === "delete") {
          const receipt = await coordinator.deletionReceipt?.(sessionId)
          if (receipt) {
            const meta = { formatVersion: 1, sessionId, createdAt: "", ...receipt.visibility }
            if (meta.origin === "subagent" || meta.origin === "approval-review" || (meta.origin === "team" && meta.parentSession) || !await visible(sessionId, meta)) throw new Error("Session is unavailable")
            if (!coordinator.deleteOwnedSession || !options.sessionDir || !options.workspace || !options.pendingInteractions || !options.drainSession) throw new Error("Permanent deletion is unavailable for this backend/runtime")
            // The store's durable closure already forbids new writers. Resume
            // only its exact manifest, under the coordinator's write lease.
            fence.retire(sessionId)
            const queue = service.queueState(sessionId)
            if (queue.running || queue.queued || service.tasks(sessionId).some(task => ["queued", "running", "waiting"].includes(task.status)) || (await options.pendingInteractions(sessionId)).length) throw new Error("Session is busy")
            const assembly = service.liveAssembly?.(sessionId)
            if (assembly) {
              if (!assembly.liveResources) throw new Error("Live resource inspection is unavailable")
              const resources = assembly.liveResources()
              if (resources.codeCells.some(cell => cell.status === "running") || resources.terminals.some(terminal => terminal.status === "running")) throw new Error("Session has active Code Mode cells or processes")
            }
            for (const id of await coordinator.list()) if ((await coordinator.profile(id)).meta.parentSession === sessionId) throw new Error("Session has descendants; coordinated deletion is unavailable")
            await options.drainSession(sessionId)
            await coordinator.deleteOwnedSession(sessionId, receipt.manifest)
            return { sessionId }
          }
        }
        const profile = await coordinator.profile(sessionId)
        if (profile.meta.origin === "subagent" || profile.meta.origin === "approval-review" || (profile.meta.origin === "team" && profile.meta.parentSession) || !await visible(sessionId, profile.meta)) throw new Error("Session is unavailable")
        if (navigationActions.has(action)) {
          return fence.run(sessionId, async () => {
          const navigation = await navigationFor(sessionId)
          const updated = { ...navigation, ...(action === "pin" || action === "unpin" ? { pinned: action === "pin" } : { unread: action === "unread" }) }
          await coordinator.putDocument(documentKey(sessionId), { version: 1, ...updated })
          return { sessionId }
          })
        }
        return fence.exclusive(sessionId, async () => {
        await assertIdle(sessionId)
        if (action === "delete") {
          if (!coordinator.deleteOwnedSession || !options.sessionDir || !options.workspace || !options.pendingInteractions || !options.drainSession) throw new Error("Permanent deletion is unavailable for this backend/runtime")
          for (const id of await coordinator.list()) if ((await coordinator.profile(id)).meta.parentSession === sessionId) throw new Error("Session has descendants; coordinated deletion is unavailable")
          await options.drainSession(sessionId)
          await assertIdle(sessionId)
          const manifest = await sessionArtifactManifest(options.sessionDir, options.workspace, sessionId)
          // Keep admission closed even if cleanup partially fails after durable closure.
          fence.retire(sessionId)
          await coordinator.deleteOwnedSession(sessionId, manifest)
          return { sessionId }
        }
        if (action === "fork") {
          await coordinator.flush(sessionId)
          const child = await forkSession(coordinator, sessionId)
          await options.onFork?.(sessionId, child.sessionId)
          return child
        }
        await coordinator.updateMeta(sessionId, action === "rename" ? { title: title!.trim() } : { archived: action === "archive" })
        return { sessionId }
        }, () => assertIdle(sessionId))
      })
    },
    async batch(command: SessionBatchCommand): Promise<SessionBatchResult> {
      if (!command || !["archive", "restore", "delete", "move"].includes(command.action) || !Array.isArray(command.sessionIds) || command.sessionIds.length < 1 || command.sessionIds.length > 100 || command.sessionIds.some(id => typeof id !== "string" || !id || id.length > 256) || new Set(command.sessionIds).size !== command.sessionIds.length) throw new Error("Invalid explicit session batch")
      const results: SessionBatchResult["results"] = []
      for (const sessionId of command.sessionIds) {
        try {
          if (command.action === "move") {
            if (!options.moveProject || !command.expectedOwners || !Object.hasOwn(command.expectedOwners, sessionId)) throw new Error("Project move requires the expected current owner")
            const profile = await coordinator.profile(sessionId)
            if (profile.meta.origin === "subagent" || profile.meta.origin === "approval-review" || (profile.meta.origin === "team" && profile.meta.parentSession) || !await visible(sessionId, profile.meta)) throw new Error("Session is unavailable")
            const moved = await serial(sessionId, () => options.moveProject!(sessionId, command.expectedOwners![sessionId] ?? undefined, command.projectId))
            results.push({ ...moved, ok: true })
          } else { await manager.mutate(sessionId, command.action); results.push({ sessionId, ok: true }) }
        } catch (error) { results.push({ sessionId, ok: false, error: error instanceof Error ? error.message : String(error) }) }
      }
      return { results }
    },
  }
  return manager
}
