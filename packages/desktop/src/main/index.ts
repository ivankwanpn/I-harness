import { app, BrowserWindow } from "electron"
import { join } from "node:path"
import { createDesktopWindow } from "./window.ts"
import { createWorkspaceCatalog, type WorkspaceCatalog } from "./workspaces.ts"

let catalog: WorkspaceCatalog | undefined

/** Later main-process modules (the scoped IPC in the next task) read through this. */
export function workspaceCatalog(): WorkspaceCatalog {
  if (catalog === undefined) throw new Error("workspace catalog is not ready")
  return catalog
}

app.whenReady().then(() => {
  catalog = createWorkspaceCatalog(join(app.getPath("userData"), "workspaces.json"))
  createDesktopWindow()
  app.on("activate", () => {
    if (process.platform === "darwin" && BrowserWindow.getAllWindows().length === 0) createDesktopWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
