import { app, BrowserWindow, dialog, ipcMain, shell, clipboard, type Tray } from "electron"
import { join } from "node:path"
import { registerDesktopIpc } from "./ipc.ts"
import { createWorkspaceRuntimeManager, launchBundledGateway, type WorkspaceRuntimeManager } from "./sdk-runtime.ts"
import { createDesktopWindow } from "./window.ts"
import { createWorkspaceCatalog, type WorkspaceCatalog } from "./workspaces.ts"
import { createProjectCatalog } from "./projects.ts"
import { projectRuntimeContexts } from "./project-runtime.ts"
import { createLocalPreferences } from "./local-preferences.ts"
import { attachNativeWindow } from "./native-window.ts"
import { createBrowserSurface } from "./browser-surface.ts"
import { attachCloseLifecycle } from "./close-lifecycle.ts"
import { createDesktopTray } from "./tray.ts"
import { createGlobalProviderSettings } from "./global-provider-settings.ts"
import { createNotificationHistory } from "./notification-history.ts"
import { AttachmentDraftStore } from "./attachment-draft-store.ts"
import { closeDesktopProjectContentSearches } from "./project-content-search.ts"
import { resolveDesktopProfilePath } from "./profile-path.ts"

app.setPath("userData", resolveDesktopProfilePath(app.getPath("appData"), app.getPath("userData"), undefined, app.commandLine.hasSwitch("user-data-dir")))

let catalog: WorkspaceCatalog | undefined
let runtimes: WorkspaceRuntimeManager | undefined
let quitting = false
let drainNativeSettings: (() => Promise<void>) | undefined

/** Later main-process modules (the scoped IPC in the next task) read through these. */
export function workspaceCatalog(): WorkspaceCatalog {
  if (catalog === undefined) throw new Error("workspace catalog is not ready")
  return catalog
}

export function workspaceRuntimes(): WorkspaceRuntimeManager {
  if (runtimes === undefined) throw new Error("workspace runtimes are not ready")
  return runtimes
}

app.whenReady().then(() => {
  const localPreferences = createLocalPreferences(join(app.getPath("userData"), "desktop-preferences.json"))
  const workspaces = createWorkspaceCatalog(join(app.getPath("userData"), "workspaces.json"))
  const projects = createProjectCatalog(join(app.getPath("userData"), "projects.json"), workspaces)
  const manager = createWorkspaceRuntimeManager({
    projectContexts: () => projectRuntimeContexts(projects, workspaces),
    sessionsRoot: join(app.getPath("userData"), "sessions"),
    ...(app.isPackaged
      ? { launch: (workspace, sessionDir) => launchBundledGateway(process.resourcesPath, workspace, sessionDir) }
      : {}),
  })
  catalog = workspaces
  runtimes = manager
  const globalProviders = createGlobalProviderSettings(async () => (await manager.get({ id: "desktop-configuration", path: app.getPath("userData"), label: "本機設定" })).client)
  const notifications = createNotificationHistory(join(app.getPath("userData"), "notifications-v1.json"))
  const drafts = new AttachmentDraftStore(join(app.getPath("userData"), "unsent-drafts-v1"))
  drainNativeSettings = async () => { await closeDesktopProjectContentSearches(); await globalProviders.close(); await manager.close(); await notifications.flush(); await drafts.flush() }
  const applicationInfo = () => ({ version: app.getVersion(), electron: process.versions.electron, node: process.versions.node, platform: process.platform, arch: process.arch, packaged: app.isPackaged, updateSupported: false })
  let mainWindow: BrowserWindow | undefined
  let tray: Tray | undefined
  const openWindow = (): void => {
    const window = createDesktopWindow(localPreferences.get())
    mainWindow = window
    attachCloseLifecycle(window, {
      hasActiveWork: () => manager.hasActiveWork(),
      trayAvailable: () => tray !== undefined,
      isQuitting: () => quitting,
    })
    const native = attachNativeWindow(window, localPreferences, { notifications })
    const browser = createBrowserSurface(window)
    const unregister = registerDesktopIpc(window, {
      catalog: workspaces,
      projects,
      revealWorkspace: async (path) => { const failure = await shell.openPath(path); if (failure) throw new Error(failure) },
      runtimes: manager,
      native,
      browser,
      globalProviders,
      notifications,
      drafts,
      about: { info: applicationInfo, copy: async () => { await clipboard.writeText(JSON.stringify(applicationInfo(), null, 2)); return { copied: true } } },
      pickSkill: async () => {
        const result = await dialog.showOpenDialog(window, { properties: ["openFile"], filters: [{ name: "SKILL.md", extensions: ["md"] }] })
        return result.canceled ? undefined : result.filePaths[0]
      },
      pickFiles: async (workspacePath) => {
        const result = await dialog.showOpenDialog(window, { defaultPath: workspacePath, properties: ["openFile", "multiSelections"] })
        return result.canceled ? undefined : result.filePaths
      },
      pickFolder: async () => {
        const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"] })
        return result.canceled ? undefined : result.filePaths[0]
      },
    }, ipcMain)
    window.on("closed", () => { unregister(); if (mainWindow === window) mainWindow = undefined })
  }
  const showWindow = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) { openWindow(); return }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show(); mainWindow.focus()
  }
  openWindow()
  if (process.platform === "win32") {
    try { tray = createDesktopTray({ show: showWindow, quit: () => app.quit(), locale: () => localPreferences.get().locale }) }
    catch (error) { console.warn("Desktop tray unavailable; active work will remain in the taskbar", error) }
  }
  app.on("activate", () => {
    if (process.platform === "darwin" && BrowserWindow.getAllWindows().length === 0) openWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

// Every SDK child belongs to this process: close them before the app goes away.
app.on("before-quit", (event) => {
  if (quitting || runtimes === undefined) return
  event.preventDefault()
  quitting = true
  void (drainNativeSettings ? drainNativeSettings() : runtimes.close()).finally(() => app.quit())
})

