// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryPane } from "../src/renderer/memory/MemoryPane.tsx"
import type { DesktopBridge, DesktopRequest } from "../src/shared/bridge.ts"

afterEach(cleanup)
function fixture(enabled = false) {
  const request = vi.fn(async (request: DesktopRequest): Promise<unknown> => {
    switch (request.kind) {
      case "desktop/memory/state": return { enabled }
      case "desktop/memory/list": return { notes: [{ id: "n1", title: "專案偏好" }] }
      case "desktop/memory/read": return { note: { id: "n1", title: "專案偏好", text: "使用繁體中文" } }
      case "desktop/memory/search": return { hits: [] }
      case "desktop/memory/summary": return { text: "筆記擷取內容" }
      case "desktop/memory/configure": return { enabled: request.enabled }
      default: return {}
    }
  })
  const bridge: DesktopBridge = { request, onEvent: () => () => {} }
  render(<MemoryPane bridge={bridge} workspaceId="playground" />)
  return request
}

describe("workspace memory", () => {
  it("reads an existing summary through the scoped memory endpoint", async () => {
    const request = fixture()
    await screen.findByRole("button", { name: "專案偏好" })
    fireEvent.click(screen.getByRole("button", { name: "查看筆記摘要" }))
    expect(await screen.findByText("筆記擷取內容")).toBeTruthy()
    expect(request).toHaveBeenCalledWith({ kind: "desktop/memory/summary", workspaceId: "playground" })
  })
  it("reads existing notes while disabled and scopes all requests", async () => {
    const request = fixture()
    await screen.findByRole("button", { name: "專案偏好" })
    expect((screen.getByRole("button", { name: "儲存筆記" }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "專案偏好" }))
    expect(await screen.findByText("使用繁體中文")).toBeTruthy()
    expect(request.mock.calls.every(([row]) => "workspaceId" in row && row.workspaceId === "playground")).toBe(true)
  })
  it("saves a note only after memory is enabled", async () => {
    const request = fixture()
    await screen.findByRole("button", { name: "專案偏好" })
    fireEvent.click(screen.getByRole("checkbox"))
    await waitFor(() => expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true))
    fireEvent.change(screen.getByLabelText("標題"), { target: { value: "測試標題" } })
    fireEvent.change(screen.getByLabelText("內容"), { target: { value: "測試內容" } })
    fireEvent.click(screen.getByRole("button", { name: "儲存筆記" }))
    await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "desktop/memory/note", workspaceId: "playground", title: "測試標題", text: "測試內容" }))
  })
  it("requires an explicit second action before deletion", async () => {
    const request = fixture(true)
    fireEvent.click(await screen.findByRole("button", { name: "專案偏好" }))
    fireEvent.click(await screen.findByRole("button", { name: "刪除筆記" }))
    expect(request.mock.calls.some(([row]) => row.kind === "desktop/memory/forget")).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "確認刪除此筆記" }))
    await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "desktop/memory/forget", workspaceId: "playground", id: "n1" }))
  })
  it("shows failures without clearing an unsaved note", async () => {
    const request = fixture(true)
    await screen.findByRole("button", { name: "專案偏好" })
    request.mockRejectedValueOnce(new Error("write failed"))
    fireEvent.change(screen.getByLabelText("標題"), { target: { value: "保留" } })
    fireEvent.change(screen.getByLabelText("內容"), { target: { value: "不可遺失" } })
    fireEvent.click(screen.getByRole("button", { name: "儲存筆記" }))
    expect(await screen.findByRole("alert")).toBeTruthy()
    expect((screen.getByLabelText("內容") as HTMLTextAreaElement).value).toBe("不可遺失")
  })
})
