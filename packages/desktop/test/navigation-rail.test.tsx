// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
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
  const onOpenWorkspace = vi.fn(), onSelectWorkspace = vi.fn(), onProjectsChanged = vi.fn(async () => {})
  render(<Workbench bridge={bridge} workspaces={[{ id: "w", path: "D:/fixture", label: "fixture" }]} selectedWorkspaceId="w" capabilities={{ "session-create": ["1"], "desktop-plugins": ["1"], "desktop-session-search": ["1"] }} onSelectSession={() => {}} onSelectWorkspace={onSelectWorkspace} onOpenWorkspace={onOpenWorkspace} onProjectsChanged={onProjectsChanged} />)
  const rail = screen.getByRole("navigation", { name: "主導覽" })
  fireEvent.click(screen.getByRole("button", { name: "顯示側欄" }))
  expect(screen.queryByRole("navigation", { name: "工作區" })).toBeNull()
  fireEvent.click(within(rail).getByRole("button", { name: "新增會話" }))
  expect(onSelectWorkspace).toHaveBeenCalledWith("w", undefined)
  fireEvent.click(within(rail).getByRole("button", { name: "開啟工作區" }))
  expect(onOpenWorkspace).toHaveBeenCalledOnce()
  fireEvent.click(within(rail).getByRole("button", { name: "管理專案" }))
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
  const props = { bridge: { request, onEvent: () => () => {} }, projects: [{ id: "p", name: "Project fixture", workspaceIds: ["w"], createdAt: "2026-10-04", updatedAt: "2026-10-04" }], workspaces: [{ id: "w", path: "D:/fixture", label: "fixture" }], selectedProjectId: "p", selectedWorkspaceId: "w", onSelectSession: () => {}, onSelectWorkspace: () => {}, onManageSessionInWorkspace: async () => {}, capabilities: {} }
  const view = render(<Workbench {...props} />)
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
  expect(rail.queryByRole("button", { name: "開啟工作區" })).toBeNull()
  expect(rail.queryByRole("button", { name: "管理專案" })).toBeNull()
  expect(rail.queryByRole("button", { name: "插件市場" })).toBeNull()
  expect(rail.queryByRole("button", { name: "搜尋會話" })).toBeNull()
  expect((rail.getByRole("button", { name: "新增會話" }) as HTMLButtonElement).disabled).toBe(true)
})
