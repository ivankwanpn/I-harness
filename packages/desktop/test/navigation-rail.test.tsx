// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { Workbench } from "../src/renderer/shell/Workbench.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"

const original = window.matchMedia
beforeEach(() => {
  useUiStore.setState({ surface: "conversation", sidebarCollapsed: false, reviewOpen: false })
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList)
})
afterEach(() => { cleanup(); window.matchMedia = original; useUiStore.setState({ surface: "conversation", sidebarCollapsed: false }) })
const bridge = { request: async () => undefined, onEvent: () => () => {} }

it("keeps callable navigation and one Settings entry while the project pane is collapsed", () => {
  const onSelectWorkspace = vi.fn(), onProjectsChanged = vi.fn(async () => {})
  render(<Workbench bridge={bridge} workspaces={[{ id: "w", path: "D:/fixture", label: "fixture" }]} selectedWorkspaceId="w" capabilities={{ "session-create": ["1"], "desktop-plugins": ["1"], "desktop-session-search": ["1"] }} onSelectSession={() => {}} onSelectWorkspace={onSelectWorkspace} onProjectsChanged={onProjectsChanged} />)
  const rail = screen.getByRole("navigation", { name: "主導覽" })
  fireEvent.click(screen.getByRole("button", { name: "顯示側欄" }))
  expect(screen.queryByRole("navigation", { name: "專案" })).toBeNull()
  fireEvent.click(within(rail).getByRole("button", { name: "新增會話" }))
  expect(onSelectWorkspace).toHaveBeenCalledWith("w", undefined)
  fireEvent.click(within(rail).getByRole("button", { name: "專案" }))
  expect(screen.getByRole("region", { name: "專案" })).toBeTruthy()
  expect(screen.getByRole("navigation", { name: "主導覽" })).toBe(rail)
  fireEvent.click(within(rail).getByRole("button", { name: "設定" }))
  expect(screen.getByRole("button", { name: "一般" })).toBeTruthy()
  expect(screen.getAllByRole("button", { name: "設定" })).toHaveLength(1)
  expect(screen.queryByText(/登入|帳戶|Login|Account/)).toBeNull()
  fireEvent.click(within(rail).getByRole("button", { name: "插件市場" }))
  expect(useUiStore.getState().surface).toBe("plugins")
  fireEvent.click(within(rail).getByRole("button", { name: "搜尋會話" }))
  expect(useUiStore.getState().surface).toBe("search")
})

it("retains project expansion, selection and tree position across collapsing and Settings navigation", () => {
  const request = vi.fn(async (input: { kind: string }) => input.kind === "desktop/session/project/state" ? {} : undefined)
  const props = { bridge: { request, onEvent: () => () => {} }, projects: [{ id: "p", name: "Project fixture", workspaceIds: ["w"], createdAt: "2026-10-04", updatedAt: "2026-10-04" }], workspaces: [{ id: "w", path: "D:/fixture", label: "fixture" }], selectedProjectId: "p", selectedWorkspaceId: "w", onSelectSession: () => {}, onSelectWorkspace: () => {}, onManageSessionInWorkspace: async () => {}, onProjectsChanged: async () => {}, capabilities: {} }
  const view = render(<Workbench {...props} />)
  fireEvent.click(within(screen.getByRole("navigation", { name: "主導覽" })).getByRole("button", { name: "專案" }))
  fireEvent.click(within(screen.getByRole("region", { name: "專案" })).getByText("Project fixture").closest("button")!)
  const expander = screen.getByRole("button", { name: "收合專案 Project fixture" })
  const project = screen.getByRole("button", { name: "Project fixture" })
  const tree = view.container.querySelector<HTMLElement>(".sidebar-scroll")!
  tree.scrollTop = 140
  fireEvent.click(screen.getByRole("button", { name: "顯示側欄" }))
  fireEvent.click(within(screen.getByRole("navigation", { name: "主導覽" })).getByRole("button", { name: "設定" }))
  fireEvent.click(screen.getByRole("button", { name: "返回會話" }))
  fireEvent.click(screen.getByRole("button", { name: "顯示側欄" }))
  expect(screen.getByRole("button", { name: "收合專案 Project fixture" })).toBe(expander)
  expect(project.getAttribute("aria-current")).toBe("true")
  expect(view.container.querySelector(".sidebar-scroll")).toBe(tree)
  expect(tree.scrollTop).toBe(140)
})

it("omits rail actions without their callback or capability", () => {
  render(<Workbench bridge={bridge} workspaces={[]} capabilities={{}} onSelectSession={() => {}} onSelectWorkspace={() => {}} />)
  const rail = within(screen.getByRole("navigation", { name: "主導覽" }))
  expect(rail.queryByRole("button", { name: "開啟專案" })).toBeNull()
  expect(rail.queryByRole("button", { name: "管理專案" })).toBeNull()
  expect(rail.queryByRole("button", { name: "插件市場" })).toBeNull()
  expect(rail.queryByRole("button", { name: "搜尋會話" })).toBeNull()
  expect((rail.getByRole("button", { name: "新增會話" }) as HTMLButtonElement).disabled).toBe(true)
})

it.each(["cross-workspace", "current-workspace"])("marks Home selections read at their original source without waiting for a successful update (%s)", async mode => {
  const pending = Promise.withResolvers<void>()
  const manage = vi.fn(() => pending.promise), select = vi.fn()
  const source = mode === "cross-workspace" ? "other" : "current"
  render(<Workbench projects={[]} bridge={{ request: async input => input.kind === "desktop/session/navigation/state"
    ? { same: { pinned: false, unread: true } }
    : { sessions: [{ id: "same", title: input.kind === "session/dashboard" ? input.workspaceId : "", live: false }] }, onEvent: () => () => {} }}
    workspaces={[{ id: "current", path: "D:/current", label: "Current" }, { id: "other", path: "D:/other", label: "Other" }]}
    selectedWorkspaceId="current" selectedSessionId="same" capabilities={{}} onSelectWorkspace={() => {}}
    onSelectSession={select} onSelectSessionInWorkspace={mode === "cross-workspace" ? select : undefined}
    onManageSessionInWorkspace={mode === "cross-workspace" ? manage : undefined} onManageSession={mode === "current-workspace" ? manage : undefined} />)
  const home = within(screen.getByRole("navigation", { name: "專案" }))
  fireEvent.click(await home.findByText(source))
  expect(manage).toHaveBeenCalledWith(...(mode === "cross-workspace" ? [source, "same", "read"] : ["same", "read"]))
  expect(select).toHaveBeenCalledWith(...(mode === "cross-workspace" ? [source, "same", undefined] : ["same"]))
  expect(screen.getByRole("navigation", { name: "專案" })).toBeTruthy()
  await act(async () => { pending.reject(new Error("Read-state update failed")); await pending.promise.catch(() => {}) })
  expect(select).toHaveBeenCalledOnce()
})

it("returns to the conversation when clicking Home from Settings", () => {
  render(<Workbench bridge={bridge} workspaces={[]} capabilities={{}} onSelectSession={() => {}} onSelectWorkspace={() => {}} />)
  const rail = screen.getByRole("navigation", { name: "主導覽" })
  fireEvent.click(within(rail).getByRole("button", { name: "設定" }))
  fireEvent.click(within(rail).getByRole("button", { name: "首頁" }))
  expect(screen.getByRole("navigation", { name: "專案" })).toBeTruthy()
  expect(useUiStore.getState().surface).toBe("conversation")
})

it.each(["storage", "secondary"])("starts a project draft in its primary folder when reading a conversation from %s", current => {
  const onSelectWorkspace = vi.fn()
  render(<Workbench bridge={bridge} workspaces={[{ id: "storage", path: "D:/old", label: "Old storage" }, { id: "primary", path: "D:/primary", label: "Primary" }, { id: "secondary", path: "D:/secondary", label: "Secondary" }]}
    projects={[{ id: "p", name: "Product", primaryWorkspaceId: "primary", workspaceIds: ["primary", "secondary"], createdAt: "2026-10-10", updatedAt: "2026-10-10" }]}
    selectedProjectId="p" selectedWorkspaceId={current} selectedSessionId="existing" capabilities={{ "session-create": ["1"] }} onSelectSession={() => {}} onSelectWorkspace={onSelectWorkspace} />)
  const create = within(screen.getByRole("navigation", { name: "主導覽" })).getByRole("button", { name: "新增會話" }) as HTMLButtonElement
  expect(create.disabled).toBe(false)
  fireEvent.click(create)
  expect(onSelectWorkspace).toHaveBeenCalledWith("primary", "p")
})

it("does not infer a current project or Git action from an unassigned conversation's storage folder", () => {
  render(<Workbench bridge={bridge} workspaces={[{ id: "w", path: "D:/shared", label: "Shared folder" }]}
    projects={[{ id: "p", name: "Product", workspaceIds: ["w"], createdAt: "2026-10-10", updatedAt: "2026-10-10" }]}
    selectedWorkspaceId="w" selectedSessionId="legacy" dashboard={{ sessions: [{ id: "legacy", live: false }] }}
    capabilities={{ "desktop-review": ["1"] }} onSelectSession={() => {}} onSelectWorkspace={() => {}} />)
  expect(screen.queryByRole("button", { name: "專案 Git" })).toBeNull()
})

it("does not relabel folder sessions as projects while the catalog loads", () => {
  render(<Workbench bridge={bridge} workspaces={[{ id: "w", path: "D:/folder", label: "Folder must not become project" }]} selectedWorkspaceId="w" dashboard={{ sessions: [{ id: "s", title: "Unclassified data", live: false }] }} onProjectsChanged={async () => {}} capabilities={{}} onSelectSession={() => {}} onSelectWorkspace={() => {}} />)
  expect(screen.getByRole("navigation", { name: "專案" })).toBeTruthy()
  expect(screen.queryByRole("button", { name: "Folder must not become project" })).toBeNull()
  expect(screen.queryByText("Unclassified data")).toBeNull()
})
