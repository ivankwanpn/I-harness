// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { DesktopBridge, DesktopRequest } from "../src/shared/bridge.ts"
import type { ITerminalOptions } from "@xterm/xterm"
const f = vi.hoisted(() => ({ instances: [] as { options: ITerminalOptions; writes: string[]; dispose: () => void; reset: () => void }[], disposed: vi.fn(), reset: vi.fn(), fit: vi.fn(), input: (_value: string) => {} }))
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  cols = 80; rows = 24; writes: string[] = []
  constructor(public options: ITerminalOptions) { f.instances.push(this) }
  loadAddon() {} open() {} focus() {}
  write(data: string, done: () => void) { this.writes.push(data); done() }
  onData(handler: (value: string) => void) { f.input = handler; return { dispose() {} } }
  dispose() { f.disposed() } reset() { f.reset() }
} }))
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() { f.fit() } } }))
import { TerminalPane } from "../src/renderer/terminal/TerminalPane.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"

beforeEach(() => {
  vi.useFakeTimers()
  useUiStore.setState({ appearance: "dark", fontSize: 14, locale: "zh-TW" })
  document.documentElement.dataset.theme = "dark"
  document.documentElement.style.setProperty("--ih-bg", "#151515")
  document.documentElement.style.setProperty("--ih-text", "#ececec")
  document.documentElement.style.setProperty("--ih-accent", "#b8c9ed")
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300)
  Object.defineProperty(document, "hidden", { configurable: true, value: false })
})
afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); f.instances.length = 0
  document.documentElement.removeAttribute("style"); document.documentElement.removeAttribute("data-theme")
})
async function tick(duration = 20) { await act(async () => { await vi.advanceTimersByTimeAsync(duration) }) }
function fixture() {
  let fontFamily = "Cascadia Code, monospace"
  let output = { data: "READY", nextOffset: 5, truncated: false, status: "running" } as { data: string; nextOffset: number; truncated: boolean; status: "running" | "exited"; exitCode?: number }
  const request = vi.fn(async (value: DesktopRequest) => {
    if (value.kind === "desktop/local/state") return { terminalFontFamily: fontFamily }
    if (value.kind === "desktop/terminal/list") return [{ id: "t", status: "running", command: "bash" }]
    if (value.kind === "desktop/terminal/read") return { ...output }
    return { ok: true }
  })
  const bridge: DesktopBridge = { request, onEvent: () => () => {} }
  return { bridge, request, setFont(value: string) { fontFamily = value }, setOutput(value: typeof output) { output = value } }
}

it("starts the emulator with the actual IH theme tokens, UI font size and saved terminal font", async () => {
  useUiStore.setState({ appearance: "light", fontSize: 18 })
  document.documentElement.dataset.theme = "light"
  document.documentElement.style.setProperty("--ih-bg", "#f8f8f8")
  document.documentElement.style.setProperty("--ih-text", "#252525")
  const value = fixture()
  render(<TerminalPane bridge={value.bridge} workspaceId="w" />)
  await tick()
  expect(f.instances).toHaveLength(1)
  expect(f.instances[0].options).toMatchObject({ fontFamily: "Cascadia Code, monospace", fontSize: 18, theme: { background: "#f8f8f8", foreground: "#252525" } })
})
it("refreshes the saved font on returning to a retained pane without recreating its emulator", async () => {
  const value = fixture()
  const view = render(<TerminalPane bridge={value.bridge} workspaceId="w" active />)
  await tick()
  view.rerender(<TerminalPane bridge={value.bridge} workspaceId="w" active={false} />)
  value.setFont("Updated font, monospace")
  view.rerender(<TerminalPane bridge={value.bridge} workspaceId="w" active />)
  await tick()
  expect(f.instances).toHaveLength(1)
  expect(f.disposed).not.toHaveBeenCalled()
  expect(f.instances[0].options.fontFamily).toBe("Updated font, monospace")
})

it("updates theme and font size in place while preserving output offset, scrollback and input", async () => {
  const value = fixture()
  render(<TerminalPane bridge={value.bridge} workspaceId="w" />)
  await tick()
  const emulator = f.instances[0]
  const previousFits = f.fit.mock.calls.length
  act(() => {
    useUiStore.getState().update({ appearance: "light", fontSize: 18 })
    document.documentElement.dataset.theme = "light"
    document.documentElement.style.setProperty("--ih-bg", "#f8f8f8")
    document.documentElement.style.setProperty("--ih-text", "#252525")
  })
  await tick()
  expect(emulator.options).toMatchObject({ fontSize: 18, theme: { background: "#f8f8f8", foreground: "#252525" } })
  expect(f.fit.mock.calls.length).toBeGreaterThan(previousFits)
  value.setOutput({ data: "NEXT", nextOffset: 9, truncated: false, status: "exited", exitCode: 3 })
  await tick(120)
  expect(value.request.mock.calls.filter(([request]) => request.kind === "desktop/terminal/read").map(([request]) => request.kind === "desktop/terminal/read" ? request.offset : undefined)).toEqual([0, 5])
  expect(emulator.writes).toEqual(["READY", "NEXT"])
  f.input("echo intact\r")
  await tick()
  expect(value.request).toHaveBeenCalledWith({ kind: "desktop/terminal/write", workspaceId: "w", id: "t", data: "echo intact\r" })
  expect(f.instances).toHaveLength(1)
  expect(f.disposed).not.toHaveBeenCalled()
  expect(f.reset).not.toHaveBeenCalled()
})

it("applies an updated native font after focus without rebuilding or resetting the emulator", async () => {
  const value = fixture()
  render(<TerminalPane bridge={value.bridge} workspaceId="w" />)
  await tick()
  value.setFont("Consolas, monospace")
  act(() => window.dispatchEvent(new Event("focus")))
  await tick()
  expect(f.instances[0].options.fontFamily).toBe("Consolas, monospace")
  expect(f.instances).toHaveLength(1)
  expect(f.disposed).not.toHaveBeenCalled()
  expect(f.reset).not.toHaveBeenCalled()
})

it("changes translated status without disposing the emulator or rereading consumed output", async () => {
  const value = fixture()
  value.setOutput({ data: "DONE", nextOffset: 4, truncated: false, status: "exited", exitCode: 7 })
  render(<TerminalPane bridge={value.bridge} workspaceId="w" />)
  await tick()
  expect(screen.getByRole("status").textContent).toContain("代碼 7")
  act(() => useUiStore.getState().setLocale("en"))
  await tick()
  expect(screen.getByRole("status").textContent).toContain("code 7")
  expect(value.request.mock.calls.filter(([request]) => request.kind === "desktop/terminal/read")).toHaveLength(1)
  expect(f.instances).toHaveLength(1)
  expect(f.disposed).not.toHaveBeenCalled()
})

it("reports terminal exit without inventing a zero exit code when the backend omits it", async () => {
  const value = fixture()
  value.setOutput({ data: "DONE", nextOffset: 4, truncated: false, status: "exited" })
  render(<TerminalPane bridge={value.bridge} workspaceId="w" />)
  await tick()
  expect(screen.getByRole("status").textContent).toBe("終端已結束；未回報結束代碼。")
  expect(screen.getByRole("status").textContent).not.toContain("0")
})
