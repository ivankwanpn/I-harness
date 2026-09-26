// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { BrowserPane } from "../src/renderer/browser/BrowserPane.tsx"
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
it("navigates only on submit and hides the native view when unmounted", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 20, y: 100, width: 400, height: 400 } as DOMRect)
  let opened = false
  const request = vi.fn(async (value) => {
    if (value.kind === "browser/open") { opened = true; return { id: "t" } }
    if (value.kind === "browser/list") return opened ? [{ id: "t", url: "", title: "", loading: false, canGoBack: false, canGoForward: false }] : []
    return { ok: true }
  })
  const view = render(<BrowserPane bridge={{ request, onEvent: () => () => {} }} workspaceId="w" />)
  fireEvent.click(screen.getByRole("button", { name: "新增分頁" }))
  await screen.findByRole("tab", { name: "新分頁" })
  expect(request.mock.calls.some(([value]) => value.kind === "browser/navigate")).toBe(false)
  fireEvent.change(screen.getByLabelText("網址"), { target: { value: "https://example.com/" } })
  fireEvent.click(screen.getByRole("button", { name: "前往" }))
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "browser/navigate", workspaceId: "w", id: "t", url: "https://example.com/" }))
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "browser/show", workspaceId: "w", id: "t", bounds: { x: 20, y: 100, width: 400, height: 400 } }))
  view.unmount()
  expect(request).toHaveBeenLastCalledWith({ kind: "browser/hide", workspaceId: "w" })
})
