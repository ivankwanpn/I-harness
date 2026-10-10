// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { SessionDashboardResult } from "@i-harness/sdk"
import type { DesktopBridge, DesktopEvent, DesktopRequest } from "../src/shared/bridge.ts"
import { HomeSidebar, type HomeSidebarProps } from "../src/renderer/shell/HomeSidebar.tsx"
import { useLocale } from "../src/renderer/design/i18n.ts"

beforeEach(() => useLocale.getState().setLocale("zh-TW"))
afterEach(() => { cleanup(); useLocale.getState().setLocale("zh-TW") })

const workspaces = [
  { id: "w1", label: "Frontend folder", path: "D:/frontend" },
  { id: "w2", label: "Backend folder", path: "D:/backend" },
  { id: "wu", label: "Legacy folder", path: "D:/legacy" },
]
const projects = [
  { id: "p1", name: "Product", workspaceIds: ["w1", "w2"], primaryWorkspaceId: "w1", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" },
  { id: "p2", name: "Tools", workspaceIds: ["w2"], primaryWorkspaceId: "w2", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" },
]
const dashboards: Record<string, SessionDashboardResult> = {
  w1: { sessions: [{ id: "same", title: "Older conversation", updatedAt: 1000, live: false }] },
  w2: { sessions: [{ id: "same", title: "Newest conversation", updatedAt: 3000, live: true, running: true }] },
  wu: { sessions: [{ id: "legacy", title: "Unowned conversation", updatedAt: 2000, live: false }] },
}
const navigation: Record<string, unknown> = {
  w1: { same: { pinned: true, unread: false, projectId: "p1" } },
  w2: { same: { pinned: false, unread: true, projectId: "p2" } },
  wu: { legacy: { pinned: false, unread: false } },
}

function fixture(handle?: (request: DesktopRequest) => unknown) {
  const listeners = new Set<(event: DesktopEvent) => void>()
  const bridge: DesktopBridge = {
    request: vi.fn(async request => {
      const value = handle?.(request)
      if (value !== undefined) return value
      if (request.kind === "session/dashboard") return dashboards[request.workspaceId]
      if (request.kind === "desktop/session/navigation/state") return navigation[request.workspaceId]
      throw new Error(`Unexpected request: ${request.kind}`)
    }),
    onEvent: vi.fn(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }),
  }
  const props: HomeSidebarProps = {
    bridge, workspaces, projects, selectedWorkspaceId: "w2", selectedSessionId: "same", canCreate: true,
    onCreate: vi.fn(), onSelectSession: vi.fn(), onProjects: vi.fn(), onClose: vi.fn(),
  }
  return { bridge, props, listeners, emit(event: DesktopEvent) { for (const listener of listeners) listener(event) } }
}

it("sorts recent conversations across projects and keeps duplicate session IDs bound to their authoritative sources", async () => {
  const { props, bridge } = fixture()
  render(<HomeSidebar {...props} dashboard={dashboards.w2} />)
  await screen.findByText("Older conversation")
  await screen.findByText("Newest conversation")
  await screen.findByText("Unowned conversation")
  const items = within(screen.getByRole("list", { name: "最近會話" })).getAllByRole("listitem")
  expect(items.map(row => within(row).getByRole("button").textContent)).toEqual([
    expect.stringContaining("Newest conversation"), expect.stringContaining("Unowned conversation"), expect.stringContaining("Older conversation"),
  ])
  expect(within(items[0]!).getByText("Tools")).toBeTruthy()
  expect(within(items[0]!).getByLabelText("未讀")).toBeTruthy()
  expect(within(items[0]!).getByText("執行中")).toBeTruthy()
  expect(within(items[0]!).getByRole("button").getAttribute("aria-current")).toBe("true")
  expect(within(items[1]!).queryByText("未分類會話")).toBeNull()
  expect(within(items[2]!).getByText("Product")).toBeTruthy()
  expect(within(items[2]!).getByLabelText("已釘選")).toBeTruthy()
  expect(within(items[2]!).getByRole("button").getAttribute("aria-current")).toBeNull()
  expect(screen.queryByText("Frontend folder")).toBeNull()
  expect(screen.queryByText("Backend folder")).toBeNull()
  expect(bridge.request).not.toHaveBeenCalledWith({ kind: "session/dashboard", workspaceId: "w2" })
  fireEvent.click(within(items[0]!).getByRole("button"))
  fireEvent.click(within(items[2]!).getByRole("button"))
  fireEvent.click(within(items[1]!).getByRole("button"))
  expect(props.onSelectSession).toHaveBeenNthCalledWith(1, "w2", "same", "p2")
  expect(props.onSelectSession).toHaveBeenNthCalledWith(2, "w1", "same", "p1")
  expect(props.onSelectSession).toHaveBeenNthCalledWith(3, "wu", "legacy", undefined)
})

it("uses the saved project owner even when its source folder belongs to a different project", async () => {
  const { props } = fixture(request => request.kind === "desktop/session/navigation/state" && request.workspaceId === "w1"
    ? { same: { pinned: false, unread: false, projectId: "p2" } } : undefined)
  render(<HomeSidebar {...props} workspaces={[workspaces[0]!]} />)
  const conversation = await screen.findByText("Older conversation")
  const row = within(conversation.closest("li")!)
  expect(row.getByText("Tools")).toBeTruthy()
  expect(row.queryByText("Product")).toBeNull()
  fireEvent.click(conversation)
  expect(props.onSelectSession).toHaveBeenCalledWith("w1", "same", "p2")
})

it("filters by conversation title and project name and clears a hidden search without changing the current chat", async () => {
  const { props } = fixture()
  render(<HomeSidebar {...props} />)
  await screen.findByText("Unowned conversation")
  fireEvent.click(screen.getByRole("button", { name: "搜尋最近會話" }))
  const input = screen.getByRole("searchbox", { name: "搜尋會話或專案" })
  fireEvent.change(input, { target: { value: "tools" } })
  expect(screen.getByText("Newest conversation")).toBeTruthy()
  expect(screen.queryByText("Older conversation")).toBeNull()
  expect(screen.queryByText("Unowned conversation")).toBeNull()
  fireEvent.change(input, { target: { value: "OLDER" } })
  expect(screen.getByText("Older conversation")).toBeTruthy()
  expect(screen.queryByText("Newest conversation")).toBeNull()
  fireEvent.change(input, { target: { value: "missing title" } })
  expect(screen.getByText("沒有符合的會話")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "清除搜尋" }))
  expect(screen.getByText("Newest conversation")).toBeTruthy()
  fireEvent.change(input, { target: { value: "Product" } })
  fireEvent.click(screen.getByRole("button", { name: "搜尋最近會話" }))
  expect(screen.queryByRole("searchbox")).toBeNull()
  expect(screen.getByText("Newest conversation")).toBeTruthy()
  expect(props.onSelectSession).not.toHaveBeenCalled()
})

it("keeps other project conversations available when one ownership read fails and retries only that source", async () => {
  let failed = true
  const { props, bridge } = fixture(request => request.kind === "desktop/session/navigation/state" && request.workspaceId === "w2" && failed
    ? Promise.reject(new Error("Owner lookup failed")) : undefined)
  render(<HomeSidebar {...props} workspaces={workspaces.slice(0, 2)} />)
  await screen.findByText("Older conversation")
  const alert = await screen.findByRole("alert")
  expect(alert.textContent).toContain("Owner lookup failed")
  expect(screen.queryByText("Newest conversation")).toBeNull()
  expect(screen.queryByText("未分類會話")).toBeNull()
  failed = false
  fireEvent.click(within(alert).getByRole("button", { name: "重試" }))
  expect(await screen.findByText("Newest conversation")).toBeTruthy()
  expect(screen.queryByRole("alert")).toBeNull()
  const calls = (bridge.request as ReturnType<typeof vi.fn>).mock.calls.map(([request]) => request)
  expect(calls.filter(row => row.kind === "desktop/session/navigation/state" && row.workspaceId === "w1")).toHaveLength(1)
  expect(calls.filter(row => row.kind === "desktop/session/navigation/state" && row.workspaceId === "w2")).toHaveLength(2)
})

it.each(["missing-row", "malformed-owner", "unloaded-catalog"] as const)("does not invent an unclassified conversation for %s ownership", async kind => {
  const { props } = fixture(request => request.kind === "desktop/session/navigation/state"
    ? kind === "missing-row" ? {} : { same: { pinned: false, unread: false, projectId: kind === "malformed-owner" ? null : "unavailable-project" } }
    : undefined)
  render(<HomeSidebar {...props} projects={kind === "unloaded-catalog" ? undefined : props.projects} workspaces={[workspaces[0]!]} />)
  const alert = await screen.findByRole("alert")
  expect(alert.textContent).toContain(kind === "unloaded-catalog" ? "會話所屬專案無法確認" : "會話分組狀態無法確認")
  expect(within(alert).getByRole("button", { name: "重試" })).toBeTruthy()
  expect(screen.queryByText("Older conversation")).toBeNull()
  expect(screen.queryByText("未分類會話")).toBeNull()
})

it("keeps removed-project history discoverable without replacing its saved owner", async () => {
  const stored = { same: { pinned: false, unread: false, projectId: "removed-project" } }
  const { props, bridge } = fixture(request => request.kind === "desktop/session/navigation/state" ? stored : undefined)
  render(<HomeSidebar {...props} projects={[]} workspaces={[workspaces[0]!]} />)
  const conversation = await screen.findByText("Older conversation")
  expect(within(conversation.closest("li")!).queryByText("未分類會話")).toBeNull()
  fireEvent.click(conversation)
  expect(props.onSelectSession).toHaveBeenCalledWith("w1", "same", "removed-project")
  expect(stored.same.projectId).toBe("removed-project")
  expect((bridge.request as ReturnType<typeof vi.fn>).mock.calls.map(([request]) => request.kind)).toEqual(["session/dashboard", "desktop/session/navigation/state"])
})

it("drops dashboard and ownership replies from a replaced bridge", async () => {
  let finish!: (value: unknown) => void
  const first = fixture(request => request.kind === "desktop/session/navigation/state"
    ? new Promise(resolve => { finish = resolve }) : undefined)
  const next = fixture(request => request.kind === "session/dashboard"
    ? { sessions: [{ id: "same", title: "Fresh bridge conversation", updatedAt: 4000, live: false }] } : undefined)
  const view = render(<HomeSidebar {...first.props} workspaces={[workspaces[0]!]} />)
  await waitFor(() => expect(first.bridge.request).toHaveBeenCalledWith({ kind: "desktop/session/navigation/state", workspaceId: "w1" }))
  view.rerender(<HomeSidebar {...next.props} workspaces={[workspaces[0]!]} />)
  expect(await screen.findByText("Fresh bridge conversation")).toBeTruthy()
  await act(async () => { finish({ same: { pinned: true, unread: false, projectId: "p1" } }); await Promise.resolve() })
  expect(screen.queryByText("Older conversation")).toBeNull()
  expect(screen.getByText("Fresh bridge conversation")).toBeTruthy()
  expect(first.listeners.size).toBe(0)
})

it("requires a fresh ownership read after a source folder is removed and restored", async () => {
  let pending = false
  let finish!: (value: unknown) => void
  const { props } = fixture(request => request.kind === "desktop/session/navigation/state" && pending
    ? new Promise(resolve => { finish = resolve }) : undefined)
  const view = render(<HomeSidebar {...props} workspaces={[workspaces[0]!]} />)
  await screen.findByText("Older conversation")
  view.rerender(<HomeSidebar {...props} workspaces={[]} />)
  expect(screen.queryByText("Older conversation")).toBeNull()
  pending = true
  view.rerender(<HomeSidebar {...props} workspaces={[workspaces[0]!]} />)
  expect(screen.queryByText("Older conversation")).toBeNull()
  await waitFor(() => expect(finish).toBeTruthy())
  await act(async () => { finish({ same: { pinned: false, unread: false, projectId: "p2" } }) })
  const conversation = await screen.findByText("Older conversation")
  expect(within(conversation.closest("li")!).getByText("Tools")).toBeTruthy()
})

it("coalesces durable and navigation notifications, ignores chunks, and invalidates a disconnected source", async () => {
  let fresh = false
  const { props, bridge, listeners, emit } = fixture(request => request.kind === "session/dashboard" && fresh
    ? { sessions: [{ id: "same", title: "Updated recent conversation", updatedAt: 5000, live: true, running: true }] } : undefined)
  const view = render(<HomeSidebar {...props} workspaces={[workspaces[0]!]} />)
  await screen.findByText("Older conversation")
  const reads = () => (bridge.request as ReturnType<typeof vi.fn>).mock.calls.filter(([request]) => request.kind === "session/dashboard").length
  emit({ kind: "sdk/notification", workspaceId: "unknown-source", method: "session/status", params: { sessionId: "same", status: "idle" } })
  emit({ kind: "sdk/notification", workspaceId: "w1", method: "session/event", params: { sessionId: "same", event: { type: "assistant/chunk", text: "stream" } } })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
  expect(reads()).toBe(1)
  fresh = true
  emit({ kind: "sdk/notification", workspaceId: "w1", method: "session/status", params: { sessionId: "same", status: "running" } })
  emit({ kind: "sdk/notification", workspaceId: "w1", method: "desktop/session/navigation/changed", params: {} })
  emit({ kind: "sdk/notification", workspaceId: "w1", method: "session/event", params: { sessionId: "same", event: { type: "assistant/message" } } })
  expect(await screen.findByText("Updated recent conversation")).toBeTruthy()
  expect(reads()).toBe(2)
  emit({ kind: "sdk/disconnected", workspaceId: "w1", message: "Connection lost" })
  const alert = await screen.findByRole("alert")
  expect(alert.textContent).toContain("Connection lost")
  expect(screen.queryByText("Updated recent conversation")).toBeNull()
  fireEvent.click(within(alert).getByRole("button", { name: "重試" }))
  expect(await screen.findByText("Updated recent conversation")).toBeTruthy()
  view.unmount()
  expect(listeners.size).toBe(0)
  emit({ kind: "sdk/notification", workspaceId: "w1", method: "session/status", params: { sessionId: "same", status: "idle" } })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
  expect(reads()).toBe(3)
})

it("keeps creation gated and exposes project navigation and closing without changing the current selection", async () => {
  const { props } = fixture()
  const view = render(<HomeSidebar {...props} workspaces={[]} canCreate={false} />)
  fireEvent.click(screen.getByRole("button", { name: "新增會話" }))
  expect(props.onCreate).not.toHaveBeenCalled()
  view.rerender(<HomeSidebar {...props} workspaces={[]} canCreate />)
  fireEvent.click(screen.getByRole("button", { name: "新增會話" }))
  fireEvent.click(screen.getByRole("button", { name: "專案" }))
  fireEvent.click(screen.getByRole("button", { name: "關閉首頁側欄" }))
  expect(props.onCreate).toHaveBeenCalledTimes(1)
  expect(props.onProjects).toHaveBeenCalledTimes(1)
  expect(props.onClose).toHaveBeenCalledTimes(1)
  expect(props.onSelectSession).not.toHaveBeenCalled()
})

it("keeps activity in compact metadata while preserving unclassified search", async () => {
  const { props } = fixture(); render(<HomeSidebar {...props} />)
  const row = (await screen.findByText("Newest conversation")).closest("li")!
  expect(row.querySelector("time")?.parentElement?.className).toBe("home-sidebar-conversation-meta")
  fireEvent.click(screen.getByRole("button", { name: "搜尋最近會話" }))
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "未分類會話" } })
  expect(screen.getByText("Unowned conversation")).toBeTruthy()
  expect(screen.queryByText("Newest conversation")).toBeNull()
  expect(screen.queryByText("未分類會話")).toBeNull()
})
