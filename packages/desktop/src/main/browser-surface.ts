import { WebContentsView, session, type BrowserWindow, type Rectangle } from "electron"
import { randomUUID } from "node:crypto"
import { externalWebUrl } from "./external-url.ts"

interface Tab { id: string; workspaceId: string; view: WebContentsView; error?: string }
export function createBrowserSurface(window: BrowserWindow) {
  const tabs = new Map<string, Tab>()
  let active: string | undefined
  let disposed = false
  const get = (workspaceId: string, id: string) => {
    const tab = tabs.get(id)
    if (!tab || tab.workspaceId !== workspaceId || tab.view.webContents.isDestroyed()) throw new Error("Browser tab unavailable")
    return tab
  }
  const hide = () => { for (const tab of tabs.values()) tab.view.setVisible(false) }
  const navigate = (tab: Tab, raw: string) => {
    const url = externalWebUrl(raw)
    if (!url) throw new Error("Only HTTP and HTTPS addresses are supported")
    tab.error = undefined
    void tab.view.webContents.loadURL(url).catch((error: unknown) => { if (tabs.has(tab.id)) tab.error = error instanceof Error ? error.message : String(error) })
  }
  const create = (workspaceId: string) => {
    if (tabs.size >= 8) throw new Error("Close a browser tab before opening another")
    const browserSession = session.fromPartition(`ih-browser-${window.id}-${workspaceId}`)
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    browserSession.setPermissionCheckHandler(() => false)
    const view = new WebContentsView({ webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: true } })
    const tab: Tab = { id: randomUUID(), workspaceId, view }
    tabs.set(tab.id, tab)
    view.setVisible(false)
    window.contentView.addChildView(view)
    view.webContents.setWindowOpenHandler(() => { tab.error = "Popup blocked"; return { action: "deny" } })
    const guard = (event: { preventDefault(): void }, url: string) => { if (!externalWebUrl(url)) { event.preventDefault(); tab.error = "Unsupported navigation blocked" } }
    view.webContents.on("will-navigate", guard)
    view.webContents.on("will-redirect", guard)
    view.webContents.on("did-fail-load", (_event, code, description, _url, mainFrame) => { if (mainFrame && code !== -3) tab.error = description })
    view.webContents.on("render-process-gone", () => { tab.error = "Browser renderer stopped; reload the tab" })
    const download = (event: { preventDefault(): void }, _item: unknown, contents: unknown) => { if (contents === view.webContents) { event.preventDefault(); tab.error = "Downloads are not enabled in this browser surface" } }
    browserSession.on("will-download", download)
    view.webContents.once("destroyed", () => browserSession.removeListener("will-download", download))
    return tab
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const tab of tabs.values()) { if (!window.isDestroyed()) window.contentView.removeChildView(tab.view); if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close() }
    tabs.clear(); active = undefined
  }
  window.on("resize", hide)
  window.on("closed", dispose)
  return {
    request(workspaceId: string, value: Record<string, unknown>) {
      if (disposed) throw new Error("Browser surface is closed")
      if (value.kind === "browser/list") return [...tabs.values()].filter((tab) => tab.workspaceId === workspaceId).map((tab) => ({ id: tab.id, url: tab.view.webContents.getURL(), title: tab.view.webContents.getTitle(), loading: tab.view.webContents.isLoading(), canGoBack: tab.view.webContents.navigationHistory.canGoBack(), canGoForward: tab.view.webContents.navigationHistory.canGoForward(), error: tab.error }))
      if (value.kind === "browser/open") { const tab = create(workspaceId); return { id: tab.id } }
      if (value.kind === "browser/hide") { if (active && tabs.get(active)?.workspaceId === workspaceId) { hide(); active = undefined }; return { ok: true } }
      if (typeof value.id !== "string") throw new Error("Browser tab id required")
      const tab = get(workspaceId, value.id)
      switch (value.kind) {
        case "browser/navigate": if (typeof value.url !== "string" || value.url.length > 8192) throw new Error("Invalid browser URL"); navigate(tab, value.url); break
        case "browser/action":
          if (value.action === "back") { if (tab.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack() }
          else if (value.action === "forward") { if (tab.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward() }
          else if (value.action === "reload") { tab.error = undefined; tab.view.webContents.reload() }
          else if (value.action === "stop") tab.view.webContents.stop()
          else throw new Error("Unknown browser action")
          break
        case "browser/show": {
          const rectangle = value.bounds as Rectangle | undefined
          if (!rectangle || ![rectangle.x, rectangle.y, rectangle.width, rectangle.height].every(Number.isFinite) || rectangle.width < 1 || rectangle.height < 1) throw new Error("Invalid browser bounds")
          const content = window.getContentBounds(); const zoom = window.webContents.getZoomFactor()
          const x = Math.max(0, Math.min(content.width - 1, Math.round(rectangle.x * zoom)))
          const y = Math.max(0, Math.min(content.height - 1, Math.round(rectangle.y * zoom)))
          hide(); tab.view.setBounds({ x, y, width: Math.max(1, Math.min(content.width - x, Math.round(rectangle.width * zoom))), height: Math.max(1, Math.min(content.height - y, Math.round(rectangle.height * zoom))) }); tab.view.setVisible(true); active = tab.id
          break
        }
        case "browser/close": window.contentView.removeChildView(tab.view); tab.view.webContents.close(); tabs.delete(tab.id); if (active === tab.id) active = undefined; break
        default: throw new Error("Unknown browser request")
      }
      return { ok: true }
    },
    dispose,
  }
}
