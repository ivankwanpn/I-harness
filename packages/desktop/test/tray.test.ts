import { afterEach, expect, it, vi } from "vitest"

const f = vi.hoisted(() => ({ templates: [] as Array<Array<{ label?: string; type?: string; click?: () => void }>>, trays: [] as Array<{ listeners: Map<string, () => void>; setContextMenu: ReturnType<typeof vi.fn>; setToolTip: ReturnType<typeof vi.fn> }>, bitmap: vi.fn() }))
vi.mock("electron", () => ({
  Menu: { buildFromTemplate: (template: Array<{ label?: string; type?: string; click?: () => void }>) => { f.templates.push(template); return template } },
  nativeImage: { createFromBitmap: (...args: unknown[]) => { f.bitmap(...args); return { isEmpty: () => false } } },
  Tray: class {
    listeners = new Map<string, () => void>()
    setContextMenu = vi.fn()
    setToolTip = vi.fn()
    on(name: string, handler: () => void) { this.listeners.set(name, handler) }
    constructor(_image: unknown) { f.trays.push(this) }
  },
}))
import { createDesktopTray } from "../src/main/tray.ts"

afterEach(() => { f.templates.length = 0; f.trays.length = 0; f.bitmap.mockClear() })

it("provides only Show and Exit with a nonempty local icon", () => {
  const show = vi.fn(); const quit = vi.fn()
  const tray = createDesktopTray({ show, quit, locale: () => "zh-TW" })
  expect(tray).toBeDefined()
  expect(f.templates[0]?.filter((item) => item.type !== "separator").map((item) => item.label)).toEqual(["顯示工作台", "退出"])
  f.templates[0]![0]!.click?.()
  f.templates[0]![2]!.click?.()
  expect(show).toHaveBeenCalledOnce()
  expect(quit).toHaveBeenCalledOnce()
  expect(f.bitmap.mock.calls[0]?.[0]).toHaveLength(16 * 16 * 4)
  expect(f.bitmap.mock.calls[0]?.[1]).toEqual({ width: 16, height: 16, scaleFactor: 1 })
})

it("rebuilds localized labels when the user opens the tray menu", () => {
  let locale: "zh-TW" | "en" = "zh-TW"
  createDesktopTray({ show: vi.fn(), quit: vi.fn(), locale: () => locale })
  locale = "en"
  f.trays[0]!.listeners.get("right-click")?.()
  expect(f.templates.at(-1)?.filter((item) => item.type !== "separator").map((item) => item.label)).toEqual(["Show workbench", "Exit"])
})
