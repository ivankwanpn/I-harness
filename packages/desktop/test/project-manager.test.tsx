// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ProjectManager } from "../src/renderer/projects/ProjectManager.tsx"
import { useLocale } from "../src/renderer/design/i18n.ts"
afterEach(() => { cleanup(); useLocale.getState().setLocale("zh-TW") })

it("edits project folders and primary workspace without recreating folder identities", async () => {
  useLocale.getState().setLocale("zh-TW")
  const request = vi.fn(async () => ({ id: "p" }))
  const changed = vi.fn(async () => {})
  const project = { id: "p", name: "App", workspaceIds: ["a", "b"], primaryWorkspaceId: "a", pinned: false, createdAt: "2026-10-01", updatedAt: "2026-10-01" }
  render(<ProjectManager bridge={{ request, onEvent: () => () => {} }} projects={[project]} workspaces={[{ id: "a", label: "app", path: "D:/app" }, { id: "b", label: "test", path: "D:/test" }]} onChanged={changed} onOpen={() => {}} onClose={() => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "編輯專案 App" }))
  fireEvent.click(screen.getByRole("button", { name: "設為主要資料夾 test" }))
  fireEvent.change(screen.getByRole("textbox", { name: "專案名稱" }), { target: { value: "My App" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "projects/save", input: expect.objectContaining({ id: "p", name: "My App", workspaceIds: ["a", "b"], primaryWorkspaceId: "b" }) }))
  expect(changed).toHaveBeenCalledOnce()
})

it("keeps the edit form and shows a failed mutation without dismissing it", async () => {
  const request = vi.fn(async () => { throw new Error("disk unavailable") })
  render(<ProjectManager bridge={{ request, onEvent: () => () => {} }} projects={[]} workspaces={[]} onChanged={async () => {}} onOpen={() => {}} onClose={() => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "新增專案" }))
  fireEvent.change(screen.getByRole("textbox", { name: "專案名稱" }), { target: { value: "Draft" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  await waitFor(() => expect(screen.getByText("disk unavailable")).toBeTruthy())
  expect(screen.getByRole("textbox", { name: "專案名稱" })).toHaveProperty("value", "Draft")
})

it("keeps the saved identity when refresh fails so retry cannot create a second project", async () => {
  const saved = { id: "saved-id", name: "Draft", workspaceIds: [], pinned: false, createdAt: "2026-10-01", updatedAt: "2026-10-01T00:00:00.000Z" }
  const request = vi.fn(async (_input: unknown) => saved)
  const changed = vi.fn().mockRejectedValueOnce(new Error("refresh failed")).mockResolvedValueOnce(undefined)
  render(<ProjectManager bridge={{ request, onEvent: () => () => {} }} projects={[]} workspaces={[]} onChanged={changed} onOpen={() => {}} onClose={() => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "新增專案" }))
  fireEvent.change(screen.getByRole("textbox", { name: "專案名稱" }), { target: { value: "Draft" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  await waitFor(() => expect(screen.getByText("refresh failed")).toBeTruthy())
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
  expect(request.mock.calls[1]?.[0]).toMatchObject({ kind: "projects/save", input: { id: "saved-id", expectedUpdatedAt: saved.updatedAt } })
})
