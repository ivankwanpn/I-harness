// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { DesktopBridge, DesktopRequest } from "../src/shared/bridge.ts"
import { BrowserPane } from "../src/renderer/browser/BrowserPane.tsx"
import { SettingsDialog } from "../src/renderer/settings/SettingsDialog.tsx"
import { useLocale } from "../src/renderer/design/i18n.ts"

let bounds = { x: 20, y: 100, width: 400, height: 300 }
beforeEach(() => {
  vi.useFakeTimers()
  useLocale.getState().setLocale("zh-TW")
  bounds = { x: 20, y: 100, width: 400, height: 300 }
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => bounds as DOMRect)
  Object.defineProperty(document, "hidden", { configurable: true, value: false })
})
afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function deferred() {
  let resolve!: (value: unknown) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<unknown>((accept, fail) => { resolve = accept; reject = fail })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}
function tab(id: string) { return { id, url: `https://${id}.example/`, title: id, loading: false, canGoBack: false, canGoForward: false } }
function fixture() {
  let respond: (request: DesktopRequest) => Promise<unknown> = async value => value.kind === "browser/list" ? [tab("first"), tab("second")] : { ok: true }
  const request = vi.fn((value: DesktopRequest) => respond(value))
  const bridge: DesktopBridge = { request, onEvent: () => () => {} }
  return { bridge, request, setResponse(value: typeof respond) { respond = value }, nativeRequests() { return request.mock.calls.map(([value]) => value).filter(value => value.kind === "browser/show" || value.kind === "browser/hide") } }
}
async function tick(duration = 20) {
  await act(async () => {})
  await act(async () => { await vi.advanceTimersByTimeAsync(duration) })
}
function legacyOverlay(role: "dialog" | "alertdialog" | "menu") {
  const overlay = document.createElement("div")
  overlay.setAttribute("role", role)
  overlay.setAttribute("aria-label", `Legacy ${role}`)
  act(() => document.body.append(overlay))
  return overlay
}

it("distinguishes a pending initial tab list from a confirmed empty browser", async () => {
  const pending = deferred()
  const f = fixture()
  f.setResponse(async value => value.kind === "browser/list" ? pending.promise : { ok: true })
  render(<BrowserPane bridge={f.bridge} workspaceId="w" />)
  expect(screen.getByRole("status").textContent).toContain("正在載入瀏覽器分頁")
  expect(screen.queryByText("新增分頁並輸入網址以開始瀏覽。")).toBeNull()
  await act(async () => pending.resolve([]))
  expect(screen.queryByRole("status")).toBeNull()
  expect(screen.getByText("新增分頁並輸入網址以開始瀏覽。")).toBeTruthy()
})
it("restores the last selected tab when returning to a workspace or remounting its pane", async () => {
  const f = fixture()
  const first = { ...tab("first"), title: "First" }, second = { ...tab("second"), title: "Second" }
  f.setResponse(async value => value.kind === "browser/list" ? value.workspaceId === "a" ? [first, second] : [{ ...tab("other"), title: "Other" }] : { ok: true })
  const view = render(<BrowserPane bridge={f.bridge} workspaceId="a" />)
  await tick()
  fireEvent.click(screen.getByRole("tab", { name: "Second" }))
  view.rerender(<BrowserPane bridge={f.bridge} workspaceId="b" />); await tick()
  view.rerender(<BrowserPane bridge={f.bridge} workspaceId="a" />); await tick()
  expect(screen.getByRole("tab", { name: "Second" }).getAttribute("aria-selected")).toBe("true")
  view.unmount()
  render(<BrowserPane bridge={f.bridge} workspaceId="a" />); await tick()
  expect(screen.getByRole("tab", { name: "Second" }).getAttribute("aria-selected")).toBe("true")
})

it("clears a recovered list failure after a successful poll without showing a false empty state", async () => {
  const f = fixture()
  let reads = 0
  f.setResponse(async value => {
    if (value.kind !== "browser/list") return { ok: true }
    if (++reads === 1) throw new Error("Browser list failed")
    return [tab("recovered")]
  })
  render(<BrowserPane bridge={f.bridge} workspaceId="w" />)
  await tick()
  expect(screen.getByRole("alert").textContent).toContain("Browser list failed")
  expect(screen.queryByText("新增分頁並輸入網址以開始瀏覽。")).toBeNull()
  await tick(500)
  expect(screen.getByRole("tab", { name: "recovered" })).toBeTruthy()
  expect(screen.queryByRole("alert")).toBeNull()
})

it.each(["dialog", "alertdialog", "menu"] as const)("hides the native view while an unregistered visible %s owns foreground UI and restores current bounds", async role => {
  const f = fixture()
  render(<BrowserPane bridge={f.bridge} workspaceId="w" />)
  await tick()
  expect(f.nativeRequests().at(-1)?.kind).toBe("browser/show")
  const overlay = legacyOverlay(role)
  await tick()
  expect(f.nativeRequests().at(-1)).toEqual({ kind: "browser/hide", workspaceId: "w" })
  bounds = { x: 30, y: 110, width: 250, height: 280 }
  act(() => overlay.remove())
  await tick()
  expect(f.nativeRequests().at(-1)).toEqual({ kind: "browser/show", workspaceId: "w", id: "first", bounds })
})

it("keeps the browser hidden until both a shared modal and a nested legacy menu close", async () => {
  const f = fixture()
  const view = render(<BrowserPane bridge={f.bridge} workspaceId="w" />)
  await tick()
  view.rerender(<><BrowserPane bridge={f.bridge} workspaceId="w" /><SettingsDialog title="Foreground tools" closeLabel="Close tools" initialFocusSelector="button" onClose={() => {}}><button>Action</button></SettingsDialog></>)
  await tick()
  const menu = legacyOverlay("menu")
  await tick()
  view.rerender(<BrowserPane bridge={f.bridge} workspaceId="w" />)
  await tick()
  expect(f.nativeRequests().at(-1)?.kind).toBe("browser/hide")
  act(() => menu.remove())
  await tick()
  expect(f.nativeRequests().at(-1)?.kind).toBe("browser/show")
})

it("ignores hidden overlays and responds when a retained dialog becomes visible", async () => {
  const f = fixture()
  const overlay = legacyOverlay("dialog")
  overlay.style.display = "none"
  render(<BrowserPane bridge={f.bridge} workspaceId="w" />)
  await tick()
  expect(f.nativeRequests().at(-1)?.kind).toBe("browser/show")
  act(() => { overlay.style.display = "block" })
  await tick()
  expect(f.nativeRequests().at(-1)?.kind).toBe("browser/hide")
  act(() => { overlay.setAttribute("aria-hidden", "true") })
  await tick()
  expect(f.nativeRequests().at(-1)?.kind).toBe("browser/show")
})

it("honors drawer visibility and restores the selected tab after hidden tab changes", async () => {
  const f = fixture()
  const view = render(<BrowserPane bridge={f.bridge} workspaceId="w" />)
  await tick()
  view.rerender(<BrowserPane bridge={f.bridge} workspaceId="w" visible={false} />)
  await tick()
  expect(f.nativeRequests().at(-1)?.kind).toBe("browser/hide")
  fireEvent.click(screen.getByRole("tab", { name: "second" }))
  await tick()
  expect(f.nativeRequests().at(-1)?.kind).toBe("browser/hide")
  view.rerender(<BrowserPane bridge={f.bridge} workspaceId="w" visible />)
  await tick()
  expect(f.nativeRequests().at(-1)).toEqual({ kind: "browser/show", workspaceId: "w", id: "second", bounds })
})

it("corrects a late show receipt after a foreground dialog has hidden the browser", async () => {
  const pending = deferred()
  const f = fixture()
  let nativeTab: string | undefined
  let pendingShow = true
  f.setResponse(async value => {
    if (value.kind === "browser/list") return [tab("first")]
    if (value.kind === "browser/show") {
      if (pendingShow) { pendingShow = false; await pending.promise }
      nativeTab = value.id
    }
    if (value.kind === "browser/hide") nativeTab = undefined
    return { ok: true }
  })
  render(<BrowserPane bridge={f.bridge} workspaceId="w" />)
  await tick()
  legacyOverlay("dialog")
  await tick()
  await act(async () => pending.resolve({ ok: true }))
  await tick()
  expect(nativeTab).toBeUndefined()
  expect(f.nativeRequests().at(-1)?.kind).toBe("browser/hide")
})

it("preserves the current workspace owner after an old scope's show receipt completes", async () => {
  const pending = deferred()
  const f = fixture()
  let nativeTab: string | undefined
  f.setResponse(async value => {
    if (value.kind === "browser/list") return [tab(value.workspaceId)]
    if (value.kind === "browser/show") {
      if (value.workspaceId === "old") await pending.promise
      nativeTab = value.id
    }
    if (value.kind === "browser/hide" && nativeTab === value.workspaceId) nativeTab = undefined
    return { ok: true }
  })
  const view = render(<BrowserPane bridge={f.bridge} workspaceId="old" />)
  await tick()
  view.rerender(<BrowserPane bridge={f.bridge} workspaceId="new" />)
  await tick()
  expect(nativeTab).toBe("new")
  await act(async () => pending.resolve({ ok: true }))
  await tick()
  expect(nativeTab).toBe("new")
  expect(f.nativeRequests().at(-1)).toEqual({ kind: "browser/show", workspaceId: "new", id: "new", bounds })
})

it("drops an old workspace operation result before its list read and releases the new workspace controls", async () => {
  const pending = deferred()
  const f = fixture()
  f.setResponse(async value => {
    if (value.kind === "browser/list") return value.workspaceId === "old" ? [] : [tab("new")]
    if (value.kind === "browser/open") return pending.promise
    return { ok: true }
  })
  const view = render(<BrowserPane bridge={f.bridge} workspaceId="old" />)
  await tick()
  fireEvent.click(screen.getByRole("button", { name: "新增分頁" }))
  view.rerender(<BrowserPane bridge={f.bridge} workspaceId="new" />)
  await tick()
  await act(async () => pending.resolve({ id: "old-tab" }))
  await tick()
  expect(screen.getByRole("tab", { name: "new" }).getAttribute("aria-selected")).toBe("true")
  expect((screen.getByRole("button", { name: "新增分頁" }) as HTMLButtonElement).disabled).toBe(false)
  expect(f.request.mock.calls.filter(([value]) => value.kind === "browser/list" && value.workspaceId === "old")).toHaveLength(1)
})

it("disposes polling and prevents a pending operation or show from reviving an unmounted viewport", async () => {
  const pendingShow = deferred()
  const pendingOpen = deferred()
  const f = fixture()
  let nativeVisible = false
  f.setResponse(async value => {
    if (value.kind === "browser/list") return [tab("first")]
    if (value.kind === "browser/open") return pendingOpen.promise
    if (value.kind === "browser/show") { await pendingShow.promise; nativeVisible = true }
    if (value.kind === "browser/hide") nativeVisible = false
    return { ok: true }
  })
  const view = render(<BrowserPane bridge={f.bridge} workspaceId="w" />)
  await tick()
  fireEvent.click(screen.getByRole("button", { name: "新增分頁" }))
  view.unmount()
  await act(async () => { pendingOpen.resolve({ id: "new" }); pendingShow.resolve({ ok: true }) })
  await tick(1000)
  expect(nativeVisible).toBe(false)
  expect(f.nativeRequests().at(-1)).toEqual({ kind: "browser/hide", workspaceId: "w" })
  expect(f.request.mock.calls.filter(([value]) => value.kind === "browser/list")).toHaveLength(1)
})
