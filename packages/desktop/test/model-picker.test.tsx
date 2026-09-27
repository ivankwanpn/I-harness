// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { SessionModelPicker } from "../src/renderer/session/SessionModelPicker.tsx"

afterEach(cleanup)

const routes = [
  { id: "unused", displayName: "Unused", configured: false, models: [{ id: "old" }] },
  { id: "deepseek", displayName: "DeepSeek", configured: true, models: [{ id: "deepseek-flash" }, { id: "deepseek-chat" }] },
]

it("opens a searchable model list grouped by configured provider and applies one click", async () => {
  const request = vi.fn().mockResolvedValue(routes)
  const select = vi.fn().mockResolvedValue(undefined)
  render(<SessionModelPicker bridge={{ request, onEvent: () => () => {} }} workspaceId="w" disabled={false} onSelect={select} />)
  expect(request).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "選擇模型" }))
  await screen.findByRole("button", { name: "deepseek-flash" })
  expect(screen.getByText("DeepSeek")).toBeTruthy()
  expect(screen.queryByRole("button", { name: "old" })).toBeNull()
  fireEvent.change(screen.getByRole("searchbox", { name: "搜尋模型" }), { target: { value: "chat" } })
  expect(screen.queryByRole("button", { name: "deepseek-flash" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "deepseek-chat" }))
  await waitFor(() => expect(select).toHaveBeenCalledWith({ provider: "deepseek", model: "deepseek-chat" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
})

it("sets reasoning independently and shows the saved effort from session state", async () => {
  const select = vi.fn().mockResolvedValue(undefined)
  const current = { status: "ready" as const, providerId: "deepseek", modelId: "deepseek-flash", label: "DeepSeek Flash", reasoningEffort: "high" }
  const bridge = { request: vi.fn().mockResolvedValue(routes), onEvent: () => () => {} }
  const view = render(<SessionModelPicker bridge={bridge} workspaceId="w" current={current} disabled={false} onSelect={select} />)
  expect(screen.getByRole("button", { name: "思考強度：High" })).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "思考強度：High" }))
  fireEvent.click(screen.getByRole("button", { name: "Default" }))
  await waitFor(() => expect(select).toHaveBeenCalledWith({ provider: "deepseek", model: "deepseek-flash" }))
  view.rerender(<SessionModelPicker bridge={bridge} workspaceId="w" current={{ ...current, reasoningEffort: undefined }} disabled={false} onSelect={select} />)
  expect(screen.getByRole("button", { name: "思考強度：Default" })).toBeTruthy()
})

it("preserves an effective protocol override while changing only reasoning", async () => {
  const select = vi.fn().mockResolvedValue(undefined)
  render(<SessionModelPicker bridge={{ request: vi.fn(), onEvent: () => () => {} }} workspaceId="w" current={{ status: "ready", providerId: "gateway", modelId: "m", label: "m", protocol: "openai-responses" }} disabled={false} onSelect={select} />)
  fireEvent.click(screen.getByRole("button", { name: "思考強度：Default" }))
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Default" }))
  fireEvent.click(screen.getByRole("button", { name: "High" }))
  await waitFor(() => expect(select).toHaveBeenCalledWith({ provider: "gateway", model: "m", protocol: "openai-responses", reasoningEffort: "high" }))
})

it("shows only the effort list reported by the effective protocol", () => {
  render(<SessionModelPicker bridge={{ request: vi.fn(), onEvent: () => () => {} }} workspaceId="w" current={{ status: "ready", providerId: "example", modelId: "example-model", label: "Example", reasoningEfforts: ["low", "high"] }} disabled={false} onSelect={async () => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "思考強度：Default" }))
  expect(screen.getByRole("button", { name: "Default" })).toBeTruthy()
  expect(screen.getByRole("button", { name: "Low" })).toBeTruthy()
  expect(screen.getByRole("button", { name: "High" })).toBeTruthy()
  expect(screen.queryByRole("button", { name: "None" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Max" })).toBeNull()
})

it("resets reasoning to provider default when choosing another model", async () => {
  const select = vi.fn().mockResolvedValue(undefined)
  render(<SessionModelPicker bridge={{ request: vi.fn().mockResolvedValue(routes), onEvent: () => () => {} }} workspaceId="w" current={{ status: "ready", providerId: "deepseek", modelId: "deepseek-flash", label: "Flash", reasoningEffort: "high" }} disabled={false} onSelect={select} />)
  fireEvent.click(screen.getByRole("button", { name: "deepseek-flash" }))
  fireEvent.click(await screen.findByRole("button", { name: "deepseek-chat" }))
  await waitFor(() => expect(select).toHaveBeenCalledWith({ provider: "deepseek", model: "deepseek-chat" }))
})

it("keeps a rejected reasoning choice visible without implying a directory retry can apply it", async () => {
  const select = vi.fn().mockRejectedValue(new Error("model does not support this effort"))
  render(<SessionModelPicker bridge={{ request: vi.fn().mockResolvedValue(routes), onEvent: () => () => {} }} workspaceId="w" current={{ status: "ready", providerId: "deepseek", modelId: "deepseek-flash", label: "Flash" }} disabled={false} onSelect={select} />)
  fireEvent.click(screen.getByRole("button", { name: "思考強度：Default" }))
  fireEvent.click(screen.getByRole("button", { name: "Max" }))
  expect((await screen.findByRole("alert")).textContent).toContain("model does not support this effort")
  expect(screen.getByRole("dialog", { name: "思考強度" })).toBeTruthy()
  expect(screen.queryByRole("button", { name: "重試" })).toBeNull()
})

it("clears a directory load error after a successful retry", async () => {
  const request = vi.fn().mockRejectedValueOnce(new Error("directory unavailable")).mockResolvedValue(routes)
  render(<SessionModelPicker bridge={{ request, onEvent: () => () => {} }} workspaceId="w" disabled={false} onSelect={async () => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "選擇模型" }))
  expect((await screen.findByRole("alert")).textContent).toContain("directory unavailable")
  fireEvent.click(screen.getByRole("button", { name: "重試" }))
  await screen.findByRole("button", { name: "deepseek-flash" })
  expect(screen.queryByRole("alert")).toBeNull()
})

it("does not erase a provider rejection when a directory refresh finishes later", async () => {
  let finishDirectory!: (value: unknown) => void
  const request = vi.fn().mockResolvedValueOnce(routes).mockImplementationOnce(() => new Promise((resolve) => { finishDirectory = resolve }))
  const select = vi.fn().mockRejectedValue(new Error("provider rejected reasoning"))
  render(<SessionModelPicker bridge={{ request, onEvent: () => () => {} }} workspaceId="w" disabled={false} onSelect={select} />)
  fireEvent.click(screen.getByRole("button", { name: "選擇模型" }))
  await screen.findByRole("button", { name: "deepseek-flash" })
  fireEvent.keyDown(document, { key: "Escape" })
  fireEvent.click(screen.getByRole("button", { name: "選擇模型" }))
  fireEvent.click(screen.getByRole("button", { name: "deepseek-flash" }))
  expect((await screen.findByRole("alert")).textContent).toContain("provider rejected reasoning")
  finishDirectory(routes)
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
  expect(screen.getByRole("alert").textContent).toContain("provider rejected reasoning")
})

it("keeps arbitrary vendor model IDs available through a custom entry", async () => {
  const select = vi.fn().mockResolvedValue(undefined)
  render(<SessionModelPicker bridge={{ request: vi.fn().mockResolvedValue(routes), onEvent: () => () => {} }} workspaceId="w" disabled={false} onSelect={select} />)
  fireEvent.click(screen.getByRole("button", { name: "選擇模型" }))
  await screen.findByRole("button", { name: "自訂模型 ID" })
  fireEvent.click(screen.getByRole("button", { name: "自訂模型 ID" }))
  fireEvent.change(screen.getByLabelText("提供商 ID"), { target: { value: "deepseek" } })
  fireEvent.change(screen.getByLabelText("模型 ID"), { target: { value: "new-vendor-model" } })
  fireEvent.click(screen.getByRole("button", { name: "套用模型" }))
  await waitFor(() => expect(select).toHaveBeenCalledWith({ provider: "deepseek", model: "new-vendor-model" }))
})

it("opens above the composer without submitting and closes with Escape", async () => {
  const submit = vi.fn()
  render(<form onSubmit={(event) => { event.preventDefault(); submit() }}><SessionModelPicker bridge={{ request: vi.fn().mockResolvedValue(routes), onEvent: () => () => {} }} workspaceId="w" disabled={false} onSelect={async () => {}} /></form>)
  const trigger = screen.getByRole("button", { name: "選擇模型" })
  fireEvent.click(trigger)
  expect(submit).not.toHaveBeenCalled()
  expect(screen.getByRole("dialog").closest("form")).toBeNull()
  fireEvent.keyDown(document, { key: "Escape" })
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(document.activeElement).toBe(trigger)
})
