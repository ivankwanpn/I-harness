import { BrowserWindow, screen, shell } from "electron"
import { restoreBounds, type LocalPreferences } from "./local-preferences.ts"
import { externalWebUrl } from "./external-url.ts"
import { join, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { windowPreferences } from "./window-options.ts"

const rendererRoot = join(__dirname, "../renderer")

/** Only the app's own renderer may replace the trusted document. */
function isAppNavigation(target: string): boolean {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl !== undefined) {
    try { return new URL(target).origin === new URL(devUrl).origin } catch { return false }
  }
  try {
    const url = new URL(target)
    return url.protocol === "file:" && fileURLToPath(url).startsWith(rendererRoot + sep)
  } catch { return false }
}


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
  // The preload bridge is bound to this webContents, so ANY other document that
  // replaces the trusted one would inherit window.ihDesktop. Refuse navigation
  // everywhere except the app's own renderer (drag-drop, redirects, links).
  window.webContents.on("will-navigate", (navigation, url) => { if (!isAppNavigation(url)) navigation.preventDefault() })
  window.webContents.on("will-redirect", (navigation, url) => { if (!isAppNavigation(url)) navigation.preventDefault() })
  window.once("ready-to-show", () => { if (preferences?.maximized) window.maximize(); window.show() })
  window.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalWebUrl(url)
    if (external !== undefined) void shell.openExternal(external).catch(() => undefined)
    return { action: "deny" }
  })
  return window
}
