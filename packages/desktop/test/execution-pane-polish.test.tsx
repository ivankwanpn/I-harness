// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { DesktopExecutionView, ExecutionRequest } from "@i-harness/desktop-gateway/src/execution.ts"
import { ExecutionPane } from "../src/renderer/session/ExecutionPane.tsx"

afterEach(() => { cleanup(); vi.useRealTimers() })
const cell = { id: "owned-cell", ownerSessionId: "s", status: "running", source: "text('owned')", live: true, canTerminate: true, truncated: false, output: [{ kind: "text", text: "captured output" }], calls: [{ id: "nested", name: "read", args: '{"path":"owned.txt"}', output: "captured nested result", dispatched: true }] }
const base: DesktopExecutionView = { sessionId: "s", live: true, effectiveMode: "mixed", cells: [cell], total: 1, offset: 0, hasMore: false }

it("bounds projected source and output, preserves their full copy and keeps technical identity in disclosure", async () => {
  const source = "s".repeat(60000), output = "o".repeat(60000), writes: string[] = []
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { writes.push(value) } } })
  const request = async () => ({ ...base, cells: [{ ...cell, source, output: [{ kind: "text", text: output }] }] })
  const view = render(<ExecutionPane bridge={{ request }} workspaceId="w" sessionId="s" />)
  await screen.findByRole("button", { name: "複製 JavaScript 原始碼" })
  expect(view.container.textContent!.length).toBeLessThan(7000)
  expect(screen.queryByText("s")).toBeNull()
  expect(view.container.textContent).not.toContain("owner:")
  fireEvent.click(screen.getByRole("button", { name: "複製 JavaScript 原始碼" }))
  await waitFor(() => expect(writes).toEqual([source]))
  fireEvent.click(screen.getByRole("tab", { name: "輸出" }))
  expect(view.container.textContent!.length).toBeLessThan(7000)
  fireEvent.click(screen.getByRole("button", { name: "複製 執行輸出" }))
  await waitFor(() => expect(writes).toEqual([source, output]))
})

it("shows projected media as escaped recorded text and nests the complete call arguments", async () => {
  const args = '{"argument":"' + "x".repeat(60000) + '"}'
  const request = async () => ({ ...base, cells: [{ ...cell, output: [{ kind: "image", text: '{"image":"[media omitted]"}' }], calls: [{ ...cell.calls[0]!, args }] }] })
  const view = render(<ExecutionPane bridge={{ request }} workspaceId="w" sessionId="s" />)
  await screen.findByText("text('owned')")
  fireEvent.click(screen.getByRole("tab", { name: "輸出" }))
  expect(screen.getByText('{"image":"[media omitted]"}')).toBeTruthy()
  expect(view.container.querySelector("img")).toBeNull()
  fireEvent.click(screen.getByRole("tab", { name: "巢狀呼叫" }))
  expect(screen.getByText("captured nested result")).toBeTruthy()
  expect(screen.queryByText(/"argument"/)).toBeNull()
  fireEvent.click(screen.getByText("呼叫參數"))
  expect(view.container.textContent!.length).toBeLessThan(7000)
  expect(screen.getByRole("region", { name: "呼叫參數" }).querySelector("pre")!.textContent).toContain('"argument"')
})

it("keeps a cell stop confirmation open and rechecks termination eligibility after polling", async () => {
  vi.useFakeTimers()
  let current = base
  const stops: unknown[] = []
  const request = async (input: ExecutionRequest) => { if (input.kind === "desktop/session/execution/stop") { stops.push(input); return { stopped: true } } return current }
  await act(async () => { render(<ExecutionPane bridge={{ request }} workspaceId="w" sessionId="s" />) })
  const trigger = screen.getByRole("button", { name: "停止 cell" }); trigger.focus(); fireEvent.click(trigger)
  const dialog = screen.getByRole("dialog", { name: "確認停止 cell" })
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "返回" }))
  current = { ...base, cells: [{ ...cell, canTerminate: false }] }
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
  expect(within(dialog).getByRole("button", { name: "確認停止" }).hasAttribute("disabled")).toBe(true)
  expect(within(dialog).getByRole("status").textContent).toContain("執行狀態或控制權已變更")
  fireEvent.submit(dialog.querySelector("form")!)
  expect(stops).toEqual([])
  current = base
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
  await act(async () => { fireEvent.submit(dialog.querySelector("form")!) })
  expect(stops).toEqual([{ kind: "desktop/session/execution/stop", workspaceId: "w", sessionId: "s", cellId: "owned-cell" }])
})

it("requires current view, cell owner and live control evidence before offering stop", async () => {
  const request = async () => ({ ...base, cells: [{ ...cell, ownerSessionId: "other", canTerminate: true }, { ...cell, id: "historical", live: false, canTerminate: true }] })
  render(<ExecutionPane bridge={{ request }} workspaceId="w" sessionId="s" />)
  await screen.findAllByText("text('owned')")
  expect(screen.queryByRole("button", { name: "停止 cell" })).toBeNull()
})

it("keeps a submitted stop busy and honors composing Escape before cancellation", async () => {
  let finish: (value: unknown) => void = () => {}
  const request = (input: ExecutionRequest) => input.kind === "desktop/session/execution/stop" ? new Promise(resolve => { finish = resolve }) : Promise.resolve(base)
  render(<ExecutionPane bridge={{ request }} workspaceId="w" sessionId="s" />)
  fireEvent.click(await screen.findByRole("button", { name: "停止 cell" }))
  const dialog = screen.getByRole("dialog", { name: "確認停止 cell" }), back = within(dialog).getByRole("button", { name: "返回" })
  fireEvent.compositionStart(back); fireEvent.keyDown(back, { key: "Escape" })
  expect(screen.getByRole("dialog")).toBeTruthy()
  fireEvent.compositionEnd(back); fireEvent.keyUp(back, { key: "Escape" })
  fireEvent.submit(dialog.querySelector("form")!)
  expect(dialog.getAttribute("aria-busy")).toBe("true")
  expect(back.hasAttribute("disabled")).toBe(true)
  fireEvent.keyDown(dialog, { key: "Escape" })
  expect(screen.getByRole("dialog")).toBeTruthy()
  finish({ stopped: true })
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  expect(screen.queryByText("已停止")).toBeNull()
})
