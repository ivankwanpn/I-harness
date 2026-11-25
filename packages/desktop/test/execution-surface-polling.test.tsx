// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { DesktopBridge, DesktopEvent } from "../src/shared/bridge.ts"
import { useExecutionSurface } from "../src/renderer/session/execution-surface.ts"
import { WindowVisibilityProvider } from "../src/renderer/window-visibility.tsx"
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })
it("does not let a read started before a mutation replace its authoritative result", async () => {
  let finishRead!: (value: unknown) => void, finishSave!: (value: unknown) => void
  const oldRead = new Promise(resolve => { finishRead = resolve })
  const save = new Promise(resolve => { finishSave = resolve })
  const read = vi.fn().mockResolvedValueOnce("original").mockImplementation(() => oldRead)
  function Fixture() {
    const view = useExecutionSurface<string>(read, "workspace")
    return <><p>{view.state}</p><button onClick={() => { void view.refresh() }}>Refresh</button><button onClick={() => { void view.act(() => save, value => view.replace(value as string), false) }}>Save</button></>
  }
  render(<Fixture />)
  await act(async () => {})
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  await act(async () => { finishSave("saved result"); await save })
  expect(screen.getByText("saved result")).toBeTruthy()
  await act(async () => { finishRead("obsolete read"); await oldRead })
  expect(screen.queryByText("obsolete read")).toBeNull()
  expect(screen.getByText("saved result")).toBeTruthy()
})
it("pauses hidden polling without invalidating a pending mutation or dropping its completion", async () => {
  vi.useFakeTimers()
  const read = vi.fn(async () => ({ ready: true })), saved = vi.fn()
  let finish!: (value: unknown) => void
  const mutation = new Promise(resolve => { finish = resolve })
  function Fixture({ active }: { active: boolean }) {
    const view = useExecutionSurface<{ ready: boolean }>(read, "workspace", true, active)
    return <button disabled={view.busy} onClick={() => { void view.act(() => mutation, saved, false) }}>Save</button>
  }
  const view = render(<Fixture active />)
  await act(async () => {})
  expect(read).toHaveBeenCalledTimes(1)
  await act(async () => { vi.advanceTimersByTime(1500) })
  expect(read).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  view.rerender(<Fixture active={false} />)
  await act(async () => { vi.advanceTimersByTime(6000) })
  expect(read).toHaveBeenCalledTimes(2)
  await act(async () => { finish({ saved: true }); await mutation })
  expect(saved).toHaveBeenCalledWith({ saved: true })
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false)
  await act(async () => { vi.advanceTimersByTime(6000) })
  expect(read).toHaveBeenCalledTimes(2)
  view.rerender(<Fixture active />)
  await act(async () => { vi.advanceTimersByTime(1500) })
  expect(read).toHaveBeenCalledTimes(3)
})

it("lets each slow automatic read settle before starting another poll", async () => {
  vi.useFakeTimers()
  const first = Promise.withResolvers<string>(), next = Promise.withResolvers<string>()
  const read = vi.fn<() => Promise<string>>().mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise).mockResolvedValue("latest")
  function Fixture() {
    const view = useExecutionSurface<string>(read, "workspace", true)
    return <p>{view.state}</p>
  }
  render(<Fixture />)
  await act(async () => { vi.advanceTimersByTime(4500) })
  expect(read).toHaveBeenCalledTimes(1)
  await act(async () => { first.resolve("initial"); await first.promise })
  expect(screen.getByText("initial")).toBeTruthy()

  await act(async () => { vi.advanceTimersByTime(4500) })
  expect(read).toHaveBeenCalledTimes(2)
  await act(async () => { next.resolve("updated"); await next.promise })
  expect(screen.getByText("updated")).toBeTruthy()
  await act(async () => { vi.advanceTimersByTime(1500) })
  expect(read).toHaveBeenCalledTimes(3)
  expect(screen.getByText("latest")).toBeTruthy()
})

it("suspends polling while the desktop document is hidden and resumes on visibility", async () => {
  vi.useFakeTimers()
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false)
  const read = vi.fn(async () => "ready")
  function Fixture() {
    const view = useExecutionSurface<string>(read, "workspace", true)
    return <button onClick={() => { void view.refresh() }}>Refresh</button>
  }
  render(<Fixture />)
  await act(async () => {})
  await act(async () => { vi.advanceTimersByTime(1500) })
  expect(read).toHaveBeenCalledTimes(2)
  await act(async () => {
    hidden.mockReturnValue(true)
    document.dispatchEvent(new Event("visibilitychange"))
    vi.advanceTimersByTime(6000)
  })
  expect(read).toHaveBeenCalledTimes(2)
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh" })) })
  expect(read).toHaveBeenCalledTimes(3)
  await act(async () => {
    hidden.mockReturnValue(false)
    document.dispatchEvent(new Event("visibilitychange"))
    vi.advanceTimersByTime(1500)
  })
  expect(read).toHaveBeenCalledTimes(4)
})

it("stops polling on native minimize even while Chromium reports the document visible", async () => {
  vi.useFakeTimers()
  vi.spyOn(document, "hidden", "get").mockReturnValue(false)
  const snapshot = Promise.withResolvers<{ maximized: boolean; visible: boolean }>()
  const read = vi.fn(async () => "ready")
  let emit!: (event: DesktopEvent) => void
  const unsubscribe = vi.fn()
  const bridge: DesktopBridge = {
    request: vi.fn(() => snapshot.promise),
    onEvent: listener => { emit = listener; return unsubscribe },
  }
  function Fixture() {
    useExecutionSurface<string>(read, "workspace", true)
    return null
  }
  const view = render(<WindowVisibilityProvider bridge={bridge}><Fixture /></WindowVisibilityProvider>)
  await act(async () => {})
  await act(async () => { vi.advanceTimersByTime(1500) })
  expect(bridge.request).toHaveBeenCalledWith({ kind: "window/state" })
  expect(read).toHaveBeenCalledTimes(2)

  act(() => emit({ kind: "window/state", maximized: false, visible: false }))
  await act(async () => { snapshot.resolve({ maximized: false, visible: true }) })
  await act(async () => { vi.advanceTimersByTime(4500) })
  expect(read).toHaveBeenCalledTimes(2)

  act(() => emit({ kind: "window/state", maximized: false, visible: true }))
  await act(async () => { vi.advanceTimersByTime(1500) })
  expect(read).toHaveBeenCalledTimes(3)
  view.unmount()
  expect(unsubscribe).toHaveBeenCalledOnce()
})
