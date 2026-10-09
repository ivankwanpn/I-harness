// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { DesktopBridge, DesktopEvent, DesktopRequest } from "../src/shared/bridge.ts"
import type { SessionDashboardResult } from "@i-harness/sdk"
import { ProjectSidebar, type ProjectSidebarProps } from "../src/renderer/shell/ProjectSidebar.tsx"

afterEach(cleanup)
const workspaces = [
  { id: "w1", label: "Frontend", path: "D:/frontend" },
  { id: "w2", label: "Backend", path: "D:/backend" },
  { id: "wu", label: "Other", path: "D:/other" },
]
const projects = [
  { id: "p1", name: "Product", workspaceIds: ["w1", "w2"], primaryWorkspaceId: "w1", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" },
  { id: "p2", name: "Pinned", workspaceIds: ["w2"], pinned: true, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" },
]
const dashboard = (title: string): SessionDashboardResult => ({ sessions: [{ id: "s1", title, live: false }] })

function fixture(handle?: (request: DesktopRequest) => unknown) {
  const listeners = new Set<(event: DesktopEvent) => void>()
  const bridge: DesktopBridge = {
    request: vi.fn(async (request) => handle?.(request) ?? (request.kind === "session/dashboard" ? dashboard(`Chat ${request.workspaceId}`) : request.kind === "desktop/session/navigation/state" ? { s1: { pinned: false, unread: false } } : {})),
    onEvent: vi.fn((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }),
  }
  const props: ProjectSidebarProps = {
    bridge, projects, workspaces, selectedProjectId: "p1", selectedWorkspaceId: "w1", selectedSessionId: "s1", dashboard: dashboard("Current chat"),
    canCreate: true, onCreate: vi.fn(), onOpenWorkspace: vi.fn(), onProjects: vi.fn(), onSettings: vi.fn(),
    onSelectProject: vi.fn(), onSelectWorkspace: vi.fn(), onSelectSession: vi.fn(), onManageSession: vi.fn(async () => {}), onManageArchived: vi.fn(),
  }
  return { props, bridge, listeners, emit(event: DesktopEvent) { for (const listener of listeners) listener(event) } }
}

describe("project sidebar hierarchy", () => {
  it("orders pinned projects first, marks the primary folder, and loads only the expanded folder", async () => {
    const { props, bridge } = fixture()
    const view = render(<ProjectSidebar {...props} />)
    expect(Array.from(view.container.querySelectorAll(".project-sidebar-project-name")).map((row) => row.textContent)).toEqual(["Pinned", "Product"])
    expect(screen.getByText("主要資料夾")).toBeTruthy()
    expect(screen.getByText("未分類資料夾")).toBeTruthy()
    expect(await screen.findByText("Current chat")).toBeTruthy()
    await waitFor(() => expect(bridge.request).toHaveBeenCalledWith({ kind: "desktop/session/navigation/state", workspaceId: "w1" }))
    expect(bridge.request).not.toHaveBeenCalledWith({ kind: "session/dashboard", workspaceId: "w1" })
    expect((bridge.request as ReturnType<typeof vi.fn>).mock.calls.every(([request]) => request.workspaceId === "w1" || request.kind === "desktop/session/navigation/state")).toBe(true)
    expect(screen.queryByText("Chat w2")).toBeNull()
  })

  it("selects a folder in its project scope and loads that folder's own sessions", async () => {
    const { props } = fixture()
    render(<ProjectSidebar {...props} />)
    fireEvent.click(screen.getByRole("button", { name: "Backend" }))
    await screen.findByText("Chat w2")
    expect(props.onSelectWorkspace).toHaveBeenCalledWith("w2", "p1")
    fireEvent.click(screen.getByText("Chat w2"))
    expect(props.onSelectSession).toHaveBeenCalledWith("w2", "s1", "p1")
    fireEvent.click(screen.getByRole("button", { name: "Pinned" }))
    expect(props.onSelectProject).toHaveBeenCalledWith("p2")
  })

  it("uses the latest parent dashboard for the selected folder", async () => {
    const { props } = fixture()
    const view = render(<ProjectSidebar {...props} />)
    expect(await screen.findByText("Current chat")).toBeTruthy()
    view.rerender(<ProjectSidebar {...props} dashboard={dashboard("Latest selected chat")} />)
    expect(screen.getByText("Latest selected chat")).toBeTruthy()
    expect(screen.queryByText("Current chat")).toBeNull()
  })

  it("drops late reads from a collapsed folder and unsubscribes it", async () => {
    let finish!: (result: unknown) => void
    let reads = 0
    const { props, listeners } = fixture((request) => request.kind === "session/dashboard" && request.workspaceId === "w2"
      ? ++reads === 1 ? new Promise((resolve) => { finish = resolve }) : dashboard("Fresh backend chat") : undefined)
    render(<ProjectSidebar {...props} />)
    fireEvent.click(screen.getByRole("button", { name: "Backend" }))
    await waitFor(() => expect(reads).toBe(1))
    expect(listeners.size).toBe(3)
    fireEvent.click(screen.getByRole("button", { name: "收合資料夾 Backend" }))
    expect(listeners.size).toBe(2)
    fireEvent.click(screen.getByRole("button", { name: "Backend" }))
    await screen.findByText("Fresh backend chat")
    await act(async () => { finish(dashboard("Stale backend chat")); await Promise.resolve() })
    expect(screen.queryByText("Stale backend chat")).toBeNull()
    expect(screen.getByText("Fresh backend chat")).toBeTruthy()
  })

  it("refreshes an expanded folder on durable status but ignores chunks and other workspaces", async () => {
    const { props, bridge, emit } = fixture()
    render(<ProjectSidebar {...props} />)
    fireEvent.click(screen.getByRole("button", { name: "Backend" }))
    await screen.findByText("Chat w2")
    const count = () => (bridge.request as ReturnType<typeof vi.fn>).mock.calls.filter(([request]) => request.kind === "session/dashboard" && request.workspaceId === "w2").length
    expect(count()).toBe(1)
    emit({ kind: "sdk/notification", workspaceId: "unopened", method: "session/status", params: { sessionId: "s1", status: "idle" } })
    emit({ kind: "sdk/notification", workspaceId: "w2", method: "session/event", params: { sessionId: "s1", event: { type: "assistant/chunk", text: "stream" } } })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)) })
    expect(count()).toBe(1)
    emit({ kind: "sdk/notification", workspaceId: "w2", method: "session/status", params: { sessionId: "s1", status: "idle" } })
    await waitFor(() => expect(count()).toBe(2))
  })

  it("routes session mutations to their folder and refreshes its navigation", async () => {
    let pinned = false
    const { props } = fixture((request) => request.kind === "desktop/session/navigation/state" && request.workspaceId === "w2" ? { s1: { pinned, unread: false } } : undefined)
    props.onManageSession = vi.fn(async () => { pinned = true })
    render(<ProjectSidebar {...props} />)
    fireEvent.click(screen.getByRole("button", { name: "Backend" }))
    const session = await screen.findByText("Chat w2")
    const scope = within(session.closest(".project-sidebar-folder-sessions")! as HTMLElement)
    fireEvent.click(scope.getByRole("button", { name: "更多會話操作 Chat w2" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "釘選會話" }))
    await waitFor(() => expect(props.onManageSession).toHaveBeenCalledWith("w2", "s1", "pin", undefined))
    await waitFor(() => expect(scope.getByLabelText("已釘選")).toBeTruthy())
    fireEvent.click(scope.getByRole("button", { name: "管理已封存會話" }))
    expect(props.onManageArchived).toHaveBeenCalledWith("w2")
  })

  it("selects a chat immediately and clears unread from the saved navigation result", async () => {
    let unread = true
    let finish!: () => void
    const { props } = fixture((request) => request.kind === "desktop/session/navigation/state" && request.workspaceId === "w2" ? { s1: { pinned: false, unread } } : undefined)
    props.onManageSession = vi.fn(async () => { await new Promise<void>((resolve) => { finish = resolve }); unread = false })
    render(<ProjectSidebar {...props} />)
    fireEvent.click(screen.getByRole("button", { name: "Backend" }))
    const session = await screen.findByText("Chat w2")
    const scope = within(session.closest(".project-sidebar-folder-sessions")! as HTMLElement)
    expect(scope.getByLabelText("未讀")).toBeTruthy()
    fireEvent.click(session)
    expect(props.onSelectSession).toHaveBeenCalledWith("w2", "s1", "p1")
    expect(props.onManageSession).toHaveBeenCalledWith("w2", "s1", "read")
    expect(scope.getByLabelText("未讀")).toBeTruthy()
    await act(async () => { finish() })
    await waitFor(() => expect(scope.queryByLabelText("未讀")).toBeNull())
  })

  it("opens unassigned folders without inventing project membership and gates new chat by the selected folder", async () => {
    const { props } = fixture()
    const view = render(<ProjectSidebar {...props} canCreate={false} />)
    expect((screen.getByRole("button", { name: "新增會話" }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "未分類資料夾" }))
    fireEvent.click(screen.getByRole("button", { name: "Other" }))
    await screen.findByText("Chat wu")
    expect(props.onSelectWorkspace).toHaveBeenCalledWith("wu", undefined)
    view.rerender(<ProjectSidebar {...props} canCreate={true} />)
    fireEvent.click(screen.getByRole("button", { name: "新增會話" }))
    expect(props.onCreate).toHaveBeenCalledTimes(1)
  })

  it("routes folder reveal and copied conversation ID through the selected row scope", async () => {
    const { props, bridge } = fixture()
    const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard")
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    try {
      render(<ProjectSidebar {...props} />)
      fireEvent.click(screen.getByRole("button", { name: "Backend" }))
      const session = await screen.findByText("Chat w2")
      const scope = within(session.closest(".project-sidebar-folder-sessions")! as HTMLElement)
      fireEvent.click(scope.getByRole("button", { name: "更多會話操作 Chat w2" }))
      fireEvent.click(screen.getByRole("menuitem", { name: "開啟工作區資料夾" }))
      await waitFor(() => expect(bridge.request).toHaveBeenCalledWith({ kind: "workspace/reveal", workspaceId: "w2" }))
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
      fireEvent.click(scope.getByRole("button", { name: "更多會話操作 Chat w2" }))
      fireEvent.click(screen.getByRole("menuitem", { name: "複製會話 ID" }))
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("s1"))
      expect(props.onSelectSession).not.toHaveBeenCalled()
    } finally {
      if (previous) Object.defineProperty(navigator, "clipboard", previous)
      else Reflect.deleteProperty(navigator, "clipboard")
    }
  })
})

it("shows a moved conversation in its destination project through its original storage folder", async () => {
  const { props } = fixture(request => request.kind === "desktop/session/navigation/state" ? request.workspaceId === "w1" ? { s1: { projectId: "p2", pinned: false, unread: false } } : {} : undefined)
  render(<ProjectSidebar {...props} selectedProjectId="p2" selectedWorkspaceId="w1" />)
  await screen.findByText(/執行起始資料夾/)
  const chat = await screen.findByText("Current chat")
  fireEvent.click(chat)
  expect(props.onSelectSession).toHaveBeenCalledWith("w1", "s1", "p2")
  expect(props.onManageSession).toHaveBeenCalledWith("w1", "s1", "read")
})

it("keeps a confirmed removed-project conversation discoverable without changing its saved owner", async () => {
  const stored = { s1: { projectId: "removed-project", pinned: false, unread: false }, s2: { pinned: false, unread: false } }
  const { props, bridge } = fixture(request => request.kind === "desktop/session/navigation/state" ? stored : request.kind === "session/dashboard" ? { sessions: [{ id: "s1", title: "Chat w1", live: false }, { id: "s2", title: "Ordinary unbound chat", live: false }] } : undefined)
  const removed = { ...projects[0]!, id: "removed-project", name: "Removed group", workspaceIds: ["w1"] }
  const view = render(<ProjectSidebar {...props} projects={[removed, ...projects]} selectedProjectId={removed.id} workspaces={[workspaces[0]!]} />)
  await screen.findByText("Current chat")
  view.rerender(<ProjectSidebar {...props} projects={projects} selectedProjectId={undefined} selectedWorkspaceId={undefined} selectedSessionId={undefined} dashboard={undefined} workspaces={[workspaces[0]!]} />)
  const ungrouped = await screen.findByRole("button", { name: "未分類資料夾" })
  fireEvent.click(ungrouped)
  const folder = within(ungrouped.closest("li")! as HTMLElement)
  fireEvent.click(folder.getByRole("button", { name: "Frontend" }))
  const conversation = await folder.findByText("Chat w1")
  expect(folder.queryByText("Ordinary unbound chat")).toBeNull()
  fireEvent.click(conversation)
  expect(props.onSelectSession).toHaveBeenCalledWith("w1", "s1", undefined)
  expect(stored.s1.projectId).toBe("removed-project")
  expect((bridge.request as ReturnType<typeof vi.fn>).mock.calls.every(([request]) => request.kind !== "desktop/session/project/bind" && request.kind !== "desktop/session/batch")).toBe(true)
})

it.each(["rejected", "missing-row", "malformed-owner"] as const)("excludes %s owner lookup rather than showing the conversation as unassigned", async kind => {
  const { props } = fixture(request => {
    if (request.kind !== "desktop/session/navigation/state") return undefined
    if (kind === "rejected") return Promise.reject(new Error("Owner lookup failed"))
    return kind === "missing-row" ? {} : { s1: { pinned: false, unread: false, projectId: null } }
  })
  render(<ProjectSidebar {...props} projects={[]} workspaces={[workspaces[0]!]} selectedProjectId={undefined} />)
  if (kind === "rejected") await screen.findAllByText(/Owner lookup failed/)
  else await screen.findByText("尚無會話")
  expect(screen.queryByText("Current chat")).toBeNull()
  expect(props.onSelectSession).not.toHaveBeenCalled()
})

it("invalidates a previously confirmed row when the refreshed owner lookup fails", async () => {
  let fail = false
  const { props, emit } = fixture(request => request.kind === "desktop/session/navigation/state" && fail ? Promise.reject(new Error("Owner lookup failed")) : undefined)
  render(<ProjectSidebar {...props} projects={[]} workspaces={[workspaces[0]!]} selectedProjectId={undefined} />)
  await screen.findByText("Current chat")
  fail = true
  emit({ kind: "sdk/notification", workspaceId: "w1", method: "desktop/session/navigation/changed", params: {} })
  await screen.findAllByText(/Owner lookup failed/)
  await waitFor(() => expect(screen.queryByText("Current chat")).toBeNull())
})
