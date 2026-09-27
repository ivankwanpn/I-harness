// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { SessionModelPicker } from "../src/renderer/session/SessionModelPicker.tsx"
afterEach(cleanup)
it("suggests the sole configured model without applying it until confirmed", async () => {
  const request = vi.fn().mockResolvedValue([
    { id: "unused", displayName: "Unused", configured: false, models: [] },
    { id: "deepseek", displayName: "DeepSeek", configured: true, models: [{ id: "deepseek-flash" }] },
  ])
  const select = vi.fn().mockResolvedValue(undefined)
  render(<SessionModelPicker bridge={{ request, onEvent: () => () => {} }} workspaceId="w" disabled={false} onSelect={select} />)
  fireEvent.click(screen.getByRole("button", { name: "選擇模型" }))
  await waitFor(() => expect((screen.getByLabelText("模型 ID") as HTMLInputElement).value).toBe("deepseek-flash"))
  expect((screen.getByLabelText("提供商 ID") as HTMLSelectElement).value).toBe("deepseek")
  expect(select).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "套用模型" }))
  await waitFor(() => expect(select).toHaveBeenCalledWith({ provider: "deepseek", model: "deepseek-flash" }))
})
it("opens outside the composer clipping region without submitting and closes with Escape", async () => {
  const submit = vi.fn()
  render(<form onSubmit={(event) => { event.preventDefault(); submit() }}><SessionModelPicker bridge={{ request: vi.fn().mockResolvedValue([]), onEvent: () => () => {} }} workspaceId="w" disabled={false} onSelect={async () => {}} /></form>)
  const trigger = screen.getByRole("button", { name: "選擇模型" })
  fireEvent.click(trigger)
  expect(submit).not.toHaveBeenCalled()
  expect(screen.getByRole("dialog").closest("form")).toBeNull()
  fireEvent.keyDown(document, { key: "Escape" })
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(document.activeElement).toBe(trigger)
})
it("loads routes on demand and submits an explicit session selection", async () => {
  const request = vi.fn().mockResolvedValue([{ id: "p", displayName: "Provider", models: [{ id: "m" }] }])
  const select = vi.fn().mockResolvedValue(undefined)
  render(<SessionModelPicker bridge={{ request, onEvent: () => () => {} }} workspaceId="w" disabled={false} onSelect={select} />)
  expect(request).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "選擇模型" }))
  await screen.findByRole("option", { name: "Provider" })
  fireEvent.change(screen.getByLabelText("提供商 ID"), { target: { value: "p" } })
  fireEvent.change(screen.getByLabelText("模型 ID"), { target: { value: "m" } })
  fireEvent.change(screen.getByLabelText("推理強度"), { target: { value: "high" } })
  fireEvent.click(screen.getByRole("button", { name: "套用模型" }))
  await waitFor(() => expect(select).toHaveBeenCalledWith({ provider: "p", model: "m", reasoningEffort: "high" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
})
