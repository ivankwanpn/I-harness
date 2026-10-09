import type { BrowserWindow } from "electron"
import { relative, isAbsolute, sep } from "node:path"
import { DESKTOP_EVENT_CHANNEL, DESKTOP_REQUEST_CHANNEL, type DesktopRequest, type TerminalShellChoice } from "../shared/bridge.ts"
import type { WorkspaceRuntime, WorkspaceRuntimeManager } from "./sdk-runtime.ts"
import { validateSandboxState } from "./sdk-runtime.ts"
import type { WorkspaceCatalog } from "./workspaces.ts"
import type { ProjectCatalog } from "./projects.ts"
import { readPickedAttachments } from "./file-attachments.ts"
import { projectRuntimeContexts, syncLiveProjectContexts } from "./project-runtime.ts"
import { contextRequestParams } from "./context-requests.ts"
import { contextQuery, contextReference, type ContextItem } from "../../../desktop-gateway/src/context-picker.ts"
import { resolveCurrentProjectMembers, runtimeForProjectMember } from "./project-membership.ts"
import { dispatchProjectFilesRequest } from "./project-files.ts"
import { createDesktopProjectContentSearch, notifyDesktopProjectContentScopesChanged } from "./project-content-search.ts"
import type { createGlobalProviderSettings } from "./global-provider-settings.ts"
import type { createNotificationHistory } from "./notification-history.ts"
import type { AttachmentDraftStore } from "./attachment-draft-store.ts"
// This native helper must be bundled into Electron main. An externalized
// workspace-package import would require raw gateway TypeScript at app boot.
import { listDesktopTerminalShellOptions } from "../../../desktop-gateway/src/terminal-shells.ts"
import type { attachNativeWindow } from "./native-window.ts"
import type { createBrowserSurface } from "./browser-surface.ts"

export interface DesktopIpcDependencies {
  catalog: WorkspaceCatalog
  projects?: ProjectCatalog
  revealWorkspace?: (path: string) => Promise<void>
  runtimes: WorkspaceRuntimeManager
  /** Native folder picker; injected so the dispatcher stays testable. */
  pickFolder?: () => Promise<string | undefined>
  pickFiles?: (workspacePath: string) => Promise<string[] | undefined>
  pickSkill?: () => Promise<string | undefined>
  globalProviders?: ReturnType<typeof createGlobalProviderSettings>
  notifications?: ReturnType<typeof createNotificationHistory>
  drafts?: AttachmentDraftStore
  about?: { info(): unknown; copy(): unknown }
  native?: ReturnType<typeof attachNativeWindow>
  browser?: ReturnType<typeof createBrowserSurface>
  /** Discover local executable choices before a workspace is opened. */
  shellOptions?: typeof listDesktopTerminalShellOptions
  projectContentSearch?: ReturnType<typeof createDesktopProjectContentSearch>
}
const searchOwners = new WeakMap<DesktopIpcDependencies, ReturnType<typeof createDesktopProjectContentSearch>>()
function searchOwner(dependencies: DesktopIpcDependencies) {
  if (dependencies.projectContentSearch) return dependencies.projectContentSearch
  let owner = searchOwners.get(dependencies)
  if (!owner) { owner = createDesktopProjectContentSearch(dependencies); searchOwners.set(dependencies, owner) }
  return owner
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
  if (value.kind.startsWith("desktop/global-provider/") || value.kind.startsWith("desktop/global-preferences/")) {
    if (!dependencies.globalProviders) throw new Error("Global provider settings unavailable")
    return dependencies.globalProviders.request(value)
  }
  if (value.kind === "desktop/about/info" || value.kind === "desktop/about/copy") {
    if (!dependencies.about) throw new Error("Application information unavailable")
    return value.kind.endsWith("/copy") ? dependencies.about.copy() : dependencies.about.info()
  }
  if (value.kind.startsWith("desktop/notifications/")) {
    if (!dependencies.notifications) throw new Error("Notification history unavailable")
    if (value.kind === "desktop/notifications/target") {
      const workspaceId = requireNonEmpty(value.workspaceId, "workspaceId")
      const sessionId = requireNonEmpty(value.sessionId, "sessionId")
      const runtime = await runtimeForKnownWorkspace(workspaceId, dependencies)
      const navigation = await runtime.client.request("desktop/session/navigation/state", {}) as Record<string, { projectId?: string }>
      if (!navigation || !Object.hasOwn(navigation, sessionId)) throw new Error("會話已不存在或無法開啟")
      const archived = await runtime.client.request("desktop/session/archived", {}) as { id: string }[]
      if (archived.some(row => row.id === sessionId)) throw new Error("會話已封存，請先在會話管理還原")
      return { workspaceId, sessionId, ...(navigation[sessionId]?.projectId ? { projectId: navigation[sessionId]!.projectId } : {}) }
    }
    if (value.kind === "desktop/notifications/list") return dependencies.notifications.list()
    if (value.kind === "desktop/notifications/read") return dependencies.notifications.markRead(value.id === undefined ? undefined : requireNonEmpty(value.id, "notification ID"))
    if (value.kind === "desktop/notifications/clear" && value.confirmed === true) return dependencies.notifications.clear()
    throw new Error("Invalid notification request")
  }
  if (value.kind.startsWith("desktop/draft/")) {
    if (!dependencies.drafts || !["desktop/draft/load", "desktop/draft/save", "desktop/draft/clear"].includes(value.kind)) throw new Error("Draft persistence unavailable")
    const rawScope = requireRecord(value.scope)
    const scope = { workspaceId: requireNonEmpty(rawScope.workspaceId, "workspaceId"), identity: requireNonEmpty(rawScope.identity, "draft identity") }
    if (!dependencies.catalog.get(scope.workspaceId)) throw new Error("Unknown draft workspace")
    if (scope.identity.startsWith("new-task:")) {
      const projectId = scope.identity.slice("new-task:".length)
      if (projectId !== "unassigned") {
        const project = (await dependencies.projects?.list())?.find(row => row.id === projectId)
        if (!project?.workspaceIds.includes(scope.workspaceId)) throw new Error("Draft project is unavailable")
      }
    } else {
      const runtime = await runtimeForKnownWorkspace(scope.workspaceId, dependencies)
      const navigation = await runtime.client.request("desktop/session/navigation/state", {})
      if (!navigation || typeof navigation !== "object" || !Object.hasOwn(navigation, scope.identity)) throw new Error("Draft conversation unavailable")
    }
    if (value.kind.endsWith("/load")) return dependencies.drafts.load(scope)
    if (value.expectedRevision !== null && typeof value.expectedRevision !== "string") throw new Error("Invalid draft revision")
    return value.kind.endsWith("/save")
      ? dependencies.drafts.save(scope, value.expectedRevision as string | null, value.draft as import("../shared/attachment-drafts.ts").UnsentDraft)
      : dependencies.drafts.clear(scope, value.expectedRevision as string | null)
  }
  if (["desktop/project-files/content-search", "desktop/project-files/content-cancel", "desktop/project-files/search-preview", "desktop/project-files/external-read", "desktop/project-files/external-preview"].includes(value.kind)) return searchOwner(dependencies).request(value)
  if (value.kind.startsWith("desktop/project-files/")) return dispatchProjectFilesRequest(value, dependencies)
  if (value.kind === "desktop/session/batch") {
    if (value.confirmed !== true) throw new Error("Session batch requires confirmation")
    const command = requireRecord(value.command)
    if (!["archive", "restore", "delete", "move"].includes(String(command.action)) || !Array.isArray(command.sessionIds) || command.sessionIds.length < 1 || command.sessionIds.length > 100
      || command.sessionIds.some(id => typeof id !== "string" || !id || id.length > 256) || new Set(command.sessionIds).size !== command.sessionIds.length) throw new Error("Invalid explicit session batch")
    const workspaceId = requireNonEmpty(value.workspaceId, "workspaceId")
    if (command.action === "delete" && !dependencies.drafts) throw new Error("Permanent deletion requires native draft cleanup")
    const runtime = await runtimeForKnownWorkspace(workspaceId, dependencies)
    if (command.action === "move") {
      if (command.projectId !== undefined) requireNonEmpty(command.projectId, "destination project")
      const owners = requireRecord(command.expectedOwners)
      if (command.sessionIds.some(id => !Object.hasOwn(owners, String(id)) || owners[String(id)] !== null && (typeof owners[String(id)] !== "string" || !owners[String(id)]))) throw new Error("Invalid expected project owners")
      if (!dependencies.projects) throw new Error("Project catalog unavailable")
      const scopes = await projectRuntimeContexts(dependencies.projects, dependencies.catalog)
      if (command.projectId !== undefined && !scopes.some(scope => scope.id === command.projectId && scope.roots.length > 0)) throw new Error("Destination project unavailable")
      await runtime.client.request("desktop/project/sync", { projects: scopes })
    }
    if (command.action !== "delete") {
      const result = await runtime.client.request(value.kind, { command }, 120000)
      if (command.action === "move") await notifyDesktopProjectContentScopesChanged()
      return result
    }
    const drafts = dependencies.drafts!
    // Only a native retirement receipt from a prior confirmed gateway success
    // authorizes cleanup retries after the session disappears from navigation.
    const retired = new Set<string>()
    for (const sessionId of command.sessionIds as string[]) if (await drafts.isRetired({ workspaceId, identity: sessionId })) retired.add(sessionId)
    const pending = (command.sessionIds as string[]).filter(id => !retired.has(id))
    const reply = pending.length ? await runtime.client.request(value.kind, { command: { ...command, sessionIds: pending } }, 120000) as import("../../../desktop-gateway/src/session-management.ts").SessionBatchResult : { results: [] }
    if (pending.length) await notifyDesktopProjectContentScopesChanged()
    const rows = new Map(reply.results.map(row => [row.sessionId, row]))
    const results = []
    for (const sessionId of command.sessionIds as string[]) {
      const row = retired.has(sessionId) ? { sessionId, ok: true as const } : rows.get(sessionId)
      if (!row) throw new Error("Missing session deletion result")
      if (!row.ok) { results.push(row); continue }
      try { await drafts.retire({ workspaceId, identity: sessionId }); results.push(row) }
      catch (error) { results.push({ sessionId, ok: false, sessionDeleted: true, error: `Session deleted; native draft cleanup failed. Retry permanent deletion: ${error instanceof Error ? error.message : String(error)}` }) }
    }
    return { results }
  }
  if (value.kind === "desktop/resources/import") {
    const workspaceId = requireNonEmpty(value.workspaceId, "workspaceId")
    if (value.source !== "workspace" && value.source !== "global") throw new Error("Invalid skill import source")
    const runtime = await runtimeForKnownWorkspace(workspaceId, dependencies)
    if (!dependencies.pickSkill || !runtime.info.capabilities["desktop-resource-authoring"]?.includes("1")) throw new Error("Skill import unavailable")
    const selectedPath = await dependencies.pickSkill()
    return selectedPath === undefined ? undefined : runtime.client.request("desktop/resources/import", { source: value.source, selectedPath })
  }
  if (value.kind.startsWith("browser/")) {
    const workspaceId = requireNonEmpty(value.workspaceId, "workspaceId")
    if (!dependencies.catalog.get(workspaceId)) throw new Error("Unknown browser workspace")
    if (!dependencies.browser) throw new Error("Browser surface unavailable")
    return dependencies.browser.request(workspaceId, value)
  }
  const contextParams = contextRequestParams(value)
  if (contextParams !== undefined) {
    const runtime = await runtimeForKnownWorkspace(requireNonEmpty(value.workspaceId, "workspaceId"), dependencies)
    if (value.kind.startsWith("desktop/session/subagents/") && !runtime.info.capabilities["desktop-subagent-catalog"]?.includes("1")) throw new Error("Subagent catalog unavailable")
    if (value.kind === "desktop/approval-rules/add") {
      const navigation = await runtime.client.request("desktop/session/navigation/state", {})
      if (!navigation || typeof navigation !== "object" || !Object.hasOwn(navigation, String(contextParams.sessionId))) throw new Error("Approval conversation unavailable")
    }
    const longOperation = ["desktop/session/compact", "desktop/mcp/mutate", "desktop/mcp/refresh", "desktop/hooks/mutate", "desktop/hooks/refresh", "desktop/wsl/repair", "desktop/wsl/diagnose"].includes(value.kind)
    return runtime.client.request(value.kind, contextParams, longOperation ? 600000 : 30000)
  }

  switch (value.kind as DesktopRequest["kind"]) {
    case "desktop/context/search":
    case "desktop/context/read": {
      const selection = { workspaceId: requireNonEmpty(value.workspaceId, "workspaceId"), ...(value.sessionId === undefined ? {} : { sessionId: requireNonEmpty(value.sessionId, "sessionId") }), ...(value.projectId === undefined ? {} : { projectId: requireNonEmpty(value.projectId, "projectId") }) }
      const query = value.kind.endsWith("/search") ? contextQuery(value) : undefined
      const reference = query ? undefined : contextReference(value.reference)
      const scope = await resolveCurrentProjectMembers(selection, dependencies)
      if (reference) {
        const { runtime, projectId } = await runtimeForProjectMember(selection, reference.workspaceId, dependencies)
        const result = await runtime.client.request("desktop/context/read", { reference, ...(projectId ? { projectId } : {}) })
        const current = await resolveCurrentProjectMembers(selection, dependencies)
        if (current.projectId !== scope.projectId || !current.members.some((row) => row.id === reference.workspaceId && row.path === scope.members.find((member) => member.id === reference.workspaceId)?.path)) throw new Error("Project folder membership changed")
        return result
      }
      const items: ContextItem[] = []
      let truncated = false
      let remainingOffset = query!.offset
      for (const member of scope.members) {
        const { runtime, projectId } = await runtimeForProjectMember(selection, member.id, dependencies)
        if (!runtime.info.capabilities["desktop-context-picker"]?.includes("1")) throw new Error("Context picker unavailable")
        const page = await runtime.client.request("desktop/context/search", { ...query!, offset: remainingOffset, ...(projectId ? { projectId } : {}) }) as { items: Omit<ContextItem, "workspaceId">[]; truncated?: boolean; total?: number }
        if (!Array.isArray(page?.items)) throw new Error("Invalid context results")
        truncated ||= !!page.truncated
        if (remainingOffset >= (page.total ?? page.items.length)) { remainingOffset -= page.total ?? page.items.length; continue }
        items.push(...page.items.slice(0, 31 - items.length).map((item) => ({ ...item, workspaceId: member.id, workspaceLabel: member.label } as ContextItem)))
        remainingOffset = 0
        if (items.length > 30) break
      }
      const current = await resolveCurrentProjectMembers(selection, dependencies)
      if (current.projectId !== scope.projectId || JSON.stringify(current.members) !== JSON.stringify(scope.members)) throw new Error("Project folder membership changed")
      return { items: items.slice(0, 30), nextOffset: items.length > 30 ? query!.offset + 30 : null, truncated }
    }
    case "workspace/attachments/pick": {
      const workspaceId = requireNonEmpty(value.workspaceId, "workspaceId")
      const workspace = dependencies.catalog.get(workspaceId)
      if (!workspace) throw new Error("Unknown workspace")
      if (typeof value.allowImages !== "boolean") throw new Error("Invalid attachment image setting")
      const selected = await dependencies.pickFiles?.(workspace.path)
      if (!selected?.length) return { paths: [], images: [], texts: [] }
      return await readPickedAttachments(workspace.path, selected, value.allowImages)
    }
    case "projects/list": {
      if (!dependencies.projects) throw new Error("Project catalog unavailable")
      return await dependencies.projects.list()
    }
    case "projects/save": {
      if (!dependencies.projects) throw new Error("Project catalog unavailable")
      const input = requireRecord(value.input)
      if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 256 || !Array.isArray(input.workspaceIds) || input.workspaceIds.length > 100 || input.workspaceIds.some((id) => typeof id !== "string" || !id)) throw new Error("Invalid project")
      if (input.id !== undefined && (typeof input.id !== "string" || !input.id)) throw new Error("Invalid project id")
      if (input.primaryWorkspaceId !== undefined && typeof input.primaryWorkspaceId !== "string") throw new Error("Invalid primary workspace")
      if (input.pinned !== undefined && typeof input.pinned !== "boolean") throw new Error("Invalid project pin")
      if (input.expectedUpdatedAt !== undefined && (typeof input.expectedUpdatedAt !== "string" || !input.expectedUpdatedAt || input.expectedUpdatedAt.length > 64)) throw new Error("Invalid project revision")
      const saved = await dependencies.projects.save({ name: input.name, workspaceIds: input.workspaceIds as string[], ...(typeof input.id === "string" ? { id: input.id } : {}), ...(typeof input.primaryWorkspaceId === "string" ? { primaryWorkspaceId: input.primaryWorkspaceId } : {}), ...(typeof input.pinned === "boolean" ? { pinned: input.pinned } : {}), ...(typeof input.expectedUpdatedAt === "string" ? { expectedUpdatedAt: input.expectedUpdatedAt } : {}) })
      await notifyDesktopProjectContentScopesChanged()
      try { await syncLiveProjectContexts(dependencies.projects, dependencies.catalog, dependencies.runtimes); return saved }
      catch (error) { return { ...saved, runtimeSyncError: error instanceof Error ? error.message : String(error) } }
    }
    case "projects/remove": {
      if (!dependencies.projects) throw new Error("Project catalog unavailable")
      await dependencies.projects.remove(requireNonEmpty(value.id, "project id"))
      await notifyDesktopProjectContentScopesChanged()
      try { await syncLiveProjectContexts(dependencies.projects, dependencies.catalog, dependencies.runtimes); return { removed: true } }
      catch (error) { return { removed: true, runtimeSyncError: error instanceof Error ? error.message : String(error) } }
    }
    case "workspace/reveal": {
      const workspace = dependencies.catalog.get(requireNonEmpty(value.workspaceId, "workspaceId"))
      if (!workspace) throw new Error("Unknown workspace")
      if (!dependencies.revealWorkspace) throw new Error("Folder opening is unavailable")
      await dependencies.revealWorkspace(workspace.path)
      return { opened: true }
    }
    case "desktop/session/navigation/state": {
      const runtime = await runtimeForKnownWorkspace(requireNonEmpty(value.workspaceId, "workspaceId"), dependencies)
      if (!runtime.info.capabilities["desktop-sessions"]?.includes("1")) throw new Error("Session management unavailable")
      return await runtime.client.request(value.kind, {})
    }
    case "desktop/session/project/bind":
    case "desktop/session/project/state": {
      const runtime = await runtimeForKnownWorkspace(requireNonEmpty(value.workspaceId, "workspaceId"), dependencies)
      const sessionId = requireNonEmpty(value.sessionId, "sessionId")
      if (!runtime.info.capabilities["desktop-project-scope"]?.includes("1")) throw new Error("Project execution scopes are unavailable")
      if (value.kind.endsWith("/state")) return await runtime.client.request(value.kind, { sessionId })
      if (!dependencies.projects) throw new Error("Project catalog unavailable")
      const scopes = await projectRuntimeContexts(dependencies.projects, dependencies.catalog)
      const projectId = value.projectId === undefined ? undefined : requireNonEmpty(value.projectId, "projectId")
      if (projectId && !scopes.some((scope) => scope.id === projectId && scope.roots.length > 0)) throw new Error("Unknown or empty project")
      await runtime.client.request("desktop/project/sync", { projects: scopes })
      const result = await runtime.client.request(value.kind, { sessionId, ...(projectId ? { projectId } : {}) })
      await notifyDesktopProjectContentScopesChanged()
      return result
    }
    case "workspace/files/pick": {
      const workspaceId = requireNonEmpty(value.workspaceId, "workspaceId")
      const workspace = dependencies.catalog.get(workspaceId)
      if (!workspace) throw new Error("Unknown workspace")
      const chosen = await dependencies.pickFiles?.(workspace.path)
      if (!chosen?.length) return { paths: [] }
      if (chosen.length > 8) throw new Error("Select at most 8 workspace files")
      const paths = [...new Set(chosen.map((file) => {
        const path = relative(workspace.path, file).split(sep).join("/")
        if (!path || isAbsolute(path) || path.split("/").includes("..") || /[\0\r\n:]/.test(path) || path.length > 4096) throw new Error("Select files inside the current workspace")
        return path
      }))]
      const runtime = await runtimeForKnownWorkspace(workspaceId, dependencies)
      for (const path of paths) {
        const result = await runtime.client.request("desktop/review/file", { path, maxBytes: 1 }) as { kind?: string; reason?: string }
        if (result?.kind !== "text" && result?.reason !== "binary") throw new Error(`Cannot reference workspace file: ${path}`)
      }
      return { paths }
    }
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
      if (value.followupDelivery !== undefined && value.followupDelivery !== "queue" && value.followupDelivery !== "steer") throw new Error("invalid follow-up delivery")
      if (value.notifications !== undefined && typeof value.notifications !== "boolean") throw new Error("invalid notifications preference")
      if (value.locale !== undefined && value.locale !== "zh-TW" && value.locale !== "en") throw new Error("invalid locale")
      if (value.terminalShell !== undefined && (typeof value.terminalShell !== "string" || !["auto", "git-bash", "pwsh", "powershell", "cmd", "bash", "zsh", "sh"].includes(value.terminalShell))) throw new Error("invalid terminal shell")
      if (value.terminalFontFamily !== undefined && (typeof value.terminalFontFamily !== "string" || value.terminalFontFamily.length > 128 || /[\u0000-\u001f\u007f]/.test(value.terminalFontFamily))) throw new Error("invalid terminal font")
      if (!dependencies.native) throw new Error("native preferences unavailable")
      return dependencies.native.configure({ ...(typeof value.notifications === "boolean" ? { notifications: value.notifications } : {}), ...(value.locale === "en" || value.locale === "zh-TW" ? { locale: value.locale } : {}), ...(typeof value.terminalShell === "string" ? { terminalShell: value.terminalShell as TerminalShellChoice } : {}), ...(typeof value.terminalFontFamily === "string" ? { terminalFontFamily: value.terminalFontFamily.trim() } : {}), ...(value.followupDelivery === "queue" || value.followupDelivery === "steer" ? { followupDelivery: value.followupDelivery } : {}) })
    case "workspace/list":
      return await dependencies.catalog.list()
    case "workspace/open":
      return await dependencies.catalog.open(requireNonEmptyPath(value.path))
    case "workspace/pick": {
      const picked = await dependencies.pickFolder?.()
      return picked === undefined ? undefined : await dependencies.catalog.open(picked)
    }
    case "workspace/sandbox/state":
      {
        const runtime = await runtimeForKnownWorkspace(requireNonEmpty(value.workspaceId, "workspaceId"), dependencies)
        return runtime.info.capabilities["desktop-sandbox"]?.includes("1")
          ? validateSandboxState(await runtime.client.request("desktop/sandbox/state", {}))
          : runtime.sandbox
      }
    case "desktop/capabilities":
      return { ...(await runtimeForKnownWorkspace(requireNonEmpty(value.workspaceId, "workspaceId"), dependencies)).info.capabilities, ...(dependencies.drafts ? { "desktop-drafts": ["1"] } : {}) }
    case "session/list":
      return await (await runtimeForKnownWorkspace(requireNonEmpty(value.workspaceId, "workspaceId"), dependencies)).client.listSessions()
    case "desktop/session/archived":
      return await (await runtimeForKnownWorkspace(requireNonEmpty(value.workspaceId, "workspaceId"), dependencies)).client.request(value.kind, {})
    case "desktop/rewind/points":
    case "desktop/rewind/plan":
    case "desktop/rewind/execute": {
      const workspaceId = requireNonEmpty(value.workspaceId, "workspaceId")
      const sessionId = requireNonEmpty(value.sessionId, "sessionId")
      const params: Record<string, unknown> = { sessionId }
      if (value.kind !== "desktop/rewind/points") {
        params.target = requireNonNegativeInteger(value.target, "target")
        if (!["all", "files", "conversation"].includes(String(value.mode))) throw new Error("invalid rewind mode")
        params.mode = value.mode
      }
      if (value.kind === "desktop/rewind/execute") {
        if (typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)) throw new Error("invalid rewind confirmation")
        params.fingerprint = value.fingerprint
      }
      return await (await runtimeForKnownWorkspace(workspaceId, dependencies)).client.request(value.kind, params, 120000)
    }
    case "desktop/session/manage": {
      const workspaceId = requireNonEmpty(value.workspaceId, "workspaceId")
      const sessionId = requireNonEmpty(value.sessionId, "sessionId")
      if (!["rename", "archive", "restore", "fork", "pin", "unpin", "read", "unread"].includes(String(value.action))) throw new Error("invalid session action")
      const title = value.action === "rename" ? requireNonEmpty(value.title, "title") : undefined
      if (title && title.length > 256) throw new Error("title is too long")
      return await (await runtimeForKnownWorkspace(workspaceId, dependencies)).client.request(value.kind, { sessionId, action: value.action, ...(title ? { title } : {}) })
    }
    case "session/dashboard":
      return await (await runtimeForKnownWorkspace(requireNonEmpty(value.workspaceId, "workspaceId"), dependencies)).client.dashboard()
    case "session/create": {
      const workspaceId = requireNonEmpty(value.workspaceId, "workspaceId")
      if (value.clientToken !== undefined && (typeof value.clientToken !== "string" || value.clientToken.length < 8 || value.clientToken.length > 128)) throw new Error("Invalid draft creation token")
      const runtime = await runtimeForKnownWorkspace(workspaceId, dependencies)
      let projectId: string | undefined
      if (value.projectId !== undefined) {
        projectId = requireNonEmpty(value.projectId, "projectId")
        if (!dependencies.projects || !(await dependencies.projects.list()).some((project) => project.id === projectId && project.workspaceIds.includes(workspaceId))) throw new Error("Project does not contain the selected folder")
      }
      if (value.clientToken && !runtime.info.capabilities["desktop-draft-create"]?.includes("1")) throw new Error("Durable draft creation unavailable")
      const created = value.clientToken ? await runtime.client.request("session/create", { clientToken: value.clientToken }) as { sessionId: string } : await runtime.client.createSession()
      if (projectId) {
        await runtime.client.request("desktop/project/sync", { projects: await projectRuntimeContexts(dependencies.projects!, dependencies.catalog) })
        await runtime.client.request("desktop/session/project/bind", { sessionId: created.sessionId, projectId })
      }
      return created
    }
    case "session/history": {
      // Validate every field BEFORE any runtime side effect.
      const workspaceId = requireNonEmpty(value.workspaceId, "workspaceId")
      const sessionId = requireNonEmpty(value.sessionId, "sessionId")
      const afterSeq = requireNonNegativeInteger(value.afterSeq, "afterSeq")
      const limit = requireHistoryLimit(value.limit)
      return await (await runtimeForKnownWorkspace(workspaceId, dependencies)).client.history(sessionId, { afterSeq, limit })
    }
    case "session/context": {
      const workspaceId = requireNonEmpty(value.workspaceId, "workspaceId")
      const sessionId = requireNonEmpty(value.sessionId, "sessionId")
      const runtime = await runtimeForKnownWorkspace(workspaceId, dependencies)
      if (!runtime.info.capabilities["session-context"]?.includes("1")) throw new Error("Session context is unavailable")
      return await runtime.client.request("session/context", { sessionId })
    }
    case "desktop/session/input/submit":
    case "session/prompt": {
      const workspaceId = requireNonEmpty(value.workspaceId, "workspaceId")
      const sessionId = requireNonEmpty(value.sessionId, "sessionId")
      const prompt = requireNonEmpty(value.kind === "session/prompt" ? value.prompt : value.text, "prompt")
      if (value.kind === "desktop/session/input/submit" && value.delivery !== "queue" && value.delivery !== "steer") throw new Error("Invalid input delivery")
      if (value.context !== undefined && (typeof value.context !== "string" || value.context.length > 131072)) throw new Error("Invalid prompt context")
      if (value.clientToken !== undefined && (typeof value.clientToken !== "string" || value.clientToken.length < 8 || value.clientToken.length > 128)) throw new Error("Invalid prompt client token")
      if (value.images !== undefined && (!Array.isArray(value.images) || value.images.length > 10)) throw new Error("Invalid prompt images")
      const runtime = await runtimeForKnownWorkspace(workspaceId, dependencies)
      if (runtime.sandbox?.wired !== true) throw new Error("sandbox-not-enabled")
      if (value.context !== undefined && !runtime.info.capabilities["prompt-context"]?.includes("1")) throw new Error("Prompt context is not supported by this gateway")
      if (value.images?.length && !runtime.info.capabilities["prompt-images"]?.includes("1")) throw new Error("Prompt images are not supported by this gateway")
      return await runtime.client.request(value.kind === "session/prompt" ? "session/prompt" : "desktop/session/input/submit", {
        sessionId,
        ...(value.kind === "session/prompt" ? { prompt } : { text: prompt, delivery: value.delivery }),
        ...(value.context !== undefined ? { context: value.context } : {}),
        ...(value.clientToken !== undefined ? { clientToken: value.clientToken } : {}),
        ...(value.images?.length ? { images: value.images } : {}),
      }, 24 * 60 * 60 * 1000)
    }
    case "desktop/session/input/state":
    case "desktop/session/input/resume":
    case "desktop/session/input/cancel": {
      const runtime = await runtimeForKnownWorkspace(requireNonEmpty(value.workspaceId, "workspaceId"), dependencies)
      if (!runtime.info.capabilities["desktop-input"]?.includes("1")) throw new Error("Durable input is not supported by this gateway")
      return await runtime.client.request(value.kind, { sessionId: requireNonEmpty(value.sessionId, "sessionId"), ...(value.kind === "desktop/session/input/cancel" ? { inputId: requireNonEmpty(value.inputId, "inputId") } : {}) })
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
    case "session/model/set": {
      const workspaceId = requireNonEmpty(value.workspaceId, "workspaceId")
      const sessionId = requireNonEmpty(value.sessionId, "sessionId")
      const selection = requireRecord(value.selection)
      const provider = requireNonEmpty(selection.provider, "provider")
      const model = requireNonEmpty(selection.model, "model")
      const protocol = selection.protocol === undefined ? undefined : requireNonEmpty(selection.protocol, "protocol")
      const reasoningEffort = selection.reasoningEffort === undefined ? undefined : requireNonEmpty(selection.reasoningEffort, "reasoningEffort")
      return await (await runtimeForKnownWorkspace(workspaceId, dependencies)).client.request("session/model/set", { sessionId, selection: { provider, model, ...(protocol ? { protocol } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) } })
    }
    case "desktop/provider/directory":
      return await (await runtimeForKnownWorkspace(requireNonEmpty(value.workspaceId, "workspaceId"), dependencies)).client.request("desktop/provider/directory", {})
    case "desktop/plugins/state":
    case "desktop/plugins/commands":
    case "desktop/plugins/refresh":
      return await (await runtimeForKnownWorkspace(requireNonEmpty(value.workspaceId, "workspaceId"), dependencies)).client.request(value.kind, {}, 120000)
    case "desktop/terminal/list":
    case "desktop/terminal/options":
    case "desktop/terminal/open":
    case "desktop/terminal/read":
    case "desktop/terminal/write":
    case "desktop/terminal/resize":
    case "desktop/terminal/close": {
      if (value.kind === "desktop/terminal/options" && value.workspaceId === undefined) return (dependencies.shellOptions ?? listDesktopTerminalShellOptions)()
      const workspaceId = requireNonEmpty(value.workspaceId, "workspaceId")
      const params: Record<string, unknown> = {}
      if (value.kind !== "desktop/terminal/list" && value.kind !== "desktop/terminal/options" && value.kind !== "desktop/terminal/open") params.id = requireNonEmpty(value.id, "terminal id")
      if (value.kind === "desktop/terminal/open") params.shell = dependencies.native?.state().terminalShell ?? "auto"
      if (value.kind === "desktop/terminal/read") params.offset = requireNonNegativeInteger(value.offset, "offset")
      if (value.kind === "desktop/terminal/write") {
        if (typeof value.data !== "string" || value.data.length > 32768) throw new Error("invalid terminal input")
        params.data = value.data
      }
      if (value.kind === "desktop/terminal/resize") {
        for (const dimension of ["cols", "rows"]) {
          const size = requireNonNegativeInteger(value[dimension], dimension)
          if (size < 2 || size > 500) throw new Error("invalid terminal size")
          params[dimension] = size
        }
      }
      return await (await runtimeForKnownWorkspace(workspaceId, dependencies)).client.request(value.kind, params)
    }
    case "desktop/schedule/list":
    case "desktop/schedule/create":
    case "desktop/schedule/delete": {
      const workspaceId = requireNonEmpty(value.workspaceId, "workspaceId")
      const sessionId = requireNonEmpty(value.sessionId, "sessionId")
      const runtime = await runtimeForKnownWorkspace(workspaceId, dependencies)
      if (!runtime.info.capabilities["desktop-schedule"]?.includes("1")) throw new Error("Desktop schedule management unavailable")
      if (value.kind === "desktop/schedule/list") return runtime.client.request(value.kind, { sessionId })
      if (value.kind === "desktop/schedule/delete") {
        if (typeof value.id !== "string" || !/^schedule-\d+$/.test(value.id)) throw new Error("invalid schedule id")
        return runtime.client.request(value.kind, { sessionId, id: value.id })
      }
      const command = requireRecord(value.command)
      const allowed = ["prompt", "after_seconds", "at", "every_seconds"]
      if (Object.keys(command).some((key) => !allowed.includes(key))) throw new Error("invalid schedule command")
      const prompt = requireNonEmpty(command.prompt, "schedule prompt").trim()
      if (!prompt || prompt.length > 4096) throw new Error("invalid schedule prompt")
      const selectors = [command.after_seconds, command.at, command.every_seconds].filter((entry) => entry !== undefined)
      if (selectors.length !== 1) throw new Error("invalid schedule time selector")
      const sanitized: { prompt: string; after_seconds?: number; at?: string; every_seconds?: number } = { prompt }
      if (command.after_seconds !== undefined) {
        if (typeof command.after_seconds !== "number" || !Number.isSafeInteger(command.after_seconds) || command.after_seconds < 1) throw new Error("invalid schedule delay")
        sanitized.after_seconds = command.after_seconds
      }
      if (command.every_seconds !== undefined) {
        if (typeof command.every_seconds !== "number" || !Number.isSafeInteger(command.every_seconds) || command.every_seconds < 300) throw new Error("invalid schedule interval")
        sanitized.every_seconds = command.every_seconds
      }
      if (command.at !== undefined) {
        if (typeof command.at !== "string" || Number.isNaN(Date.parse(command.at)) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(command.at)) throw new Error("invalid schedule time")
        sanitized.at = command.at
      }
      return runtime.client.request(value.kind, { sessionId, command: sanitized })
    }
    case "desktop/agent-shell/state":
    case "desktop/agent-shell/configure":
    case "desktop/session/workflow/read":
    case "desktop/session/workflow/mutate":
    case "desktop/session/job/output": {
      const workspaceId = requireNonEmpty(value.workspaceId, "workspaceId")
      const runtime = await runtimeForKnownWorkspace(workspaceId, dependencies)
      const params: Record<string, unknown> = {}
      if (value.kind.startsWith("desktop/session/")) params.sessionId = requireNonEmpty(value.sessionId, "sessionId")
      if (value.kind === "desktop/agent-shell/configure") params.patch = requireRecord(value.patch)
      if (value.kind === "desktop/session/workflow/mutate") params.command = requireRecord(value.command)
      if (value.kind === "desktop/session/job/output") params.id = requireNonEmpty(value.id, "id")
      return runtime.client.request(value.kind, params, 600000)
    }
    case "desktop/session/todo/write":
    case "desktop/session/work-state": {
      const workspaceId = requireNonEmpty(value.workspaceId, "workspaceId")
      const sessionId = requireNonEmpty(value.sessionId, "sessionId")
      if (sessionId.length > 128) throw new Error("invalid work state session")
      const runtime = await runtimeForKnownWorkspace(workspaceId, dependencies)
      if (!runtime.info.capabilities["desktop-work-state"]?.includes("1")) throw new Error("Desktop work state unavailable")
      if (value.kind === "desktop/session/todo/write") {
        const input = requireRecord(value.input)
        if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0 || !Array.isArray(input.items) || input.items.length > 200) throw new Error("Invalid Todo snapshot")
        for (const row of input.items) {
          const item = requireRecord(row)
          if (typeof item.content !== "string" || !item.content.trim() || item.content.length > 4096 || !["pending", "in_progress", "completed"].includes(String(item.status))) throw new Error("Invalid Todo item")
        }
        return runtime.client.request(value.kind, { sessionId, input })
      }
      return runtime.client.request(value.kind, { sessionId })
    }
    case "desktop/plugins/mutate": {
      const workspaceId = requireNonEmpty(value.workspaceId, "workspaceId")
      const command = requireRecord(value.command)
      if (!["source/add", "source/refresh", "source/remove", "install", "uninstall", "enable", "disable"].includes(String(command.action))) throw new Error("invalid plugin action")
      const field = command.action === "source/add" ? "source" : String(command.action).startsWith("source/") ? "name" : "id"
      const valueText = requireNonEmpty(command[field], field)
      if (valueText.length > 4096) throw new Error("plugin parameter too long")
      return await (await runtimeForKnownWorkspace(workspaceId, dependencies)).client.request(value.kind, { action: command.action, [field]: valueText }, 300000)
    }
    case "desktop/provider/probe":
    case "desktop/provider/probe/cancel": {
      const workspaceId = requireNonEmpty(value.workspaceId, "workspaceId")
      const token = requireNonEmpty(value.token, "token")
      const id = value.kind === "desktop/provider/probe" ? requireNonEmpty(value.id, "provider id") : undefined
      if (token.length > 128 || (id !== undefined && id.length > 128)) throw new Error("invalid provider probe")
      return await (await runtimeForKnownWorkspace(workspaceId, dependencies)).client.request(value.kind, { token, ...(id ? { id } : {}) }, 40000)
    }
    case "desktop/provider/mutate": {
      const workspaceId = requireNonEmpty(value.workspaceId, "workspaceId")
      const command = requireRecord(value.command)
      if (!["provider/create", "provider/edit", "provider/remove", "key/set", "key/clear", "model/add", "model/edit", "model/remove", "default/set"].includes(String(command.action))
        || JSON.stringify(command).length > 24000) throw new Error("invalid provider command")
      return await (await runtimeForKnownWorkspace(workspaceId, dependencies)).client.request("desktop/provider/mutate", command)
    }
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
      let remember: { scope: "session" | "workspace"; expiresAt: number } | undefined
      if (record.remember !== undefined) {
        const raw = requireRecord(record.remember)
        if (!approval || record.approved !== true || !["session", "workspace"].includes(String(raw.scope)) || typeof raw.expiresAt !== "number" || !Number.isSafeInteger(raw.expiresAt) || raw.expiresAt <= Date.now() || raw.expiresAt > Date.now() + 366 * 86400000) throw new Error("Invalid remembered approval")
        remember = { scope: raw.scope as "session" | "workspace", expiresAt: raw.expiresAt }
      }
      return await (await runtimeForKnownWorkspace(workspaceId, dependencies)).client.request("desktop/interaction/reply/trusted-human", {
        requestId,
        sessionId,
        decision: approval
          ? { kind: "approval", approved: record.approved as boolean, ...(remember ? { remember } : {}) }
          : { kind: "question", answer: record.answer as string },
      })
    }
    case "desktop/review/file/save":
    case "desktop/review/stage":
    case "desktop/review/unstage":
    case "desktop/review/commit": {
      const runtime = await runtimeForKnownWorkspace(requireNonEmpty(value.workspaceId, "workspaceId"), dependencies)
      if (!runtime.info.capabilities["desktop-review"]?.includes("1")) throw new Error("Review is unavailable")
      if (value.kind === "desktop/review/commit") {
        const message = requireNonEmpty(value.message, "commit message")
        if (message.length > 4096 || message.includes("\0")) throw new Error("Invalid commit message")
        return await runtime.client.request(value.kind, { message }, 120000)
      }
      const path = requireNonEmpty(value.path, "path")
      if (value.kind === "desktop/review/file/save") {
        if (typeof value.text !== "string" || Buffer.byteLength(value.text, "utf8") > 1024 * 1024 || typeof value.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedRevision)) throw new Error("Invalid file edit")
        return await runtime.client.request(value.kind, { path, text: value.text, expectedRevision: value.expectedRevision })
      }
      return await runtime.client.request(value.kind, { path })
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
  const projectContentSearch = createDesktopProjectContentSearch(dependencies)
  const ownedDependencies = { ...dependencies, projectContentSearch }
  ipc.handle(DESKTOP_REQUEST_CHANNEL, async (event, request) => {
    if (event.sender !== window.webContents) throw new Error("untrusted IPC sender")
    return await dispatchDesktopRequest(request, ownedDependencies)
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
    void projectContentSearch.close()
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
