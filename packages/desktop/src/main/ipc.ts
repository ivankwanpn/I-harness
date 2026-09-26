import type { BrowserWindow } from "electron"
import { DESKTOP_EVENT_CHANNEL, DESKTOP_REQUEST_CHANNEL, type DesktopRequest } from "../shared/bridge.ts"
import type { WorkspaceRuntime, WorkspaceRuntimeManager } from "./sdk-runtime.ts"
import type { WorkspaceCatalog } from "./workspaces.ts"
import { contextRequestParams } from "./context-requests.ts"
import type { attachNativeWindow } from "./native-window.ts"

export interface DesktopIpcDependencies {
  catalog: WorkspaceCatalog
  runtimes: WorkspaceRuntimeManager
  /** Native folder picker; injected so the dispatcher stays testable. */
  pickFolder?: () => Promise<string | undefined>
  native?: ReturnType<typeof attachNativeWindow>
}

/**
 * The slice of `ipcMain` this module needs. Electron is imported by type only
 * so the dispatcher stays testable under plain Node.
 */
export interface IpcMainLike {
  handle(channel: string, listener: (event: { sender: unknown }, request: unknown) => Promise<unknown> | unknown): void
  removeHandler(channel: string): void
}

export async function dispatchDesktopRequest(
  request: unknown,
  dependencies: DesktopIpcDependencies,
): Promise<unknown> {
  const value = requireRecord(request)
  if (typeof value.kind !== "string" || value.kind === "") throw new Error("unknown Desktop request")
  const contextParams = contextRequestParams(value)
  if (contextParams !== undefined) {
    const runtime = await runtimeForKnownWorkspace(requireNonEmpty(value.workspaceId, "workspaceId"), dependencies)
    return runtime.client.request(value.kind, contextParams, value.kind === "desktop/session/compact" ? 600000 : 30000)
  }

  switch (value.kind as DesktopRequest["kind"]) {
    case "window/control":
      if (value.action !== "minimize" && value.action !== "toggle-maximize" && value.action !== "close") throw new Error("invalid window action")
      if (!dependencies.native) throw new Error("native window unavailable")
      return dependencies.native.control(value.action)
    case "window/reset-bounds":
      if (!dependencies.native) throw new Error("native window unavailable")
      return dependencies.native.resetBounds()
    case "desktop/local/state":
      if (!dependencies.native) throw new Error("native preferences unavailable")
      return dependencies.native.state()
    case "desktop/local/configure":
      if (value.notifications !== undefined && typeof value.notifications !== "boolean") throw new Error("invalid notifications preference")
      if (value.locale !== undefined && value.locale !== "zh-TW" && value.locale !== "en") throw new Error("invalid locale")
      if (!dependencies.native) throw new Error("native preferences unavailable")
      return dependencies.native.configure({ ...(typeof value.notifications === "boolean" ? { notifications: value.notifications } : {}), ...(value.locale === "en" || value.locale === "zh-TW" ? { locale: value.locale } : {}) })
    case "workspace/list":
      return await dependencies.catalog.list()
    case "workspace/open":
      return await dependencies.catalog.open(requireNonEmptyPath(value.path))
    case "workspace/pick": {
      const picked = await dependencies.pickFolder?.()
      return picked === undefined ? undefined : await dependencies.catalog.open(picked)
    }
    case "workspace/sandbox/state":
      return (await runtimeForKnownWorkspace(requireNonEmpty(value.workspaceId, "workspaceId"), dependencies)).sandbox
    case "desktop/capabilities":
      return (await runtimeForKnownWorkspace(requireNonEmpty(value.workspaceId, "workspaceId"), dependencies)).info.capabilities
    case "session/list":
      return await (await runtimeForKnownWorkspace(requireNonEmpty(value.workspaceId, "workspaceId"), dependencies)).client.listSessions()
    case "session/dashboard":
      return await (await runtimeForKnownWorkspace(requireNonEmpty(value.workspaceId, "workspaceId"), dependencies)).client.dashboard()
    case "session/create":
      return await (await runtimeForKnownWorkspace(requireNonEmpty(value.workspaceId, "workspaceId"), dependencies)).client.createSession()
    case "session/history": {
      // Validate every field BEFORE any runtime side effect.
      const workspaceId = requireNonEmpty(value.workspaceId, "workspaceId")
      const sessionId = requireNonEmpty(value.sessionId, "sessionId")
      const afterSeq = requireNonNegativeInteger(value.afterSeq, "afterSeq")
      const limit = requireHistoryLimit(value.limit)
      return await (await runtimeForKnownWorkspace(workspaceId, dependencies)).client.history(sessionId, { afterSeq, limit })
    }
    case "session/prompt": {
      const workspaceId = requireNonEmpty(value.workspaceId, "workspaceId")
      const sessionId = requireNonEmpty(value.sessionId, "sessionId")
      const prompt = requireNonEmpty(value.prompt, "prompt")
      const runtime = await runtimeForKnownWorkspace(workspaceId, dependencies)
      if (runtime.sandbox?.wired !== true) throw new Error("sandbox-not-enabled")
      return await runtime.client.request("session/prompt", {
        sessionId,
        prompt,
      }, 24 * 60 * 60 * 1000)
    }
    case "session/cancel":
      return await (await runtimeForKnownWorkspace(requireNonEmpty(value.workspaceId, "workspaceId"), dependencies)).client.cancel(requireNonEmpty(value.sessionId, "sessionId"))
    case "session/queue":
      return await (await runtimeForKnownWorkspace(requireNonEmpty(value.workspaceId, "workspaceId"), dependencies)).client.queue(requireNonEmpty(value.sessionId, "sessionId"))
    case "session/queue/cancel":
      return await (await runtimeForKnownWorkspace(requireNonEmpty(value.workspaceId, "workspaceId"), dependencies)).client.cancelQueueItem(requireNonEmpty(value.sessionId, "sessionId"), requireNonEmpty(value.id, "id"))
    case "session/tasks":
      return await (await runtimeForKnownWorkspace(requireNonEmpty(value.workspaceId, "workspaceId"), dependencies)).client.tasks(requireNonEmpty(value.sessionId, "sessionId"))
    case "session/tasks/cancel":
      return await (await runtimeForKnownWorkspace(requireNonEmpty(value.workspaceId, "workspaceId"), dependencies)).client.cancelTask(requireNonEmpty(value.sessionId, "sessionId"), requireNonEmpty(value.id, "id"))
    case "session/model/state":
      return await (await runtimeForKnownWorkspace(requireNonEmpty(value.workspaceId, "workspaceId"), dependencies)).client.modelState(requireNonEmpty(value.sessionId, "sessionId"))
    case "desktop/interaction/pending": {
      const workspaceId = requireNonEmpty(value.workspaceId, "workspaceId")
      const sessionId = value.sessionId === undefined ? undefined : requireNonEmpty(value.sessionId, "sessionId")
      return await (await runtimeForKnownWorkspace(workspaceId, dependencies)).client.request(
        "desktop/interaction/pending",
        sessionId === undefined ? {} : { sessionId },
      )
    }
    case "desktop/interaction/reply": {
      const workspaceId = requireNonEmpty(value.workspaceId, "workspaceId")
      const requestId = requireNonEmpty(value.requestId, "requestId")
      const sessionId = requireNonEmpty(value.sessionId, "sessionId")
      const decision = value.decision
      if (decision === null || typeof decision !== "object" || Array.isArray(decision)) {
        throw new Error("decision must be an approval or a question answer")
      }
      const record = decision as Record<string, unknown>
      const approval = record.kind === "approval" && typeof record.approved === "boolean"
      const answer = record.kind === "question" && typeof record.answer === "string"
      if (!approval && !answer) throw new Error("decision must be an approval or a question answer")
      return await (await runtimeForKnownWorkspace(workspaceId, dependencies)).client.request("desktop/interaction/reply", {
        requestId,
        sessionId,
        decision: approval
          ? { kind: "approval", approved: record.approved as boolean }
          : { kind: "question", answer: record.answer as string },
      })
    }
    case "desktop/review/changes":
      return await (await runtimeForKnownWorkspace(requireNonEmpty(value.workspaceId, "workspaceId"), dependencies)).client.request("desktop/review/changes", {})
    case "desktop/review/diff":
    case "desktop/review/file": {
      const workspaceId = requireNonEmpty(value.workspaceId, "workspaceId")
      const path = requireNonEmpty(value.path, "path")
      const maxBytes = value.maxBytes === undefined
        ? undefined
        : requirePositiveInteger(value.maxBytes, "maxBytes")
      return await (await runtimeForKnownWorkspace(workspaceId, dependencies)).client.request(value.kind, {
        path,
        ...(maxBytes === undefined ? {} : { maxBytes }),
      })
    }
    default:
      throw new Error("unknown Desktop request")
  }
}

export function registerDesktopIpc(
  window: BrowserWindow,
  dependencies: DesktopIpcDependencies,
  ipc: IpcMainLike,
): () => void {
  ipc.handle(DESKTOP_REQUEST_CHANNEL, async (event, request) => {
    if (event.sender !== window.webContents) throw new Error("untrusted IPC sender")
    return await dispatchDesktopRequest(request, dependencies)
  })
  const offEvent = dependencies.runtimes.onEvent((desktopEvent) => {
    if (window.isDestroyed()) return
    try { dependencies.native?.onEvent(desktopEvent) } catch { /* Notifications cannot interrupt SDK event delivery. */ }
    window.webContents.send(DESKTOP_EVENT_CHANNEL, desktopEvent)
  })
  let removed = false
  return () => {
    if (removed) return
    removed = true
    ipc.removeHandler(DESKTOP_REQUEST_CHANNEL)
    offEvent()
  }
}

async function runtimeForKnownWorkspace(
  workspaceId: string,
  dependencies: DesktopIpcDependencies,
): Promise<WorkspaceRuntime> {
  const workspace = dependencies.catalog.get(workspaceId)
  if (workspace === undefined) throw new Error(`unknown workspace id: ${workspaceId}`)
  return await dependencies.runtimes.get(workspace)
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Desktop request must be an object")
  }
  return value as Record<string, unknown>
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${field} must be a non-empty string`)
  return value
}

function requireNonEmptyPath(value: unknown): string {
  const path = requireNonEmpty(value, "path")
  if (path.includes("\0")) throw new Error("path must not contain NUL")
  return path
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`)
  }
  return value
}

function requireHistoryLimit(value: unknown): number {
  const limit = requireNonNegativeInteger(value, "limit")
  if (limit < 1 || limit > 1000) throw new Error("limit must be an integer between 1 and 1000")
  return limit
}

function requirePositiveInteger(value: unknown, field: string): number {
  const number = requireNonNegativeInteger(value, field)
  if (number < 1) throw new Error(`${field} must be a positive integer`)
  return number
}
