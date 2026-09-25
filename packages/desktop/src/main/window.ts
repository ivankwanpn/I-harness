import { BrowserWindow } from "electron"
import { join } from "node:path"
import { windowPreferences } from "./window-options.ts"

export function createDesktopWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1340,
    height: 860,
    minWidth: 880,
    minHeight: 580,
    show: false,
    backgroundColor: "#f8f8f8",
    webPreferences: windowPreferences(join(__dirname, "../preload/index.cjs")),
  })
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, "../renderer/index.html"))
  window.once("ready-to-show", () => window.show())
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  return window
}
