import { expect, it, vi } from "vitest"
import type { BrowserWindow } from "electron"
const f = vi.hoisted(() => ({ options: [] as unknown[], views: [] as any[], permission: vi.fn(), check: vi.fn() }))
vi.mock("electron", () => ({
  session: { fromPartition: () => ({ setPermissionRequestHandler: f.permission, setPermissionCheckHandler: f.check, on: vi.fn(), removeListener: vi.fn() }) },
  WebContentsView: class {
    setVisible = vi.fn(); setBounds = vi.fn()
    webContents = { isDestroyed: () => false, loadURL: vi.fn().mockResolvedValue(undefined), setWindowOpenHandler: vi.fn(), on: vi.fn(), once: vi.fn(), close: vi.fn(), getURL: () => "", getTitle: () => "", isLoading: () => false, navigationHistory: { canGoBack: () => false, canGoForward: () => false } }
    constructor(options: unknown) { f.options.push(options); f.views.push(this) }
  },
}))
import { createBrowserSurface } from "../src/main/browser-surface.ts"
it("isolates web guests, validates workspace and URLs, and disposes all views", () => {
  const window = { id: 1, on: vi.fn(), isDestroyed: () => false, contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }, getContentBounds: () => ({ width: 800, height: 600 }), webContents: { getZoomFactor: () => 1 } } as unknown as BrowserWindow
  const browser = createBrowserSurface(window)
  const result = browser.request("w", { kind: "browser/open" }) as { id: string }
  expect(f.options[0]).toMatchObject({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  expect((f.options[0] as any).webPreferences.preload).toBeUndefined()
  expect(() => browser.request("other", { kind: "browser/navigate", id: result.id, url: "https://example.com" })).toThrow()
  expect(() => browser.request("w", { kind: "browser/navigate", id: result.id, url: "file:///private" })).toThrow()
  browser.request("w", { kind: "browser/navigate", id: result.id, url: "https://example.com" })
  expect(f.views[0].webContents.loadURL).toHaveBeenCalledWith("https://example.com/")
  browser.request("w", { kind: "browser/show", id: result.id, bounds: { x: 700, y: 500, width: 200, height: 200 } })
  expect(f.views[0].setBounds).toHaveBeenCalledWith({ x: 700, y: 500, width: 100, height: 100 })
  browser.request("w", { kind: "browser/hide" })
  expect(f.views[0].setVisible).toHaveBeenLastCalledWith(false)
  browser.dispose()
  expect(f.views[0].webContents.close).toHaveBeenCalledOnce()
})

it("retains browser tabs when a close is cancelled and releases them after destruction", () => {
  const handlers = new Map<string, () => void>()
  const window = { id: 2, on: (name: string, handler: () => void) => { handlers.set(name, handler) }, isDestroyed: () => false,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }, getContentBounds: () => ({ width: 800, height: 600 }), webContents: { getZoomFactor: () => 1 } } as unknown as BrowserWindow
  const browser = createBrowserSurface(window)
  browser.request("w", { kind: "browser/open" })
  const view = f.views.at(-1)
  handlers.get("close")?.()
  expect(view.webContents.close).not.toHaveBeenCalled()
  handlers.get("closed")?.()
  expect(view.webContents.close).toHaveBeenCalledOnce()
})
