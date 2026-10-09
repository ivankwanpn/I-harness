// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { useExecutionSurface } from "../src/renderer/session/execution-surface.ts"
afterEach(() => { cleanup(); vi.useRealTimers() })
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
