// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { App } from "../src/renderer/app.tsx"
import { Workbench } from "../src/renderer/shell/Workbench.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"
import type { DesktopBridge } from "../src/shared/bridge.ts"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  localStorage.removeItem("ih:last-workspace")
  useUiStore.setState({ selectedWorkspaceId: undefined, selectedSessionId: undefined })
})
it("uses the same project conversation list from Home and project management", async () => {
  useUiStore.setState({ surface: "conversation", sidebarCollapsed: false, reviewOpen: false })
  const manage = vi.fn(async () => {})
  const view = render(<Workbench projects={[{ id: "p", name: "Product", workspaceIds: ["w"], primaryWorkspaceId: "w", createdAt: "2026-10-10", updatedAt: "2026-10-10" }]}
    workspaces={[{ id: "w", path: "D:/fixture", label: "Folder" }]} selectedProjectId="p" selectedWorkspaceId="w" selectedSessionId="s"
    dashboard={{ sessions: [{ id: "s", title: "Example", live: false }] }}
    bridge={{ request: async input => input.kind === "desktop/session/navigation/state" ? { s: { projectId: "p", pinned: false, unread: false } } : { sessions: [{ id: "s", title: "Example", live: false }] }, onEvent: () => () => {} }}
    capabilities={{ "desktop-sessions": ["1"] }} onSelectSession={() => {}} onSelectWorkspace={() => {}} onSelectProject={() => {}} onProjectsChanged={async () => {}} onManageSessionInWorkspace={manage} />)
  const sidebar = screen.getByRole("navigation", { name: "專案" })
  expect(await within(sidebar).findByText("Example")).toBeTruthy()
  const tree = view.container.querySelector<HTMLElement>(".sidebar-scroll")!
  tree.scrollTop = 60
  fireEvent.click(screen.getByRole("button", { name: "收合專案 Product" }))
  const rail = within(screen.getByRole("navigation", { name: "主導覽" }))
  fireEvent.click(rail.getByRole("button", { name: "專案" }))
  fireEvent.click(within(screen.getByRole("region", { name: "專案" })).getByText("Product").closest("button")!)
  expect(screen.getByRole("navigation", { name: "專案" })).toBe(sidebar)
  expect(screen.getByRole("button", { name: "展開專案 Product" })).toBeTruthy()
  expect(tree.scrollTop).toBe(60)
  fireEvent.click(rail.getByRole("button", { name: "首頁" }))
  fireEvent.click(rail.getByRole("button", { name: "首頁" }))
  expect(screen.getByRole("navigation", { name: "專案" })).toBe(sidebar)
  expect(view.container.querySelectorAll(".project-sidebar")).toHaveLength(1)
  expect(view.container.querySelector(".home-sidebar")).toBeNull()
})

it("shares the original workspace opening list with the expanded project tree", async () => {
  vi.useFakeTimers()
  useUiStore.setState({ surface: "conversation", sidebarCollapsed: false, reviewOpen: false })
  const listing = Promise.withResolvers<{ sessions: { id: string; title: string; live: boolean }[] }>()
  const request: DesktopBridge["request"] = vi.fn(async input => {
    switch (input.kind) {
      case "workspace/list": return [{ id: "w", path: "D:/fixture", label: "Folder" }]
      case "projects/list": return [{ id: "p", name: "Product", workspaceIds: ["w"], primaryWorkspaceId: "w" }]
      case "desktop/capabilities": return { "desktop-sessions": ["1"] }
      case "session/dashboard": return listing.promise
      case "session/list": return { sessions: [] }
      case "desktop/session/navigation/state": return { s: { projectId: "p", pinned: false, unread: false } }
      default: return {}
    }
  })
  await act(async () => { render(<App bridge={{ request, onEvent: () => () => {} }} />) })
  expect(screen.getByRole("button", { name: "收合專案 Product" })).toBeTruthy()
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  const calls = () => vi.mocked(request).mock.calls.map(([input]) => input.kind)
  expect(calls().filter(kind => kind === "session/dashboard")).toHaveLength(1)
  expect(calls()).not.toContain("desktop/session/navigation/state")
  await act(async () => { listing.resolve({ sessions: [{ id: "s", title: "Confirmed conversation", live: false }] }) })
  expect(screen.getByText("Confirmed conversation")).toBeTruthy()
  const ownerReads = () => vi.mocked(request).mock.calls.map(([input]) => input).filter(input => input.kind === "desktop/session/navigation/state")
  expect(ownerReads()).toEqual([{ kind: "desktop/session/navigation/state", workspaceId: "w", includeCoverage: true }])

  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "管理會話…" })) })
  expect(screen.getByRole("dialog", { name: "管理會話" })).toBeTruthy()
  expect(ownerReads()).toEqual([
    { kind: "desktop/session/navigation/state", workspaceId: "w", includeCoverage: true },
    { kind: "desktop/session/navigation/state", workspaceId: "w" },
  ])
})

it("shares the workspace's saved and live listings while the clicked conversation's project is being confirmed", async () => {
  vi.useFakeTimers()
  useUiStore.setState({ surface: "conversation", sidebarCollapsed: false, reviewOpen: false })
  const connected = Promise.withResolvers<Record<string, string[]>>()
  const live = Promise.withResolvers<unknown>()
  const binding = Promise.withResolvers<{ projectId: string }>()
  const listeners = new Set<Parameters<DesktopBridge["onEvent"]>[0]>()
  const request: DesktopBridge["request"] = vi.fn(async input => {
    switch (input.kind) {
      case "workspace/list": return [{ id: "w", path: "D:/fixture", label: "Folder" }]
      case "projects/list": return [{ id: "p", name: "Product", workspaceIds: ["w"], primaryWorkspaceId: "w" }]
      case "desktop/capabilities": return connected.promise
      case "session/dashboard": return input.opening ? { sessions: [{ id: "s", title: "Saved row", live: false }], committedOnly: true } : live.promise
      case "desktop/session/navigation/state": return { s: { projectId: "p", pinned: false, unread: false } }
      case "desktop/session/project/state": return binding.promise
      case "session/model/state": return { status: "unconfigured", reason: "fixture" }
      case "session/history": return { events: [], nextSeq: 0 }
      case "desktop/interaction/pending": case "session/queue": case "session/tasks": return []
      default: return {}
    }
  })
  const bridge: DesktopBridge = { request, onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener) } } }
  await act(async () => { render(<App bridge={bridge} />) })
  await act(async () => { await vi.advanceTimersByTimeAsync(50) })
  await act(async () => { fireEvent.click(screen.getByText("Saved row").closest("button")!) })
  const listings = () => vi.mocked(request).mock.calls.flatMap(([input]) => input.kind === "session/dashboard" ? [input] : [])
  await act(async () => { await vi.advanceTimersByTimeAsync(250) })
  expect(listings()).toEqual([{ kind: "session/dashboard", workspaceId: "w", opening: true }])
  await act(async () => {
    for (const listener of listeners) listener({ kind: "sdk/ready", method: "sdk/ready", workspaceId: "w", runtimeGeneration: 1 })
    connected.resolve({ "desktop-project-scope": ["1"] })
  })
  await act(async () => { await vi.advanceTimersByTimeAsync(300) })
  expect(listings()).toHaveLength(2)
  await act(async () => {
    live.resolve({ sessions: [{ id: "s", title: "Live row", live: true }] })
    binding.resolve({ projectId: "p" })
    await vi.advanceTimersByTimeAsync(300)
  })
  expect(screen.getAllByText("Live row").length).toBeGreaterThan(0)
  expect(listings()).toHaveLength(2)
})

it("refreshes only the original folder when a sidebar selection clears its unread badge", async () => {
  vi.useFakeTimers()
  useUiStore.setState({ surface: "conversation", sidebarCollapsed: false, reviewOpen: false })
  const folders = ["A", "B", "C"].map(id => ({ id, path: `D:/fixture/${id}`, label: `Folder ${id}` }))
  const projects = folders.map(({ id }) => ({ id: `p${id}`, name: `Project ${id}`, workspaceIds: [id], primaryWorkspaceId: id, createdAt: "2026-10-10", updatedAt: "2026-10-10" }))
  const unreadWrite = Promise.withResolvers<void>()
  let unread = true
  const request = vi.fn<DesktopBridge["request"]>(async input => {
    if (input.kind === "session/dashboard") return { sessions: [{ id: "chat", title: `Chat ${input.workspaceId}`, live: false }] }
    if (input.kind === "desktop/session/navigation/state") return { chat: { projectId: `p${input.workspaceId}`, pinned: false, unread: input.workspaceId === "A" && unread } }
    return {}
  })
  const manage = vi.fn(async () => { await unreadWrite.promise; unread = false })
  const select = vi.fn()
  render(<Workbench bridge={{ request, onEvent: () => () => {} }} workspaces={folders} projects={projects}
    selectedProjectId="pA" selectedWorkspaceId="A" selectedSessionId="chat" capabilities={{ "desktop-sessions": ["1"] }}
    onSelectWorkspace={() => {}} onSelectSession={() => {}} onSelectSessionInWorkspace={select} onManageSessionInWorkspace={manage} />)
  fireEvent.click(screen.getByRole("button", { name: "展開專案 Project B" }))
  await act(async () => { await vi.advanceTimersByTimeAsync(300) })
  const sidebar = within(screen.getByRole("navigation", { name: "專案" }))
  const originalOtherRow = sidebar.getByText("Chat B")
  expect(sidebar.queryByText("Chat C")).toBeNull()
  const catalogReads = () => request.mock.calls.map(([input]) => input).filter(input => input.kind === "session/dashboard" || input.kind === "desktop/session/navigation/state")
  expect(catalogReads().filter(input => input.workspaceId === "B").map(input => input.kind)).toEqual(["session/dashboard", "desktop/session/navigation/state"])
  expect(catalogReads().filter(input => input.workspaceId === "C").map(input => input.kind)).toEqual(["desktop/session/navigation/state"])
  request.mockClear()

  const originalRow = within(sidebar.getByText("Chat A").closest("li")!)
  fireEvent.click(originalRow.getByText("Chat A"))
  expect(select).toHaveBeenCalledWith("A", "chat", "pA")
  expect(manage).toHaveBeenCalledWith("A", "chat", "read")
  expect(originalRow.getByLabelText("未讀")).toBeTruthy()
  await act(async () => { unreadWrite.resolve() })
  await act(async () => { await vi.advanceTimersByTimeAsync(300) })

  expect(originalRow.queryByLabelText("未讀")).toBeNull()
  expect(sidebar.getByText("Chat B")).toBe(originalOtherRow)
  expect(catalogReads().map(input => `${input.workspaceId}:${input.kind}`)).toEqual(["A:session/dashboard", "A:desktop/session/navigation/state"])
})

it("keeps moved and archived manager rows tied to their original storage folder", async () => {
  vi.useFakeTimers()
  useUiStore.setState({ surface: "conversation", sidebarCollapsed: false, reviewOpen: false })
  const folders = ["A", "B"].map(id => ({ id, path: `D:/fixture/${id}`, label: `Folder ${id}` }))
  const projects = folders.map(({ id }) => ({ id: `p${id}`, name: `Project ${id}`, workspaceIds: [id], primaryWorkspaceId: id, createdAt: "2026-10-10", updatedAt: "2026-10-10" }))
  let owner = "pA", archived = false
  const request = vi.fn<DesktopBridge["request"]>(async input => {
    if (input.kind === "session/dashboard" || input.kind === "session/list") {
      return { sessions: input.workspaceId === "A" && !archived ? [{ id: "chat", title: "Chat A", live: false }] : [] }
    }
    if (input.kind === "desktop/session/navigation/state") {
      return input.workspaceId === "A" ? { chat: { projectId: owner, pinned: false, unread: false } } : {}
    }
    return {}
  })
  const batch = vi.fn<NonNullable<import("../src/renderer/shell/Workbench.tsx").WorkbenchProps["onBatchSessions"]>>(async (workspaceId, command) => {
    expect(workspaceId).toBe("A")
    if (command.action === "move") owner = command.projectId!
    else if (command.action === "archive") archived = true
    return { results: [{ sessionId: "chat", ok: true, projectId: owner }] }
  })
  render(<Workbench bridge={{ request, onEvent: () => () => {} }} workspaces={folders} projects={projects}
    selectedProjectId="pA" selectedWorkspaceId="A" capabilities={{ "desktop-sessions": ["1"] }}
    onSelectWorkspace={() => {}} onSelectSession={() => {}} onManageSessionInWorkspace={async () => {}} onBatchSessions={batch} />)
  const sidebar = within(screen.getByRole("navigation", { name: "專案" }))
  const group = (id: string) => within(sidebar.getByRole("button", { name: `Project ${id}` }).closest("li")!)
  fireEvent.click(sidebar.getByRole("button", { name: "展開專案 Project B" }))
  await act(async () => { await vi.advanceTimersByTimeAsync(300) })
  const source = group("A"), destination = group("B")
  expect(source.getByText("Chat A")).toBeTruthy()
  expect(destination.queryByText("Chat A")).toBeNull()

  await act(async () => { fireEvent.click(sidebar.getByRole("button", { name: "管理會話…" })) })
  const dialog = within(screen.getByRole("dialog", { name: "管理會話" }))
  const getChecked = () => dialog.getByRole("checkbox", { name: "選取 Chat A" })
  const refreshedSource = () => request.mock.calls.map(([input]) => input).filter(input => input.kind === "session/dashboard" || input.kind === "desktop/session/navigation/state").map(input => input.workspaceId)
  request.mockClear()
  fireEvent.click(getChecked())
  fireEvent.click(dialog.getByRole("button", { name: "目的專案" }))
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Project B" }))
  fireEvent.click(dialog.getByRole("button", { name: "移動所選會話" }))
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "確認移動" })); await vi.advanceTimersByTimeAsync(300) })
  await act(async () => { await vi.advanceTimersByTimeAsync(300) })
  expect(batch).toHaveBeenCalledWith("A", { action: "move", sessionIds: ["chat"], projectId: "pB", expectedOwners: { chat: "pA" } })
  expect(refreshedSource()).toEqual(["A", "A", "A"])
  expect(source.queryByText("Chat A")).toBeNull()
  expect(destination.getByText("Chat A")).toBeTruthy()

  // The manager still lists the original storage row after its owner changes.
  request.mockClear()
  fireEvent.click(getChecked())
  fireEvent.click(dialog.getByRole("button", { name: "封存所選會話" }))
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "確認批次封存" })); await vi.advanceTimersByTimeAsync(300) })
  await act(async () => { await vi.advanceTimersByTimeAsync(300) })
  expect(batch).toHaveBeenCalledWith("A", { action: "archive", sessionIds: ["chat"] })
  expect(refreshedSource()).toEqual(["A", "A", "A"])
  expect(dialog.queryByRole("checkbox", { name: "選取 Chat A" })).toBeNull()
  fireEvent.click(dialog.getByRole("button", { name: "關閉" }))
  expect(sidebar.queryByText("Chat A")).toBeNull()
})
