import type { BrowserWindow } from "electron"
import { DESKTOP_EVENT_CHANNEL, DESKTOP_REQUEST_CHANNEL, type DesktopRequest } from "../shared/bridge.ts"
import type { WorkspaceRuntime, WorkspaceRuntimeManager } from "./sdk-runtime.ts"
import type { WorkspaceCatalog } from "./workspaces.ts"

export interface DesktopIpcDependencies {
  catalog: WorkspaceCatalog
  runtimes: WorkspaceRuntimeManager
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

  switch (value.kind as DesktopRequest["kind"]) {
    case "workspace/list":
      return await dependencies.catalog.list()
    case "workspace/open":
      return await dependencies.catalog.open(requireNonEmptyPath(value.path))
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
