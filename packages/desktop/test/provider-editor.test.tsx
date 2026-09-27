// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
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
it("edits model metadata in a focused dialog and returns to its pencil trigger", async () => {
  const save = vi.fn().mockResolvedValue(undefined)
  render(<ProviderCard row={{ id: "deepseek", displayName: "DeepSeek", configured: true, auth: { configured: true }, models: [{ id: "flash", contextWindow: 272000, inputModalities: ["text", "image"] }] }} onSave={save} />)
  const trigger = screen.getByRole("button", { name: "編輯模型" })
  fireEvent.click(trigger)
  const dialog = screen.getByRole("dialog", { name: "編輯模型" })
  await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByLabelText("上下文大小")))
  expect(screen.getByText("flash")).toBeTruthy()
  expect(within(dialog).getByLabelText("輸入類型")).toBeTruthy()
  fireEvent.keyDown(dialog, { key: "Escape" })
  expect(screen.queryByRole("dialog")).toBeNull()
  await waitFor(() => expect(document.activeElement).toBe(trigger))
  expect(save).not.toHaveBeenCalled()
})

it("opens adding a model with its ID focused and keeps the provider actions behind the dialog", async () => {
  render(<ProviderCard row={{ id: "route", displayName: "Route", configured: true, auth: { configured: false }, models: [] }} onSave={vi.fn()} />)
  const trigger = screen.getByRole("button", { name: "新增模型" })
  fireEvent.click(trigger)
  const dialog = screen.getByRole("dialog", { name: "新增模型" })
  await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByLabelText("模型 ID")))
  expect(screen.getByRole("button", { name: "編輯提供商" })).toBeTruthy()
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }))
  await waitFor(() => expect(document.activeElement).toBe(trigger))
})
it("labels new provider creation honestly and keeps advanced fields folded", () => {
  const save = vi.fn().mockResolvedValue(undefined)
  render(<ProviderEditor onSave={save} onClose={() => {}} />)
  expect(screen.getByText("新增提供商")).toBeTruthy()
  expect(screen.getByText(/建立後可新增模型與設定 API key/)).toBeTruthy()
  expect(screen.queryByText("留空以清除覆寫；未更改的欄位不會寫入。")).toBeNull()
  const details = screen.getByText("進階設定").closest("details") as HTMLDetailsElement
  expect(details.open).toBe(false)
  fireEvent.click(screen.getByText("進階設定"))
  expect(details.open).toBe(true)
  expect(screen.getByLabelText("模型列表網址")).toBeTruthy()
})

it("uses a new-model title when adding a model", () => {
  render(<ProviderEditor id="route" newModel onSave={vi.fn()} onClose={() => {}} />)
  expect(screen.getByText("新增模型")).toBeTruthy()
})
it("treats an unconfigured built-in provider as editing while keeping its first-override write", () => {
  const save = vi.fn().mockResolvedValue(undefined)
  render(<ProviderEditor provider={{ id: "built-in", displayName: "Built in", configured: false, baseURL: "https://built.example/v1" }} onSave={save} onClose={() => {}} />)
  expect(screen.getByText("編輯提供商")).toBeTruthy()
  expect(screen.queryByText("新增提供商")).toBeNull()
  expect(screen.queryByText("進階設定")).toBeNull()
  expect(screen.getByLabelText("模型列表網址")).toBeTruthy()
  expect(screen.getByText(/第一次儲存會建立自訂設定/)).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ action: "provider/create", id: "built-in" }))
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
  expect(screen.queryByLabelText("API 網址")).toBeNull()
  const trigger = screen.getByRole("button", { name: "編輯提供商" })
  fireEvent.click(trigger)
  const dialog = screen.getByRole("dialog", { name: "編輯提供商" })
  fireEvent.change(within(dialog).getByLabelText("API 網址"), { target: { value: "https://new.example/v1" } })
  fireEvent.change(within(dialog).getByLabelText("通訊協定"), { target: { value: "anthropic-messages" } })
  fireEvent.click(within(dialog).getByRole("button", { name: "儲存" }))
  expect(await within(dialog).findByText("offline")).toBeTruthy()
  expect((within(dialog).getByLabelText("API 網址") as HTMLInputElement).value).toBe("https://new.example/v1")
  expect(save).toHaveBeenCalledWith({ action: "provider/edit", id: "p", fields: {
    baseURL: "https://new.example/v1", protocol: "anthropic-messages",
  } })
  fireEvent.click(within(dialog).getByRole("button", { name: "儲存" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(trigger))
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
