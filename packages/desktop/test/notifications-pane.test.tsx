// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NotificationsPane } from "../src/renderer/settings/NotificationsPane.tsx"
import type { NotificationHistoryRequest, NotificationHistoryView } from "../src/main/notification-history.ts"
afterEach(cleanup)

describe("notification center", () => {
  it("keeps a missing conversation visible and records explicit read actions", async () => {
    const calls: NotificationHistoryRequest[] = []
    const view: NotificationHistoryView = { unread: 1, items: [{ id: "r", workspaceId: "w", sessionId: "s", kind: "question", summary: "請選擇答案", createdAt: "2026-10-03T00:00:00.000Z", read: false }] }
    const request = async (input: NotificationHistoryRequest) => { calls.push(input); return input.kind === "desktop/notifications/read" ? { unread: 0, items: view.items.map(row => ({ ...row, read: true })) } : view }
    render(<NotificationsPane request={request} onOpenTarget={async () => { throw new Error("會話已不存在") }} />)
    await screen.findByText("請選擇答案")
    fireEvent.click(screen.getByRole("button", { name: "開啟會話" }))
    await screen.findByText("會話已不存在")
    expect(screen.getByText("請選擇答案")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "標為已讀" }))
    await waitFor(() => expect(calls).toContainEqual({ kind: "desktop/notifications/read", id: "r" }))
  })
  it("requires clear confirmation and retains the record when clearing fails", async () => {
    const calls: NotificationHistoryRequest[] = []
    const request = async (input: NotificationHistoryRequest) => { calls.push(input); if (input.kind === "desktop/notifications/clear") throw new Error("保存失敗"); return { unread: 0, items: [{ id: "r", workspaceId: "w", sessionId: "s", kind: "approval" as const, summary: "保留的通知", createdAt: "2026-10-03T00:00:00.000Z", read: true }] } }
    render(<NotificationsPane request={request} onOpenTarget={async () => undefined} />)
    await screen.findByText("保留的通知")
    fireEvent.click(screen.getByRole("button", { name: "清除通知記錄" }))
    expect(calls.some(row => row.kind === "desktop/notifications/clear")).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "確認清除" }))
    await screen.findByText("保存失敗")
    expect(screen.getByRole("alertdialog")).toBeTruthy()
    expect(screen.getByText("保留的通知")).toBeTruthy()
  })
})
