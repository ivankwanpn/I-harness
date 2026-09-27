// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
const mock = vi.hoisted(() => ({ dispose: vi.fn(), write: vi.fn(), input: (_value: string) => {} }))
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  cols = 80; rows = 24
  loadAddon() {} open() {} focus() {} reset() {}
  write(data: string, done: () => void) { mock.write(data); done() }
  onData(handler: (value: string) => void) { mock.input = handler; return { dispose() {} } }
  dispose() { mock.dispose() }
} }))
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }))
import { TerminalPane } from "../src/renderer/terminal/TerminalPane.tsx"
import { useLocale } from "../src/renderer/design/i18n.ts"
beforeEach(() => useLocale.getState().setLocale("zh-TW"))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })
it("opens only on user action, routes input, and keeps the PTY alive across UI unmount", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} })
  let opened = false
  const request = vi.fn(async (value) => {
    if (value.kind === "desktop/terminal/list") return opened ? [{ id: "t", status: "running", command: "C:\\Program Files\\Git\\bin\\bash.exe" }] : []
    if (value.kind === "desktop/terminal/open") { opened = true; return { id: "t" } }
    if (value.kind === "desktop/terminal/read") return { data: "READY", nextOffset: 5, truncated: false, status: "exited", exitCode: 0 }
    return { ok: true }
  })
  const view = render(<TerminalPane bridge={{ request, onEvent: () => () => {} }} workspaceId="w" />)
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole("button", { name: "新增終端" }))
  await screen.findByRole("option", { name: "bash.exe · t" })
  await waitFor(() => expect(mock.write).toHaveBeenCalledWith("READY"))
  mock.input("echo hi\r")
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "desktop/terminal/write", workspaceId: "w", id: "t", data: "echo hi\r" }))
  view.unmount()
  expect(mock.dispose).toHaveBeenCalled()
  expect(request.mock.calls.some(([value]) => value.kind === "desktop/terminal/close")).toBe(false)
})
