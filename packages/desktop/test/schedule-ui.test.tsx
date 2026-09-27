// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
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
