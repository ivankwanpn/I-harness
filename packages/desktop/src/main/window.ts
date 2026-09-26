import { BrowserWindow, shell } from "electron"
import { externalWebUrl } from "./external-url.ts"
import { join } from "node:path"
import { windowPreferences } from "./window-options.ts"

export function createDesktopWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1340,
    height: 860,
    minWidth: 880,
    minHeight: 580,
    show: false,
    backgroundColor: "#151515",
    autoHideMenuBar: true,
    webPreferences: windowPreferences(join(__dirname, "../preload/index.cjs")),
  })
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, "../renderer/index.html"))
  window.once("ready-to-show", () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalWebUrl(url)
    if (external !== undefined) void shell.openExternal(external).catch(() => undefined)
    return { action: "deny" }
  })
  return window
}
