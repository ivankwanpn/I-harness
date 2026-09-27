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
it("saves a model's image capability as a real input-modality override", async () => {
  const save = vi.fn().mockResolvedValue(undefined)
  render(<ProviderEditor id="route" model={{ id: "vision", inputModalities: ["text"] }} onSave={save} onClose={() => {}} />)
  fireEvent.change(screen.getByLabelText("輸入類型"), { target: { value: "text,image" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  expect(save).toHaveBeenCalledWith({ action: "model/edit", id: "route", model: "vision", fields: { inputModalities: ["text", "image"] } })
})

it("edits a custom provider connection in its detail card and retains failed changes", async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined)
  render(<ProviderCard row={{ id: "p", displayName: "Provider", configured: true, auth: { configured: true },
    baseURL: "https://old.example/v1", protocol: "openai-completions", models: [] }} onSave={save} />)
  expect(screen.queryByLabelText("輸入類型")).toBeNull()
  fireEvent.change(screen.getByLabelText("API 網址"), { target: { value: "https://new.example/v1" } })
  fireEvent.change(screen.getByLabelText("通訊協定"), { target: { value: "anthropic-messages" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存連線" }))
  expect(await screen.findByText("offline")).toBeTruthy()
  expect((screen.getByLabelText("API 網址") as HTMLInputElement).value).toBe("https://new.example/v1")
  expect(save).toHaveBeenCalledWith({ action: "provider/edit", id: "p", fields: {
    baseURL: "https://new.example/v1", protocol: "anthropic-messages",
  } })
  fireEvent.click(screen.getByRole("button", { name: "儲存連線" }))
  expect(save).toHaveBeenCalledTimes(2)
})

it("keeps input types in the model editor and out of the provider editor", () => {
  const save = vi.fn().mockResolvedValue(undefined)
  const view = render(<ProviderEditor id="p" provider={{ id: "p", displayName: "P", configured: true }} onSave={save} onClose={() => {}} />)
  expect(screen.queryByLabelText("輸入類型")).toBeNull()
  view.unmount()
  render(<ProviderEditor id="p" model={{ id: "m", inputModalities: ["text", "image"] }} onSave={save} onClose={() => {}} />)
  expect((screen.getByLabelText("輸入類型") as HTMLSelectElement).value).toBe("text,image")
})

it("shows a legacy image-only model honestly while allowing a supported replacement", () => {
  const save = vi.fn().mockResolvedValue(undefined)
  render(<ProviderEditor id="p" model={{ id: "m", inputModalities: ["image"] }} onSave={save} onClose={() => {}} />)
  expect((screen.getByLabelText("輸入類型") as HTMLSelectElement).value).toBe("image")
  expect(screen.getByRole("option", { name: "僅圖片（舊設定）" })).toBeTruthy()
})
it("treats legacy reversed modality order as the same text-and-image model setting", () => {
  const save = vi.fn().mockResolvedValue(undefined)
  render(<ProviderEditor id="p" model={{ id: "m", inputModalities: ["image", "text"] }} onSave={save} onClose={() => {}} />)
  expect((screen.getByLabelText("輸入類型") as HTMLSelectElement).value).toBe("text,image")
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  expect(save).toHaveBeenCalledWith({ action: "model/edit", id: "p", model: "m", fields: {} })
})
