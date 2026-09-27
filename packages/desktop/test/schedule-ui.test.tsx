// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { SchedulePane } from "../src/renderer/session/SchedulePane.tsx"

afterEach(cleanup)

it("shows the next-step limitation and creates a repeating reminder from minutes", async () => {
  const request = vi.fn(async (value: { kind: string }) => value.kind === "desktop/schedule/list" ? { schedules: [] } : { id: "schedule-1", kind: "every", scheduledAt: "2099-01-01T00:00:00.000Z" })
  render(<SchedulePane bridge={{ request, onEvent: () => () => {} }} workspaceId="w" sessionId="s" canCreate />)
  expect(screen.getByText(/下一個 Agent 步驟/)).toBeTruthy()
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "desktop/schedule/list", workspaceId: "w", sessionId: "s" }))
  fireEvent.change(screen.getByRole("combobox", { name: "提醒方式" }), { target: { value: "every" } })
  fireEvent.change(screen.getByRole("spinbutton", { name: "間隔分鐘" }), { target: { value: "5" } })
  fireEvent.change(screen.getByRole("textbox", { name: "提醒內容" }), { target: { value: "整理進度" } })
  fireEvent.click(screen.getByRole("button", { name: "建立提醒" }))
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "desktop/schedule/create", workspaceId: "w", sessionId: "s", command: { prompt: "整理進度", every_seconds: 300 } }))
})

it("lists and deletes the selected session's reminder with confirmation", async () => {
  let removed = false
  const request = vi.fn(async (value: { kind: string }) => {
    if (value.kind === "desktop/schedule/list") return { schedules: removed ? [] : [{ id: "schedule-1", kind: "after", prompt: "檢查報告", afterSeconds: 600, scheduledAt: "2099-01-01T00:00:00.000Z", state: "scheduled", deliveryMode: "session-local" }] }
    if (value.kind === "desktop/schedule/delete") { removed = true; return { deleted: "schedule-1" } }
    return {}
  })
  render(<SchedulePane bridge={{ request, onEvent: () => () => {} }} workspaceId="w" sessionId="s" canCreate />)
  await screen.findByText("檢查報告")
  fireEvent.click(screen.getByRole("button", { name: "刪除提醒" }))
  expect(request.mock.calls.some(([value]) => value.kind === "desktop/schedule/delete")).toBe(false)
  fireEvent.click(screen.getByRole("button", { name: "確認刪除提醒" }))
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "desktop/schedule/delete", workspaceId: "w", sessionId: "s", id: "schedule-1" }))
  await waitFor(() => expect(screen.queryByText("檢查報告")).toBeNull())
})

it("refreshes after a failed creation and keeps the reason visible", async () => {
  const request = vi.fn(async (value: { kind: string }) => {
    if (value.kind === "desktop/schedule/create") throw new Error("disk flush failed; outcome uncertain")
    return { schedules: [] }
  })
  render(<SchedulePane bridge={{ request, onEvent: () => () => {} }} workspaceId="w" sessionId="s" canCreate />)
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "desktop/schedule/list", workspaceId: "w", sessionId: "s" }))
  fireEvent.change(screen.getByRole("textbox", { name: "提醒內容" }), { target: { value: "整理進度" } })
  fireEvent.click(screen.getByRole("button", { name: "建立提醒" }))
  await screen.findByRole("alert")
  expect(screen.getByRole("alert").textContent).toContain("disk flush failed")
  await waitFor(() => expect(request.mock.calls.filter(([value]) => value.kind === "desktop/schedule/list")).toHaveLength(2))
})

it("keeps a newer reminder list when an older notification read resolves late", async () => {
  let resolveOld!: (value: { schedules: unknown[] }) => void
  let notify!: Parameters<Parameters<typeof SchedulePane>[0]["bridge"]["onEvent"]>[0]
  let reads = 0
  const row = { id: "schedule-1", kind: "after", prompt: "新提醒", afterSeconds: 600, scheduledAt: "2099-01-01T00:00:00.000Z", state: "scheduled", deliveryMode: "session-local" }
  const request = vi.fn(async (value: { kind: string }) => {
    if (value.kind !== "desktop/schedule/list") return { id: "schedule-1" }
    reads += 1
    if (reads === 2) return new Promise<{ schedules: unknown[] }>((resolve) => { resolveOld = resolve })
    return { schedules: reads === 1 ? [] : [row] }
  })
  render(<SchedulePane bridge={{ request, onEvent: (listener) => { notify = listener; return () => {} } }} workspaceId="w" sessionId="s" canCreate />)
  await screen.findByText("此會話尚無提醒")
  act(() => notify({ kind: "sdk/notification", workspaceId: "w", method: "session/event", params: { sessionId: "s", event: { type: "schedule/change" } } }))
  await waitFor(() => expect(reads).toBe(2))
  fireEvent.change(screen.getByRole("textbox", { name: "提醒內容" }), { target: { value: "新提醒" } })
  fireEvent.click(screen.getByRole("button", { name: "建立提醒" }))
  await screen.findByText("新提醒")
  await act(async () => resolveOld({ schedules: [] }))
  expect(screen.getByText("新提醒")).toBeTruthy()
})

it("locks further writes until a failed mutation has a successful read-back", async () => {
  let reads = 0
  const row = { id: "schedule-1", kind: "after", prompt: "未確認提醒", afterSeconds: 600, scheduledAt: "2099-01-01T00:00:00.000Z", state: "scheduled", deliveryMode: "session-local" }
  const request = vi.fn(async (value: { kind: string }) => {
    if (value.kind === "desktop/schedule/create") throw new Error("disk flush failed; outcome uncertain")
    reads += 1
    if (reads === 2) throw new Error("readback failed")
    return { schedules: reads === 1 ? [] : [row] }
  })
  render(<SchedulePane bridge={{ request, onEvent: () => () => {} }} workspaceId="w" sessionId="s" canCreate />)
  await screen.findByText("此會話尚無提醒")
  fireEvent.change(screen.getByRole("textbox", { name: "提醒內容" }), { target: { value: "未確認提醒" } })
  fireEvent.click(screen.getByRole("button", { name: "建立提醒" }))
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("readback failed"))
  expect(screen.getByRole("alert").textContent).toContain("disk flush failed")
  expect((screen.getByRole("button", { name: "建立提醒" }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole("button", { name: "重新讀取提醒" }))
  await screen.findByText("未確認提醒")
  expect((screen.getByRole("button", { name: "建立提醒" }) as HTMLButtonElement).disabled).toBe(false)
  expect(request.mock.calls.filter(([value]) => value.kind === "desktop/schedule/create")).toHaveLength(1)
})
