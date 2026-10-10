// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { Workbench } from "../src/renderer/shell/Workbench.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"

afterEach(cleanup)
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
