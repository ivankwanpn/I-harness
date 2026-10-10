// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { Workbench } from "../src/renderer/shell/Workbench.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"
import type { DesktopRequest } from "../src/shared/bridge.ts"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { useState } from "react"

const original = window.matchMedia
beforeEach(() => {
  useUiStore.setState({ surface: "conversation", sidebarCollapsed: false, sidebarWidth: 280, reviewOpen: false })
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList)
})
afterEach(() => { cleanup(); window.matchMedia = original; vi.useRealTimers(); useUiStore.setState({ surface: "conversation", sidebarCollapsed: false }) })
function fixture() {
  const request = vi.fn(async (input: DesktopRequest) => input.kind === "desktop/session/navigation/state" ? { current: { pinned: false, unread: true, projectId: "p" } } : input.kind === "session/dashboard" ? { sessions: [{ id: "current", title: "Current conversation", live: false }] } : undefined)
  const props = { bridge: { request, onEvent: () => () => {} }, projects: [{ id: "p", name: "Product", workspaceIds: ["w"], primaryWorkspaceId: "w", createdAt: "2026-10-10", updatedAt: "2026-10-10" }], workspaces: [{ id: "w", path: "D:/fixture", label: "Folder" }], selectedProjectId: "p", selectedWorkspaceId: "w", selectedSessionId: "current", dashboard: { sessions: [{ id: "current", title: "Current conversation", live: false }] }, capabilities: {}, onSelectSession: vi.fn(), onSelectWorkspace: vi.fn(), onSelectProject: vi.fn(), onSelectSessionInWorkspace: vi.fn(), onManageSessionInWorkspace: vi.fn(async () => {}), onProjectsChanged: vi.fn(async () => {}), conversation: { rows: [], canSend: true, running: false, pending: [], onPrompt: async () => {}, onCancel() {}, onCancelTask() {}, onCancelQueue() {}, onReply: async () => {} } }
  return { props, request }
}
function homeButton() { return within(screen.getByRole("navigation", { name: "主導覽" })).getByRole("button", { name: "首頁" }) }
function openProject() {
  fireEvent.click(within(screen.getByRole("navigation", { name: "主導覽" })).getByRole("button", { name: "專案" }))
  fireEvent.click(within(screen.getByRole("region", { name: "專案" })).getByText("Product").closest("button")!)
}
it("docks Home by default and controls one retained sidebar while keeping the same center and draft DOM", async () => {
  const { props } = fixture(); const view = render(<Workbench {...props} />)
  const center = view.container.querySelector(".center-pane")
  const editor = screen.getByRole("textbox", { name: "提示" }) as HTMLTextAreaElement
  fireEvent.change(editor, { target: { value: "keep my draft" } })
  expect(await within(screen.getByRole("navigation", { name: "首頁側欄" })).findByText("Current conversation")).toBeTruthy()
  expect(screen.queryByRole("navigation", { name: "專案" })).toBeNull()
  expect(view.container.querySelectorAll(".sidebar-container")).toHaveLength(1)
  const slot = view.container.querySelector(".sidebar-container")
  fireEvent.click(homeButton())
  expect(screen.queryByRole("navigation", { name: "首頁側欄" })).toBeNull()
  expect(useUiStore.getState().sidebarCollapsed).toBe(true)
  fireEvent.click(screen.getByRole("button", { name: "顯示側欄" }))
  expect(screen.getByRole("navigation", { name: "首頁側欄" })).toBeTruthy()
  expect(view.container.querySelector(".sidebar-container")).toBe(slot)
  expect(view.container.querySelector(".center-pane")).toBe(center)
  expect(screen.getByRole("textbox", { name: "提示" })).toBe(editor)
  expect(editor.value).toBe("keep my draft")
  expect(props.onSelectSession).not.toHaveBeenCalled(); expect(props.onSelectWorkspace).not.toHaveBeenCalled()
})
it("enters project navigation through the manager and retains both sidebar views and shared width", () => {
  const { props, request } = fixture(); const view = render(<Workbench {...props} />)
  const home = screen.getByRole("navigation", { name: "首頁側欄" })
  fireEvent.click(within(home).getByRole("button", { name: "搜尋最近會話" }))
  fireEvent.change(screen.getByRole("searchbox", { name: "搜尋會話或專案" }), { target: { value: "Product" } })
  fireEvent.keyDown(screen.getByRole("separator", { name: "調整側欄寬度" }), { key: "ArrowRight" })
  const scroll = view.container.querySelector<HTMLElement>(".home-sidebar-scroll")!; scroll.scrollTop = 80
  openProject()
  expect(props.onSelectProject).toHaveBeenCalledWith("p")
  expect(screen.queryByRole("navigation", { name: "首頁側欄" })).toBeNull()
  const projectNav = screen.getByRole("navigation", { name: "專案" })
  const tree = view.container.querySelector<HTMLElement>(".sidebar-scroll")!; tree.scrollTop = 140
  expect(screen.queryByRole("button", { name: "開啟專案" })).toBeNull()
  fireEvent.click(homeButton())
  expect(screen.getByRole("navigation", { name: "首頁側欄" })).toBe(home)
  expect(screen.getByRole("searchbox", { name: "搜尋會話或專案" })).toHaveProperty("value", "Product")
  expect(scroll.scrollTop).toBe(80)
  openProject()
  expect(screen.getByRole("navigation", { name: "專案" })).toBe(projectNav)
  expect(tree.scrollTop).toBe(140)
  expect(view.container.querySelector<HTMLElement>(".workbench")!.style.getPropertyValue("--sidebar-width")).toBe("300px")
  expect(request.mock.calls.some(([input]) => input.kind === "workspace/pick" || input.kind === "projects/save")).toBe(false)
})
it("previews collapsed Home without changing preference or center and cancels dismissal inside the panel", async () => {
  vi.useFakeTimers(); const { props } = fixture(); const view = render(<Workbench {...props} />)
  const center = view.container.querySelector(".center-pane"); fireEvent.click(homeButton())
  fireEvent.pointerEnter(homeButton(), { pointerType: "mouse" }); await act(async () => { vi.advanceTimersByTime(220) })
  const home = screen.getByRole("navigation", { name: "首頁側欄" }); const slot = home.closest(".sidebar-container")!
  expect(slot.classList.contains("sidebar-preview")).toBe(true)
  expect(useUiStore.getState().sidebarCollapsed).toBe(true)
  expect(view.container.querySelector(".center-pane")).toBe(center)
  fireEvent.pointerLeave(homeButton(), { pointerType: "mouse" }); fireEvent.pointerEnter(slot, { pointerType: "mouse" })
  await act(async () => { vi.advanceTimersByTime(220) }); expect(screen.getByRole("navigation", { name: "首頁側欄" })).toBe(home)
  const search = within(home).getByRole("button", { name: "搜尋最近會話" }); act(() => search.focus())
  fireEvent.pointerLeave(slot, { pointerType: "mouse" }); await act(async () => { vi.advanceTimersByTime(220) })
  expect(screen.getByRole("navigation", { name: "首頁側欄" })).toBe(home)
  act(() => search.blur()); fireEvent.pointerLeave(slot, { pointerType: "mouse" }); await act(async () => { vi.advanceTimersByTime(220) })
  expect(screen.queryByRole("navigation", { name: "首頁側欄" })).toBeNull()
  fireEvent.pointerEnter(homeButton(), { pointerType: "mouse" }); await act(async () => { vi.advanceTimersByTime(220) })
  fireEvent.click(homeButton()); expect(useUiStore.getState().sidebarCollapsed).toBe(false)
  expect(view.container.querySelector(".sidebar-preview")).toBeNull()
})
it("does not hover on touch and cancels pending hover when navigating to a page", async () => {
  vi.useFakeTimers(); const { props } = fixture(); render(<Workbench {...props} />); fireEvent.click(homeButton())
  fireEvent.pointerEnter(homeButton(), { pointerType: "touch" }); await act(async () => { vi.advanceTimersByTime(220) })
  expect(screen.queryByRole("navigation", { name: "首頁側欄" })).toBeNull()
  fireEvent.pointerEnter(homeButton(), { pointerType: "mouse" })
  fireEvent.click(within(screen.getByRole("navigation", { name: "主導覽" })).getByRole("button", { name: "專案" }))
  await act(async () => { vi.advanceTimersByTime(220) })
  expect(screen.queryByRole("navigation", { name: "首頁側欄" })).toBeNull()
  expect(screen.getByRole("region", { name: "專案" })).toBeTruthy()
})
it.each(["outside", "Escape"])("opens an accessible narrow Home drawer and restores focus after %s dismissal", dismissal => {
  window.matchMedia = vi.fn(query => ({ matches: query === "(max-width: 759px)", addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList)
  const { props } = fixture(); const view = render(<Workbench {...props} />); const editor = screen.getByRole("textbox", { name: "提示" })
  homeButton().focus(); fireEvent.click(homeButton())
  expect(screen.getByRole("dialog", { name: "首頁" }).getAttribute("aria-modal")).toBe("true")
  expect(screen.getByRole("navigation", { name: "首頁側欄" })).toBeTruthy()
  expect(document.activeElement).not.toBe(homeButton())
  if (dismissal === "outside") fireEvent.pointerDown(editor)
  else fireEvent.keyDown(document, { key: "Escape" })
  expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(homeButton())
  expect(screen.getByRole("textbox", { name: "提示" })).toBe(editor)
  expect(view.container.querySelectorAll(".sidebar-container")).toHaveLength(1)
})
it("routes the no-workspace welcome action into project management without native picking", () => {
  const { props, request } = fixture()
  render(<Workbench {...props} projects={[]} workspaces={[]} selectedWorkspaceId={undefined} selectedSessionId={undefined} />)
  fireEvent.click(within(screen.getByRole("main")).getByRole("button", { name: "專案" }))
  expect(screen.getByRole("region", { name: "專案" })).toBeTruthy()
  expect(request.mock.calls.some(([input]) => input.kind === "workspace/pick" || input.kind === "projects/save")).toBe(false)
})

it.each(["outside", "Escape"])("dismisses wide temporary preview via %s without saving a collapse change", async dismissal => {
  vi.useFakeTimers(); const { props } = fixture(); render(<Workbench {...props} />)
  fireEvent.click(homeButton()); fireEvent.pointerEnter(homeButton(), { pointerType: "mouse" })
  await act(async () => { vi.advanceTimersByTime(220) })
  expect(screen.getByRole("navigation", { name: "首頁側欄" })).toBeTruthy()
  if (dismissal === "outside") fireEvent.pointerDown(screen.getByRole("textbox", { name: "提示" }))
  else fireEvent.keyDown(document, { key: "Escape" })
  expect(screen.queryByRole("navigation", { name: "首頁側欄" })).toBeNull()
  expect(useUiStore.getState().sidebarCollapsed).toBe(true)
})
it("keeps the shared preview out of the layout grid under the real sidebar CSS cascade", async () => {
  const style = document.createElement("style")
  style.textContent = readFileSync(resolve(import.meta.dirname, "../src/renderer/design/tokens.css"), "utf8")
  document.head.append(style)
  try {
    vi.useFakeTimers(); const { props } = fixture(); const view = render(<Workbench {...props} />)
    fireEvent.click(homeButton()); fireEvent.pointerEnter(homeButton(), { pointerType: "mouse" })
    await act(async () => { vi.advanceTimersByTime(220) })
    const slot = view.container.querySelector<HTMLElement>(".sidebar-container")!
    expect(window.getComputedStyle(slot).position).toBe("absolute")
    expect(useUiStore.getState().sidebarCollapsed).toBe(true)
  } finally { style.remove() }
})
it("keeps overflowing new-task content anchored at the scroll origin in short windows", () => {
  const style = document.createElement("style")
  style.textContent = readFileSync(resolve(import.meta.dirname, "../src/renderer/design/tokens.css"), "utf8")
  document.head.append(style)
  try {
    const { props } = fixture()
    const view = render(<Workbench {...props} selectedSessionId={undefined} conversation={undefined} />)
    const empty = view.container.querySelector<HTMLElement>(".empty-conversation")!
    expect(window.getComputedStyle(empty).overflowY).toBe("auto")
    // Centering oversized flex content clips its leading edge above the scroll
    // origin. Top alignment keeps the introduction and composer reachable.
    expect(window.getComputedStyle(empty).justifyContent).toBe("flex-start")
  } finally { style.remove() }
})
it("retains project conversation management and original-source selection in the shared slot", async () => {
  const { props } = fixture(); render(<Workbench {...props} />); openProject()
  const projectNavigation = screen.getByRole("navigation", { name: "專案" })
  const row = (await within(projectNavigation).findByText("Current conversation")).closest("button")!
  fireEvent.click(row)
  expect(props.onSelectSessionInWorkspace).toHaveBeenCalledWith("w", "current", "p")
  expect(props.onManageSessionInWorkspace).toHaveBeenCalledWith("w", "current", "read")
  fireEvent.click(within(projectNavigation).getByRole("button", { name: "更多會話操作 Current conversation" }))
  expect(within(screen.getByRole("menu", { name: "會話操作" })).getByRole("menuitem", { name: "重新命名" })).toBeTruthy()
  expect(screen.getByRole("navigation", { name: "專案" })).toBe(projectNavigation)
})
it("refreshes retained Home unread metadata after a successful native read without a notification", async () => {
  const { props } = fixture()
  let unread = true
  props.bridge.request = vi.fn(async input => input.kind === "desktop/session/navigation/state" ? { current: { pinned: false, unread, projectId: "p" } } : input.kind === "session/dashboard" ? props.dashboard : undefined)
  props.onManageSessionInWorkspace = vi.fn(async () => { unread = false })
  render(<Workbench {...props} />)
  const home = screen.getByRole("navigation", { name: "首頁側欄" })
  const row = (await within(home).findByText("Current conversation")).closest("button")!
  expect(within(home).getByLabelText("未讀")).toBeTruthy()
  fireEvent.click(row)
  await waitFor(() => expect(within(home).queryByLabelText("未讀")).toBeNull())
  expect(screen.getByRole("navigation", { name: "首頁側欄" })).toBe(home)
  expect(props.onManageSessionInWorkspace).toHaveBeenCalledWith("w", "current", "read")
})
it("keeps source-folder batch and archive management discoverable without projects or a project-manager callback", async () => {
  const request = vi.fn(async (input: DesktopRequest) => input.kind === "desktop/session/navigation/state" ? {} : input.kind === "session/list" ? { sessions: [] } : input.kind === "desktop/session/archived" ? [] : undefined)
  render(<Workbench bridge={{ request, onEvent: () => () => {} }} workspaces={[{ id: "legacy", label: "Legacy source", path: "D:/owned-legacy" }]} selectedWorkspaceId="legacy" capabilities={{ "desktop-sessions": ["1"] }} onManageSession={async () => {}} onSelectSession={() => {}} onSelectWorkspace={() => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "批次管理會話" }))
  expect(screen.getByRole("dialog", { name: "管理會話" })).toBeTruthy()
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ kind: "session/list", workspaceId: "legacy" }))
  fireEvent.click(screen.getByRole("button", { name: "關閉" }))
  fireEvent.click(screen.getByRole("button", { name: "管理已封存會話" }))
  expect(screen.getByRole("dialog", { name: "管理會話" })).toBeTruthy()
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ kind: "desktop/session/archived", workspaceId: "legacy" }))
})
it.each(["different", "initial"] as const)("keeps explicit narrow project navigation open when the stateful parent selects a %s source folder", initial => {
  window.matchMedia = vi.fn(query => ({ matches: query === "(max-width: 759px)", addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList)
  const { props } = fixture()
  function StatefulParent() {
    const [workspaceId, setWorkspaceId] = useState<string | undefined>(initial === "different" ? "previous" : undefined)
    const [projectId, setProjectId] = useState<string>()
    return <Workbench {...props} workspaces={[...props.workspaces, { id: "previous", label: "Previous source", path: "D:/previous-fixture" }]} selectedWorkspaceId={workspaceId} selectedProjectId={projectId} selectedSessionId={undefined} conversation={undefined} onSelectProject={id => {
      const project = props.projects.find(row => row.id === id)!
      setProjectId(id); setWorkspaceId(project.primaryWorkspaceId)
    }} />
  }
  render(<StatefulParent />); openProject()
  const drawer = screen.getByRole("dialog", { name: "專案" })
  expect(within(drawer).getByRole("navigation", { name: "專案" })).toBeTruthy()
  expect(within(drawer).getByRole("button", { name: "Product" }).getAttribute("aria-current")).toBe("true")
  expect(screen.getByTestId("session-header").textContent).toContain("Product")
  expect(useUiStore.getState().sidebarCollapsed).toBe(false)
})
it.each([
  ["wide preview", "批次管理會話", "session/list"],
  ["wide preview", "管理已封存會話", "desktop/session/archived"],
  ["narrow drawer", "批次管理會話", "session/list"],
  ["narrow drawer", "管理已封存會話", "desktop/session/archived"],
] as const)("keeps %s management return focus valid after opening %s in a real inert root", async (layout, action, kind) => {
  window.matchMedia = vi.fn(query => ({ matches: layout === "narrow drawer" && query === "(max-width: 759px)", addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList)
  vi.useFakeTimers()
  const { props, request } = fixture()
  props.bridge.request = vi.fn(async input => input.kind === "session/list" ? { sessions: [] } : input.kind === "desktop/session/archived" ? [] : request(input))
  const root = document.createElement("div"); root.id = "root"; document.body.append(root)
  const view = render(<Workbench {...props} capabilities={{ "desktop-sessions": ["1"] }} />, { container: root })
  try {
    homeButton().focus()
    if (layout === "wide preview") {
      fireEvent.click(homeButton()); fireEvent.pointerEnter(homeButton(), { pointerType: "mouse" })
      await act(async () => { vi.advanceTimersByTime(220) })
    } else fireEvent.click(homeButton())
    const home = screen.getByRole("navigation", { name: "首頁側欄" })
    const trigger = within(home).getByRole("button", { name: action })
    act(() => trigger.focus()); fireEvent.click(trigger)
    const dialog = screen.getByRole("dialog", { name: "管理會話" })
    expect(root.hasAttribute("inert")).toBe(true)
    expect(root.contains(dialog)).toBe(false)
    const control = within(dialog).getByRole("button", { name: "目前會話" })
    fireEvent.pointerDown(control); act(() => control.focus())
    await act(async () => { vi.advanceTimersByTime(220) })
    expect(home.closest<HTMLElement>(".sidebar-container")!.hidden).toBe(false)
    expect(props.bridge.request).toHaveBeenCalledWith({ kind, workspaceId: "w" })
    fireEvent.click(within(dialog).getByRole("button", { name: "關閉" }))
    expect(root.hasAttribute("inert")).toBe(false)
    expect(document.activeElement).toBe(trigger)
    expect(screen.getByRole("navigation", { name: "首頁側欄" })).toBe(home)
    fireEvent.pointerDown(screen.getByRole("textbox", { name: "提示" }))
    expect(screen.queryByRole("navigation", { name: "首頁側欄" })).toBeNull()
    expect(useUiStore.getState().sidebarCollapsed).toBe(layout === "wide preview")
  } finally { view.unmount(); root.remove() }
})
