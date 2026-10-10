// @vitest-environment jsdom
import { useState } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { Workbench, type WorkbenchProps } from "../src/renderer/shell/Workbench.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"
import { useLocale } from "../src/renderer/design/i18n.ts"
import { clearDraft } from "../src/renderer/session/Composer.tsx"

const workspaces = [{ id: "ctx-a", label: "Storage A", path: "D:/a" }, { id: "ctx-b", label: "Primary B", path: "D:/b" }]
const projects = [
  { id: "ctx-p1", name: "Product A", workspaceIds: ["ctx-a"], primaryWorkspaceId: "ctx-a", createdAt: "2026-10-10", updatedAt: "2026-10-10" },
  { id: "ctx-p2", name: "Product B", workspaceIds: ["ctx-a", "ctx-b"], primaryWorkspaceId: "ctx-b", createdAt: "2026-10-10", updatedAt: "2026-10-10" },
]
const request = vi.fn(async (input: { kind: string }) => input.kind === "session/dashboard" ? { sessions: [] } : input.kind === "desktop/session/navigation/state" ? {} : [])
const bridge = { request, onEvent: () => () => {} }
const base: WorkbenchProps = { bridge, projects, workspaces, selectedWorkspaceId: "ctx-a", selectedProjectId: "ctx-p1", capabilities: {}, onSelectWorkspace() {}, onSelectSession() {}, onProjectsChanged: async () => {}, onSelectProject() {} }
beforeEach(() => { useLocale.getState().setLocale("zh-TW"); useUiStore.setState({ surface: "conversation", sidebarCollapsed: true, reviewOpen: false }); request.mockClear() })
afterEach(() => { cleanup(); for (const folder of workspaces) for (const project of projects) clearDraft(folder.id, `new-task:${project.id}`) })

it("keeps each project's draft while picking a project and its primary folder from the composer", async () => {
  const selected = vi.fn()
  function Harness() {
    const [projectId, setProject] = useState("ctx-p1")
    const project = projects.find(row => row.id === projectId)!
    return <Workbench {...base} selectedProjectId={projectId} selectedWorkspaceId={project.primaryWorkspaceId} onSelectProject={id => { selected(id); setProject(id) }} />
  }
  render(<Harness />)
  const context = within(screen.getByRole("group", { name: "會話專案" }))
  expect(context.getByText("Product A")).toBeTruthy()
  fireEvent.change(screen.getByRole("textbox", { name: "提示" }), { target: { value: "A draft" } })
  fireEvent.click(context.getByRole("button", { name: "選擇會話專案" }))
  const picker = within(screen.getByRole("dialog", { name: "選擇專案" }))
  fireEvent.change(picker.getByRole("searchbox", { name: "搜尋專案" }), { target: { value: "Product B" } })
  fireEvent.click(picker.getByRole("button", { name: /Product B/ }))
  expect(selected).toHaveBeenLastCalledWith("ctx-p2")
  expect(context.getByText("Product B")).toBeTruthy()
  expect(screen.getByRole("textbox", { name: "提示" })).toHaveProperty("value", "")
  fireEvent.change(screen.getByRole("textbox", { name: "提示" }), { target: { value: "B draft" } })
  fireEvent.click(context.getByRole("button", { name: "選擇會話專案" }))
  fireEvent.click(within(screen.getByRole("dialog", { name: "選擇專案" })).getByRole("button", { name: /Product A/ }))
  expect(screen.getByRole("textbox", { name: "提示" })).toHaveProperty("value", "A draft")
  expect(request.mock.calls.some(([input]) => input.kind === "session/create")).toBe(false)
})

it.each([
  [{ status: "ready", projectId: "ctx-p2", projectName: "Product B" }, "Product B"],
  [{ status: "ready" }, "不在專案中"],
  [{ status: "ready", projectId: "removed" }, "專案已移除"],
  [{ status: "loading" }, "正在確認專案…"],
  [{ status: "unavailable" }, "專案歸屬無法確認"],
] as const)("shows authoritative existing ownership %j without exposing a move action", (projectContext, label) => {
  const select = vi.fn()
  render(<Workbench {...base} selectedSessionId="existing" projectContext={projectContext} onSelectProject={select}
    conversation={{ rows: [], canSend: false, running: false, pending: [], onPrompt: async () => {}, onCancel() {}, onCancelTask() {}, onCancelQueue() {}, onReply: async () => {} }} />)
  const context = within(screen.getByRole("group", { name: "會話專案" }))
  expect(context.getByText(label)).toBeTruthy()
  expect(context.queryByRole("button", { name: "選擇會話專案" })).toBeNull()
  expect(select).not.toHaveBeenCalled()
})

it("offers existing project selection before a workspace is selected, and routes management to its page", () => {
  render(<Workbench {...base} selectedWorkspaceId={undefined} selectedProjectId={undefined} />)
  fireEvent.click(within(screen.getByRole("group", { name: "會話專案" })).getByRole("button", { name: "選擇會話專案" }))
  fireEvent.click(within(screen.getByRole("dialog", { name: "選擇專案" })).getByRole("button", { name: "管理專案" }))
  expect(screen.getByRole("region", { name: "專案" })).toBeTruthy()
  expect(request.mock.calls.some(([input]) => input.kind === "workspace/pick" || input.kind === "projects/save")).toBe(false)
})

it("searches by folder, supports keyboard selection and restores focus on Escape", () => {
  const select = vi.fn()
  render(<Workbench {...base} onSelectProject={select} />)
  const trigger = within(screen.getByRole("group", { name: "會話專案" })).getByRole("button", { name: "選擇會話專案" })
  fireEvent.click(trigger)
  const search = within(screen.getByRole("dialog", { name: "選擇專案" })).getByRole("searchbox", { name: "搜尋專案" })
  expect(document.activeElement).toBe(search)
  fireEvent.change(search, { target: { value: "D:/b" } })
  fireEvent.keyDown(search, { key: "ArrowDown" })
  expect(document.activeElement?.textContent).toContain("Product B")
  fireEvent.keyDown(document.activeElement!, { key: "Escape" })
  expect(screen.queryByRole("dialog", { name: "選擇專案" })).toBeNull()
  expect(document.activeElement).toBe(trigger)
  expect(select).not.toHaveBeenCalled()
})

it("explicitly starts an unassigned draft at the current source without moving an existing conversation", () => {
  const select = vi.fn()
  render(<Workbench {...base} onSelectWorkspace={select} />)
  fireEvent.click(screen.getByRole("button", { name: "選擇會話專案" }))
  fireEvent.click(within(screen.getByRole("dialog", { name: "選擇專案" })).getByRole("button", { name: "不在專案中工作" }))
  expect(select).toHaveBeenCalledWith("ctx-a", undefined)
  expect(request.mock.calls.some(([input]) => input.kind === "desktop/session/project/bind")).toBe(false)
})

it("disables project switching while a native draft creation is awaiting admission", async () => {
  const pending = Promise.withResolvers<unknown>(), select = vi.fn()
  const native = vi.fn(async (input: { kind: string }) => {
    if (input.kind === "desktop/provider/directory") return [{ id: "fixture", displayName: "Fixture", configured: true, models: [{ id: "fixture-model" }] }]
    if (input.kind === "session/create") return pending.promise
    return request(input)
  })
  render(<Workbench {...base} bridge={{ request: native, onEvent: () => () => {} }} onSelectProject={select}
    capabilities={{ "session-create": ["1"], "desktop-input": ["1"], "desktop-draft-create": ["1"] }} />)
  fireEvent.click(screen.getByRole("button", { name: /選擇模型/ }))
  fireEvent.click(await within(screen.getByRole("dialog", { name: "選擇模型" })).findByRole("button", { name: "fixture-model" }))
  fireEvent.change(screen.getByRole("textbox", { name: "提示" }), { target: { value: "Owned draft" } })
  fireEvent.click(screen.getByRole("button", { name: "送出" }))
  await waitFor(() => expect(native.mock.calls.some(([input]) => input.kind === "session/create")).toBe(true))
  expect(screen.getByRole("button", { name: "選擇會話專案" })).toHaveProperty("disabled", true)
  await act(async () => { pending.reject(new Error("Fixture admission failed")); await pending.promise.catch(() => {}) })
  await waitFor(() => expect(screen.getByRole("button", { name: "選擇會話專案" })).toHaveProperty("disabled", false))
  expect(select).not.toHaveBeenCalled()
})
