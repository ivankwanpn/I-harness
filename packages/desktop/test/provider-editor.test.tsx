// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ProviderEditor } from "../src/renderer/settings/ProviderEditor.tsx"
import { ProviderCard } from "../src/renderer/settings/ProviderCard.tsx"
afterEach(cleanup)
it("requires a second action before removing a model", async () => {
  const save = vi.fn().mockResolvedValue(undefined)
  render(<ProviderCard row={{ id: "r", displayName: "R", configured: true, auth: { configured: false }, models: [{ id: "m" }] }} onSave={save} />)
  fireEvent.click(screen.getByText("模型數量：1"))
  fireEvent.click(screen.getByRole("button", { name: "移除模型" }))
  expect(save).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "確認移除模型" }))
  expect(save).toHaveBeenCalledWith({ action: "model/remove", id: "r", model: "m" })
})
it("submits only changed model fields and preserves input on failure", async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error("failed")).mockResolvedValue(undefined)
  render(<ProviderEditor id="route" model={{ id: "m", contextWindow: 272000, maxTokens: 4096 }} onSave={save} onClose={() => {}} />)
  fireEvent.change(screen.getByLabelText("上下文大小"), { target: { value: "1000000" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  await screen.findByText("failed")
  expect((screen.getByLabelText("上下文大小") as HTMLInputElement).value).toBe("1000000")
  expect(save).toHaveBeenCalledWith({ action: "model/edit", id: "route", model: "m", fields: { contextWindow: 1000000 } })
})
it("uses explicit null to clear an existing context override", async () => {
  const save = vi.fn().mockResolvedValue(undefined)
  render(<ProviderEditor id="route" model={{ id: "m", contextWindow: 272000 }} onSave={save} onClose={() => {}} />)
  fireEvent.change(screen.getByLabelText("上下文大小"), { target: { value: "" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  expect(save).toHaveBeenCalledWith({ action: "model/edit", id: "route", model: "m", fields: { contextWindow: null } })
})
