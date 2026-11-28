// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useState } from "react"
import type { ProjectEntry } from "../src/main/projects.ts"
import type { WorkspaceEntry } from "../src/main/workspaces.ts"
import type { DesktopRequest } from "../src/shared/bridge.ts"
import { useLocale } from "../src/renderer/design/i18n.ts"
import { WorkspaceSettings } from "../src/renderer/projects/ProjectSettings.tsx"
import { SettingsPane } from "../src/renderer/settings/SettingsPane.tsx"

const folders: WorkspaceEntry[] = [
  { id: "a", label: "API", path: "D:/source/api" },
  { id: "b", label: "Website", path: "D:/source/web" },
  { id: "c", label: "Unassigned", path: "D:/local" },
  { id: "w", label: "Feature", path: "D:/trees/feature", worktree: {
    projectId: "p", sourceWorkspaceId: "a", gitCommonDir: "D:/source/api/.git", gitDir: "D:/source/api/.git/worktrees/feature", kind: "imported",
  } },
]
const projects: ProjectEntry[] = [
  { id: "p", name: "Product", workspaceIds: ["a", "b"], primaryWorkspaceId: "a", createdAt: "2026-10-01", updatedAt: "2026-10-02" },
  { id: "s", name: "Shared", workspaceIds: ["b"], primaryWorkspaceId: "b", createdAt: "2026-10-01", updatedAt: "2026-10-02" },
]
function catalog() {
  return { bridge: { request: vi.fn(async (_input: DesktopRequest) => undefined), onEvent: () => () => {} }, onChanged: vi.fn(async () => {}), projects, workspaces: folders }
}
beforeEach(() => { useLocale.getState().setLocale("en"); localStorage.setItem("ih:settings-section", "projects") })
afterEach(() => { cleanup(); useLocale.getState().setLocale("zh-TW"); localStorage.removeItem("ih:settings-section") })

it("browses folders without connecting and loads only the chosen member when opening project extensions", async () => {
  const props = catalog()
  const open = vi.fn()
  render(<SettingsPane bridge={props.bridge} catalog={props} onOpenProject={open} onClose={() => {}} />)
  props.bridge.request.mockClear()
  fireEvent.change(screen.getByRole("searchbox", { name: "Search projects" }), { target: { value: "/api" } })
  expect(screen.queryByText("Shared")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: /Product/ }))
  fireEvent.click(screen.getByRole("button", { name: "Workspaces" }))
  expect(screen.getByText("Primary folder")).toBeTruthy()
  expect(screen.getByText("Member folder")).toBeTruthy()
  expect(screen.queryByText("Unassigned")).toBeNull()
  expect(screen.getByText(/Imported Git worktree/)).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Manage folders" }))
  const dialog = screen.getByRole("dialog", { name: "Manage folders" })
  expect(within(dialog).getByText(/Removing a folder unlinks it from this project/)).toBeTruthy()
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove folder API" }))
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
  expect(screen.getByText("Primary folder")).toBeTruthy()
  expect(props.bridge.request).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Extensions" }))
  await waitFor(() => expect(props.bridge.request.mock.calls.map(([input]) => input)).toEqual([{ kind: "desktop/capabilities", workspaceId: "a" }]))
  expect(open).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "General" }))
  fireEvent.click(screen.getByRole("button", { name: "Open project" }))
  expect(open).toHaveBeenCalledWith(projects[0])
  fireEvent.click(screen.getByRole("button", { name: "Back to all projects" }))
  expect(screen.getByRole("searchbox", { name: "Search projects" })).toHaveProperty("value", "/api")
})

it("shows shared membership once per folder and updates only the selected worktree's availability", async () => {
  const props = catalog()
  render(<WorkspaceSettings {...props} />)
  expect(screen.getAllByRole("listitem")).toHaveLength(4)
  const shared = screen.getByText("Website").closest("li")!
  expect(within(shared).getByText(/Product · Member folder.*Shared · Primary folder/)).toBeTruthy()
  expect(screen.getByText("No project")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Hide from new conversations" }))
  await waitFor(() => expect(props.onChanged).toHaveBeenCalledOnce())
  expect(props.bridge.request.mock.calls).toEqual([[{ kind: "desktop/worktrees/offer", workspaceId: "w", projectId: "p", offered: false }]])
})

it("reflects create, rename and removal in both the settings heading and its single project navigation", async () => {
  let saved: ProjectEntry[] = []
  const bridge = {
    request: async (input: DesktopRequest) => {
      if (input.kind === "projects/save") {
        const row = { ...input.input, id: "created", createdAt: "2026-11-10", updatedAt: saved.length ? "2026-11-11" : "2026-11-10" }
        saved = [row]
        return row
      }
      if (input.kind === "projects/remove") saved = []
      return undefined
    },
    onEvent: () => () => {},
  }
  function Page() {
    const [projects, setProjects] = useState(saved)
    return <SettingsPane bridge={bridge} catalog={{ projects, workspaces: [], onChanged: async () => setProjects(saved) }} onClose={() => {}} />
  }
  render(<Page />)
  fireEvent.click(screen.getByRole("button", { name: "New project" }))
  fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), { target: { value: "First name" } })
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  fireEvent.click(await screen.findByRole("button", { name: /First name/ }))
  expect(screen.getByRole("heading", { name: "First name", level: 1 })).toBeTruthy()
  const nav = within(screen.getByRole("navigation", { name: "Project settings pages" }))
  expect(nav.getByRole("heading", { name: "First name" })).toBeTruthy()
  expect(screen.getAllByRole("button", { name: "Back to all projects" })).toHaveLength(1)
  fireEvent.click(screen.getByRole("button", { name: "Edit project" }))
  fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), { target: { value: "Next name" } })
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  expect(await screen.findByRole("heading", { name: "Next name", level: 1 })).toBeTruthy()
  expect(nav.getByRole("heading", { name: "Next name" })).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Remove local project" }))
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove project" }))
  expect(await screen.findByRole("heading", { name: "Projects", level: 1 })).toBeTruthy()
  expect(screen.queryByRole("navigation", { name: "Project settings pages" })).toBeNull()
  expect(screen.queryByText("Next name")).toBeNull()
  expect(screen.getByRole("button", { name: "New project" })).toBeTruthy()
})

it("saves an empty project's color through the local catalog and refreshes its display without a workspace", async () => {
  const props = catalog()
  const empty = { ...projects[0]!, workspaceIds: [], primaryWorkspaceId: undefined }
  const view = render(<SettingsPane bridge={props.bridge} catalog={{ ...props, projects: [empty], workspaces: [] }} onClose={() => {}} />)
  props.bridge.request.mockClear()
  fireEvent.click(screen.getByRole("button", { name: /Product/ }))
  fireEvent.change(screen.getByRole("combobox", { name: "Project color" }), { target: { value: "green" } })
  await waitFor(() => expect(props.onChanged).toHaveBeenCalledOnce())
  expect(props.bridge.request.mock.calls).toEqual([[{ kind: "projects/appearance", id: empty.id, expectedUpdatedAt: empty.updatedAt, color: "green" }]])
  view.rerender(<SettingsPane bridge={props.bridge} catalog={{ ...props, projects: [{ ...empty, color: "green" }], workspaces: [] }} onClose={() => {}} />)
  expect(screen.getByRole("combobox", { name: "Project color" })).toHaveProperty("value", "green")
  fireEvent.click(screen.getByRole("button", { name: "Back to all projects" }))
  expect(screen.getByRole("button", { name: /Product/ }).querySelector("[data-project-color=green]")).toBeTruthy()
})

it("retains orphan worktrees in the inventory without offering invalid actions", () => {
  const props = catalog()
  render(<WorkspaceSettings {...props} projects={[projects[1]!]} />)
  expect(screen.getByText(/Source folder is no longer in the project/)).toBeTruthy()
  expect(screen.queryByRole("button", { name: "Hide from new conversations" })).toBeNull()
  expect(props.bridge.request).not.toHaveBeenCalled()
})
