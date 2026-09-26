import { BrowserWindow, screen, shell } from "electron"
import { restoreBounds, type LocalPreferences } from "./local-preferences.ts"
import { externalWebUrl } from "./external-url.ts"
import { join } from "node:path"
import { windowPreferences } from "./window-options.ts"

export function createDesktopWindow(preferences?: LocalPreferences): BrowserWindow {
  const window = new BrowserWindow({
    ...restoreBounds(preferences?.bounds, [screen.getPrimaryDisplay().workArea, ...screen.getAllDisplays().filter((display) => display.id !== screen.getPrimaryDisplay().id).map((display) => display.workArea)]),
    minWidth: 640,
    minHeight: 480,
    frame: false,
    show: false,
    backgroundColor: "#151515",
    autoHideMenuBar: true,
    webPreferences: windowPreferences(join(__dirname, "../preload/index.cjs")),
  })
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, "../renderer/index.html"))
  window.once("ready-to-show", () => { if (preferences?.maximized) window.maximize(); window.show() })
  window.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalWebUrl(url)
    if (external !== undefined) void shell.openExternal(external).catch(() => undefined)
    return { action: "deny" }
  })
  return window
}
