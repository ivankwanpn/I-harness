import { app, BrowserWindow } from "electron"
import { join } from "node:path"
import { createWorkspaceRuntimeManager, type WorkspaceRuntimeManager } from "./sdk-runtime.ts"
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
  catalog = createWorkspaceCatalog(join(app.getPath("userData"), "workspaces.json"))
  runtimes = createWorkspaceRuntimeManager({ sessionsRoot: join(app.getPath("userData"), "sessions") })
  createDesktopWindow()
  app.on("activate", () => {
    if (process.platform === "darwin" && BrowserWindow.getAllWindows().length === 0) createDesktopWindow()
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
