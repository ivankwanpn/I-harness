// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { DesktopBridge, DesktopEvent, DesktopRequest } from "../src/shared/bridge.ts"
import { useLocale } from "../src/renderer/design/i18n.ts"
import { TitleBar } from "../src/renderer/shell/TitleBar.tsx"

beforeEach(() => useLocale.getState().setLocale("zh-TW"))
afterEach(cleanup)

function deferred() {
  let resolve!: (value: unknown) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<unknown>((accept, fail) => { resolve = accept; reject = fail })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

function fixture(initial: Promise<unknown> = Promise.resolve({ maximized: false })) {
  const listeners = new Set<(event: DesktopEvent) => void>()
  const order: string[] = []
  let control: (request: Extract<DesktopRequest, { kind: "window/control" }>) => Promise<unknown> = async () => ({ maximized: false })
  const request = vi.fn((value: DesktopRequest) => {
    order.push(value.kind)
    if (value.kind === "window/state") return initial
    if (value.kind === "window/control") return control(value)
    throw new Error(`Unexpected title bar request: ${value.kind}`)
  })
  const bridge: DesktopBridge = {
    request,
    onEvent(listener) { order.push("subscribe"); listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return { bridge, request, listeners, order, setControl(value: typeof control) { control = value }, emit(event: DesktopEvent) { listeners.forEach(listener => listener(event)) } }
}

it("subscribes before reading actual initial state and renders the restore action and glyph", async () => {
  const f = fixture(Promise.resolve({ maximized: true }))
  render(<TitleBar bridge={f.bridge} />)
  const restore = await screen.findByRole("button", { name: "還原視窗" })
  expect(f.order).toEqual(["subscribe", "window/state"])
  expect(restore.getAttribute("data-maximized")).toBe("true")
  expect(restore.querySelector("svg")?.classList.contains("lucide-copy")).toBe(true)
})

it("updates the action and glyph when the native window is maximized and restored outside the title bar", async () => {
  const f = fixture()
  render(<TitleBar bridge={f.bridge} />)
  await screen.findByRole("button", { name: "最大化視窗" })
  act(() => f.emit({ kind: "window/state", maximized: true }))
  expect(screen.getByRole("button", { name: "還原視窗" }).getAttribute("data-maximized")).toBe("true")
  act(() => f.emit({ kind: "window/state", maximized: false }))
  const maximize = screen.getByRole("button", { name: "最大化視窗" })
  expect(maximize.getAttribute("data-maximized")).toBe("false")
  expect(maximize.querySelector("svg")?.classList.contains("lucide-square")).toBe(true)
})

it("uses actual replies from maximize clicks and title double clicks", async () => {
  const f = fixture()
  f.setControl(async () => ({ maximized: true }))
  render(<TitleBar bridge={f.bridge} title="Native window" />)
  fireEvent.click(await screen.findByRole("button", { name: "最大化視窗" }))
  await screen.findByRole("button", { name: "還原視窗" })
  expect(f.request).toHaveBeenLastCalledWith({ kind: "window/control", action: "toggle-maximize" })
  f.setControl(async () => ({ maximized: false }))
  fireEvent.doubleClick(screen.getByText("Native window"))
  await screen.findByRole("button", { name: "最大化視窗" })
  expect(f.request).toHaveBeenLastCalledWith({ kind: "window/control", action: "toggle-maximize" })
})

it("keeps a newer native event when the initial query returns late", async () => {
  const initial = deferred()
  const f = fixture(initial.promise)
  render(<TitleBar bridge={f.bridge} />)
  act(() => f.emit({ kind: "window/state", maximized: true }))
  await act(async () => initial.resolve({ maximized: false }))
  expect(screen.getByRole("button", { name: "還原視窗" })).toBeTruthy()
})

it("keeps an accepted control reply when the initial query returns late", async () => {
  const initial = deferred()
  const f = fixture(initial.promise)
  f.setControl(async () => ({ maximized: true }))
  render(<TitleBar bridge={f.bridge} />)
  fireEvent.click(screen.getByRole("button", { name: "最大化或還原視窗" }))
  await screen.findByRole("button", { name: "還原視窗" })
  await act(async () => initial.resolve({ maximized: false }))
  expect(screen.getByRole("button", { name: "還原視窗" })).toBeTruthy()
})

it("ignores a late control reply after newer native maximize and restore events", async () => {
  const pending = deferred()
  const f = fixture()
  f.setControl(() => pending.promise)
  render(<TitleBar bridge={f.bridge} />)
  fireEvent.click(await screen.findByRole("button", { name: "最大化視窗" }))
  act(() => { f.emit({ kind: "window/state", maximized: true }); f.emit({ kind: "window/state", maximized: false }) })
  await act(async () => pending.resolve({ maximized: true }))
  expect(screen.getByRole("button", { name: "最大化視窗" })).toBeTruthy()
})

it("retains unknown state and quietly supports a backend without the initial state query", async () => {
  const initial = deferred()
  const f = fixture(initial.promise)
  render(<TitleBar bridge={f.bridge} />)
  await act(async () => initial.reject(new Error("unknown Desktop request")))
  const toggle = screen.getByRole("button", { name: "最大化或還原視窗" })
  expect(toggle.hasAttribute("data-maximized")).toBe(false)
  expect(screen.queryByRole("alert")).toBeNull()
  f.setControl(async () => ({ maximized: true }))
  fireEvent.click(toggle)
  await screen.findByRole("button", { name: "還原視窗" })
})

it("accepts only boolean native state and ignores unrelated SDK events", async () => {
  const f = fixture(Promise.resolve({ maximized: "true" }))
  f.setControl(async () => ({ maximized: 1 }))
  render(<TitleBar bridge={f.bridge} />)
  await act(async () => {})
  fireEvent.click(screen.getByRole("button", { name: "最大化或還原視窗" }))
  await act(async () => {})
  act(() => {
    f.emit({ kind: "window/state", maximized: "false" } as unknown as DesktopEvent)
    f.emit({ kind: "sdk/notification", workspaceId: "w", method: "session/status", params: { maximized: true } })
  })
  expect(screen.getByRole("button", { name: "最大化或還原視窗" }).hasAttribute("data-maximized")).toBe(false)
  act(() => f.emit({ kind: "window/state", maximized: true }))
  expect(screen.getByRole("button", { name: "還原視窗" })).toBeTruthy()
})

it("shows a control failure, retains actual state and clears the error for the next operation", async () => {
  const f = fixture(Promise.resolve({ maximized: true }))
  f.setControl(async () => { throw new Error("Window control failed") })
  render(<TitleBar bridge={f.bridge} />)
  fireEvent.click(await screen.findByRole("button", { name: "還原視窗" }))
  expect((await screen.findByRole("alert")).textContent).toContain("Window control failed")
  expect(screen.getByRole("button", { name: "還原視窗" })).toBeTruthy()
  f.setControl(async () => ({ maximized: false }))
  fireEvent.click(screen.getByRole("button", { name: "還原視窗" }))
  await screen.findByRole("button", { name: "最大化視窗" })
  expect(screen.queryByRole("alert")).toBeNull()
})

it("unsubscribes on unmount and disposes pending initial and control replies", async () => {
  const initial = deferred()
  const control = deferred()
  const f = fixture(initial.promise)
  f.setControl(() => control.promise)
  const view = render(<TitleBar bridge={f.bridge} />)
  fireEvent.click(screen.getByRole("button", { name: "最大化或還原視窗" }))
  expect(f.listeners.size).toBe(1)
  view.unmount()
  expect(f.listeners.size).toBe(0)
  await act(async () => { initial.resolve({ maximized: true }); control.reject(new Error("Disposed control")) })
  expect(screen.queryByRole("alert")).toBeNull()
})

it("renders state-specific accessible labels in English", async () => {
  useLocale.getState().setLocale("en")
  const f = fixture()
  render(<TitleBar bridge={f.bridge} />)
  await screen.findByRole("button", { name: "Maximize window" })
  act(() => f.emit({ kind: "window/state", maximized: true }))
  expect(screen.getByRole("button", { name: "Restore window" }).title).toBe("Restore window")
})
