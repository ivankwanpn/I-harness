import { app, BrowserWindow, dialog, ipcMain } from "electron"
import { join } from "node:path"
import { registerDesktopIpc } from "./ipc.ts"
import { createWorkspaceRuntimeManager, launchBundledGateway, type WorkspaceRuntimeManager } from "./sdk-runtime.ts"
import { createDesktopWindow } from "./window.ts"
import { createWorkspaceCatalog, type WorkspaceCatalog } from "./workspaces.ts"

let catalog: WorkspaceCatalog | undefined
let runtimes: WorkspaceRuntimeManager | undefined

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
  const workspaces = createWorkspaceCatalog(join(app.getPath("userData"), "workspaces.json"))
  const manager = createWorkspaceRuntimeManager({
    sessionsRoot: join(app.getPath("userData"), "sessions"),
    ...(app.isPackaged
      ? { launch: (workspace, sessionDir) => launchBundledGateway(process.resourcesPath, workspace, sessionDir) }
      : {}),
  })
  catalog = workspaces
  runtimes = manager
  const openWindow = (): void => {
    const window = createDesktopWindow()
    const unregister = registerDesktopIpc(window, {
      catalog: workspaces,
      runtimes: manager,
      pickFolder: async () => {
        const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"] })
        return result.canceled ? undefined : result.filePaths[0]
      },
    }, ipcMain)
    window.on("closed", unregister)
  }
  openWindow()
  app.on("activate", () => {
    if (process.platform === "darwin" && BrowserWindow.getAllWindows().length === 0) openWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

let quitting = false

// Every SDK child belongs to this process: close them before the app goes away.
app.on("before-quit", (event) => {
  if (quitting || runtimes === undefined) return
  event.preventDefault()
  quitting = true
  void runtimes.close().finally(() => app.quit())
})
