// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { DesktopBridge, DesktopEvent, DesktopRequest } from "../src/shared/bridge.ts"
import type { SessionDashboardResult } from "@i-harness/sdk"
import { ProjectSidebar, type ProjectSidebarProps } from "../src/renderer/shell/ProjectSidebar.tsx"
import { WorkspaceSidebar } from "../src/renderer/shell/WorkspaceSidebar.tsx"

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

describe("project conversation sidebar", () => {
  it("orders pinned projects first and collects all member conversations directly under an expanded project", async () => {
    const { props, bridge } = fixture()
    const view = render(<ProjectSidebar {...props} />)
    expect(Array.from(view.container.querySelectorAll(".project-sidebar-project-name")).map((row) => row.textContent)).toEqual(["Pinned", "Product"])
    expect(screen.getByText("未分類會話")).toBeTruthy()
    expect(await screen.findByText("Current chat")).toBeTruthy()
    expect(await screen.findByText("Chat w2")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Frontend" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Backend" })).toBeNull()
    await waitFor(() => expect(bridge.request).toHaveBeenCalledWith({ kind: "desktop/session/navigation/state", workspaceId: "w1" }))
    expect(bridge.request).not.toHaveBeenCalledWith({ kind: "session/dashboard", workspaceId: "w1" })
    expect(bridge.request).toHaveBeenCalledWith({ kind: "session/dashboard", workspaceId: "w2" })
    expect(bridge.request).not.toHaveBeenCalledWith({ kind: "session/dashboard", workspaceId: "wu" })
  })

  it("selects a conversation through its original folder and keeps project selection on the existing native route", async () => {
    const { props } = fixture()
    render(<ProjectSidebar {...props} />)
    await screen.findByText("Chat w2")
    fireEvent.click(screen.getByText("Chat w2"))
    expect(props.onSelectSession).toHaveBeenCalledWith("w2", "s1", "p1")
    fireEvent.click(screen.getByRole("button", { name: "Pinned" }))
    expect(props.onSelectProject).toHaveBeenCalledWith("p2")
    expect(props.onSelectWorkspace).not.toHaveBeenCalled()
  })

  it("uses the latest parent dashboard for the selected folder", async () => {
    const { props } = fixture()
    const view = render(<ProjectSidebar {...props} />)
    expect(await screen.findByText("Current chat")).toBeTruthy()
    view.rerender(<ProjectSidebar {...props} dashboard={dashboard("Latest selected chat")} />)
    expect(screen.getByText("Latest selected chat")).toBeTruthy()
    expect(screen.queryByText("Current chat")).toBeNull()
  })

  it("retains the last supplied member dashboard when selection moves to another folder in the same project", async () => {
    const { props } = fixture()
    const view = render(<ProjectSidebar {...props} />)
    await screen.findByText("Current chat")
    await screen.findByText("Chat w2")
    view.rerender(<ProjectSidebar {...props} dashboard={dashboard("Latest frontend chat")} />)
    view.rerender(<ProjectSidebar {...props} selectedWorkspaceId="w2" dashboard={dashboard("Latest backend chat")} />)
    expect(screen.getByText("Latest frontend chat")).toBeTruthy()
    expect(screen.getByText("Latest backend chat")).toBeTruthy()
    expect(screen.queryByText("Chat w2")).toBeNull()
    expect(screen.getByText("Latest frontend chat").closest("button")?.getAttribute("aria-current")).toBeNull()
    expect(screen.getByText("Latest backend chat").closest("button")?.getAttribute("aria-current")).toBe("true")
  })

  it("drops late reads from a collapsed project and stops refreshing its conversations", async () => {
    let finish!: (result: unknown) => void
    let reads = 0
    const { props, emit } = fixture((request) => request.kind === "session/dashboard" && request.workspaceId === "w2"
      ? ++reads === 1 ? new Promise((resolve) => { finish = resolve }) : dashboard("Fresh backend chat") : undefined)
    render(<ProjectSidebar {...props} />)
    await waitFor(() => expect(reads).toBe(1))
    fireEvent.click(screen.getByRole("button", { name: "收合專案 Product" }))
    emit({ kind: "sdk/notification", workspaceId: "w2", method: "session/status", params: { sessionId: "s1", status: "idle" } })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)) })
    expect(reads).toBe(1)
    fireEvent.click(screen.getByRole("button", { name: "Product" }))
    await screen.findByText("Fresh backend chat")
    await act(async () => { finish(dashboard("Stale backend chat")); await Promise.resolve() })
    expect(screen.queryByText("Stale backend chat")).toBeNull()
    expect(screen.getByText("Fresh backend chat")).toBeTruthy()
  })

  it("requires fresh ownership when a removed source folder is added back to an expanded project", async () => {
    let pending = false
    const finish: ((value: unknown) => void)[] = []
    const { props } = fixture(request => request.kind === "desktop/session/navigation/state"
      ? request.workspaceId === "w2" && pending ? new Promise(resolve => finish.push(resolve)) : { s1: { projectId: "p1", pinned: false, unread: false } }
      : undefined)
    const view = render(<ProjectSidebar {...props} />)
    await screen.findByText("Chat w2")
    view.rerender(<ProjectSidebar {...props} workspaces={[workspaces[0]!]} />)
    expect(screen.queryByText("Chat w2")).toBeNull()
    pending = true
    view.rerender(<ProjectSidebar {...props} />)
    expect(screen.queryByText("Chat w2")).toBeNull()
    await waitFor(() => expect(finish.length).toBeGreaterThan(0))
    await act(async () => { finish.forEach(resolve => resolve({ s1: { projectId: "p2", pinned: false, unread: false } })) })
    expect(screen.queryByText("Chat w2")).toBeNull()
    expect(screen.getByText("Current chat")).toBeTruthy()
  })

  it("refreshes an expanded project's affected folder on durable status but ignores chunks and other workspaces", async () => {
    const { props, bridge, emit } = fixture()
    render(<ProjectSidebar {...props} />)
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
    const session = await screen.findByText("Chat w2")
    const scope = within(session.closest("li")! as HTMLElement)
    fireEvent.click(scope.getByRole("button", { name: "更多會話操作 Chat w2" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "釘選會話" }))
    await waitFor(() => expect(props.onManageSession).toHaveBeenCalledWith("w2", "s1", "pin", undefined))
    await waitFor(() => expect(scope.getByLabelText("已釘選")).toBeTruthy())
    fireEvent.change(screen.getByRole("combobox", { name: "選擇來源資料夾" }), { target: { value: "w2" } })
    fireEvent.click(screen.getByRole("button", { name: "管理已封存會話" }))
    expect(props.onManageArchived).toHaveBeenCalledWith("w2")
  })

  it("selects a chat immediately and clears unread from the saved navigation result", async () => {
    let unread = true
    let finish!: () => void
    const { props } = fixture((request) => request.kind === "desktop/session/navigation/state" && request.workspaceId === "w2" ? { s1: { pinned: false, unread } } : undefined)
    props.onManageSession = vi.fn(async () => { await new Promise<void>((resolve) => { finish = resolve }); unread = false })
    render(<ProjectSidebar {...props} />)
    const session = await screen.findByText("Chat w2")
    const scope = within(session.closest("li")! as HTMLElement)
    expect(scope.getByLabelText("未讀")).toBeTruthy()
    fireEvent.click(session)
    expect(props.onSelectSession).toHaveBeenCalledWith("w2", "s1", "p1")
    expect(props.onManageSession).toHaveBeenCalledWith("w2", "s1", "read")
    expect(scope.getByLabelText("未讀")).toBeTruthy()
    await act(async () => { finish() })
    await waitFor(() => expect(scope.queryByLabelText("未讀")).toBeNull())
  })

  it("opens ungrouped conversations without inventing project membership and gates new chat by the native selection", async () => {
    const { props } = fixture()
    const view = render(<ProjectSidebar {...props} canCreate={false} />)
    expect((screen.getByRole("button", { name: "新增會話" }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "未分類會話" }))
    await screen.findByText("Chat wu")
    fireEvent.click(screen.getByText("Chat wu"))
    expect(props.onSelectSession).toHaveBeenCalledWith("wu", "s1", undefined)
    expect(props.onSelectWorkspace).not.toHaveBeenCalled()
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
      const session = await screen.findByText("Chat w2")
      const scope = within(session.closest("li")! as HTMLElement)
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
  const ungrouped = await screen.findByRole("button", { name: "未分類會話" })
  fireEvent.click(ungrouped)
  const folder = within(ungrouped.closest("li")! as HTMLElement)
  const conversation = await folder.findByText("Chat w1")
  expect(folder.queryByText("Ordinary unbound chat")).toBeNull()
  fireEvent.click(conversation)
  expect(props.onSelectSession).toHaveBeenCalledWith("w1", "s1", undefined)
  expect(stored.s1.projectId).toBe("removed-project")
  expect((bridge.request as ReturnType<typeof vi.fn>).mock.calls.every(([request]) => request.kind !== "desktop/session/project/bind" && request.kind !== "desktop/session/batch")).toBe(true)
})

it("distinguishes duplicate native conversation IDs across member folders for selection, attention and mutations", async () => {
  let pinned = false
  const { props } = fixture(request => request.kind === "desktop/session/navigation/state" ? { s1: { projectId: "p1", pinned: request.workspaceId === "w2" && pinned, unread: false } } : undefined)
  props.onManageSession = vi.fn(async (workspaceId, _id, action) => { if (workspaceId === "w2" && action === "pin") pinned = true })
  const view = render(<ProjectSidebar {...props} attentionBySession={{ s1: 2 }} />)
  const current = await screen.findByText("Current chat")
  const other = await screen.findByText("Chat w2")
  expect(current.closest("button")?.getAttribute("aria-current")).toBe("true")
  expect(other.closest("button")?.getAttribute("aria-current")).toBeNull()
  expect(within(current.closest("li")! as HTMLElement).getByText("待人處理 · 2")).toBeTruthy()
  expect(within(other.closest("li")! as HTMLElement).queryByText("待人處理 · 2")).toBeNull()
  fireEvent.click(other)
  expect(props.onSelectSession).toHaveBeenCalledWith("w2", "s1", "p1")
  await waitFor(() => expect(props.onManageSession).toHaveBeenCalledWith("w2", "s1", "read"))
  fireEvent.click(screen.getByRole("button", { name: "更多會話操作 Chat w2" }))
  fireEvent.click(screen.getByRole("menuitem", { name: "釘選會話" }))
  await waitFor(() => expect(props.onManageSession).toHaveBeenCalledWith("w2", "s1", "pin", undefined))
  await waitFor(() => expect(within(other.closest("li")! as HTMLElement).getByLabelText("已釘選")).toBeTruthy())
  expect(within(current.closest("li")! as HTMLElement).queryByLabelText("已釘選")).toBeNull()
  expect(view.container.textContent).not.toContain('["w2","s1"]')
})

it("keeps confirmed foreign owners out of a project while displaying legacy unowned member history", async () => {
  const { props } = fixture(request => request.kind === "desktop/session/navigation/state" ? { s1: { pinned: false, unread: false, ...(request.workspaceId === "w1" ? { projectId: "p2" } : {}) } } : undefined)
  render(<ProjectSidebar {...props} />)
  await screen.findByText("Chat w2")
  expect(screen.queryByText("Current chat")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Pinned" }))
  const group = within(screen.getByRole("button", { name: "Pinned" }).closest("li")! as HTMLElement)
  const moved = await group.findByText("Chat w1")
  fireEvent.click(moved)
  expect(props.onSelectSession).toHaveBeenCalledWith("w1", "s1", "p2")
})

it("routes row management and consolidated batch/archive controls to the selected native source folder", async () => {
  const { props } = fixture()
  props.onManageSessions = vi.fn()
  render(<ProjectSidebar {...props} />)
  await screen.findByText("Chat w2")
  fireEvent.click(screen.getByRole("button", { name: "更多會話操作 Chat w2" }))
  fireEvent.click(screen.getByRole("menuitem", { name: "管理此會話" }))
  expect(props.onManageSessions).toHaveBeenCalledWith("w2", "s1")
  fireEvent.change(screen.getByRole("combobox", { name: "選擇來源資料夾" }), { target: { value: "w2" } })
  fireEvent.click(screen.getByRole("button", { name: "批次管理會話" }))
  expect(props.onManageSessions).toHaveBeenCalledWith("w2", undefined)
  fireEvent.click(screen.getByRole("button", { name: "管理已封存會話" }))
  expect(props.onManageArchived).toHaveBeenCalledWith("w2")
})

it("retains a failed rename draft through unrelated folder refresh without retargeting duplicate IDs", async () => {
  const { props, emit } = fixture()
  props.onManageSession = vi.fn(async () => { throw new Error("Session is busy") })
  render(<ProjectSidebar {...props} />)
  await screen.findByText("Chat w2")
  fireEvent.click(screen.getByRole("button", { name: "更多會話操作 Chat w2" }))
  fireEvent.click(screen.getByRole("menuitem", { name: "重新命名" }))
  fireEvent.change(screen.getByLabelText("會話名稱"), { target: { value: "Backend draft" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  await screen.findByText("Session is busy")
  emit({ kind: "sdk/notification", workspaceId: "w1", method: "session/status", params: { sessionId: "s1", status: "idle" } })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
  expect((screen.getByLabelText("會話名稱") as HTMLInputElement).value).toBe("Backend draft")
  expect(props.onManageSession).toHaveBeenCalledWith("w2", "s1", "rename", "Backend draft")
})

it("uses accessible project header actions and omits the duplicate marketplace entry from both sidebar variants", () => {
  const { props } = fixture()
  props.onPlugins = vi.fn()
  const projectView = render(<ProjectSidebar {...props} />)
  fireEvent.click(screen.getByRole("button", { name: "管理專案" }))
  expect(props.onProjects).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole("button", { name: "開啟專案" }))
  expect(props.onOpenWorkspace).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole("button", { name: "插件市場" })).toBeNull()
  projectView.unmount()
  const openFallback = vi.fn()
  render(<WorkspaceSidebar workspaces={workspaces} selectedId="w1" onSelect={() => {}} onOpen={openFallback} onPlugins={props.onPlugins} />)
  fireEvent.click(within(screen.getByRole("navigation", { name: "專案" })).getByRole("button", { name: "開啟專案" }))
  expect(openFallback).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole("button", { name: "插件市場" })).toBeNull()
  expect(props.onPlugins).not.toHaveBeenCalled()
})

it.each(["rejected", "missing-row", "malformed-owner"] as const)("excludes %s owner lookup rather than showing the conversation as unassigned", async kind => {
  const { props } = fixture(request => {
    if (request.kind !== "desktop/session/navigation/state") return undefined
    if (kind === "rejected") return Promise.reject(new Error("Owner lookup failed"))
    return kind === "missing-row" ? {} : { s1: { pinned: false, unread: false, projectId: null } }
  })
  render(<ProjectSidebar {...props} projects={[]} workspaces={[workspaces[0]!]} selectedProjectId={undefined} />)
  if (kind === "rejected") await screen.findAllByText(/Owner lookup failed/)
  else await screen.findByText("會話分組狀態無法確認")
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

it("does not describe failed ownership as an empty conversation history", async () => {
  const { props } = fixture(request => request.kind === "desktop/session/navigation/state" ? Promise.reject(new Error("Owner lookup failed")) : undefined)
  render(<ProjectSidebar {...props} projects={[]} workspaces={[workspaces[0]!]} selectedProjectId={undefined} />)
  await screen.findAllByText(/Owner lookup failed/)
  expect(screen.queryByText("尚無會話")).toBeNull()
  expect(screen.queryByText("Current chat")).toBeNull()
})

it("keeps verified conversations available when another member has no listing authority", async () => {
  const { props } = fixture(request => request.kind === "session/dashboard" && request.workspaceId === "w2" ? {
    sessions: [{ id: "s1", title: "Unconfirmed backend listing", live: false }], listingUnavailable: true,
  } : undefined)
  render(<ProjectSidebar {...props} />)
  await screen.findByText("Backend · 無法取得會話列表")
  expect(screen.getByText("Current chat")).toBeTruthy()
  expect(screen.queryByText("Unconfirmed backend listing")).toBeNull()
  expect(screen.queryByText("尚無會話")).toBeNull()
})
