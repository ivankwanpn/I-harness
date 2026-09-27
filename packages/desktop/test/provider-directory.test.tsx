// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ProviderDirectory } from "../src/renderer/settings/ProviderDirectory.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"

afterEach(cleanup)
it("opens provider creation in a focused dialog and returns to the add button on Escape", async () => {
  const request = vi.fn(async (value: { kind: string }) => value.kind === "desktop/provider/directory" ? [{ id: "deepseek", displayName: "DeepSeek", configured: true, auth: { configured: true }, models: [] }] : {})
  render(<ProviderDirectory workspaceId="w" bridge={{ request, onEvent: () => () => {} }} />)
  const trigger = screen.getByRole("button", { name: "新增提供商" })
  fireEvent.click(trigger)
  const dialog = screen.getByRole("dialog", { name: "新增提供商" })
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("提供商 ID")))
  expect(screen.getByRole("button", { name: /DeepSeek/ })).toBeTruthy()
  fireEvent.keyDown(dialog, { key: "Escape" })
  expect(screen.queryByRole("dialog")).toBeNull()
  await waitFor(() => expect(document.activeElement).toBe(trigger))
  expect(request.mock.calls.filter(([value]) => value.kind === "desktop/provider/mutate")).toHaveLength(0)
})

it("selects the newly created provider after saving rather than returning to the old one", async () => {
  const old = { id: "deepseek", displayName: "DeepSeek", configured: true, auth: { configured: true }, models: [] }
  const created = { id: "new-route", displayName: "New provider", configured: true, auth: { configured: false }, models: [] }
  let exists = false
  const request = vi.fn(async (value: { kind: string }) => {
    if (value.kind === "desktop/provider/directory") return exists ? [old, created] : [old]
    if (value.kind === "desktop/provider/mutate") exists = true
    return {}
  })
  render(<ProviderDirectory workspaceId="w" bridge={{ request, onEvent: () => () => {} }} />)
  fireEvent.click(screen.getByRole("button", { name: "新增提供商" }))
  fireEvent.change(screen.getByLabelText("提供商 ID"), { target: { value: "new-route" } })
  fireEvent.change(screen.getByLabelText("顯示名稱"), { target: { value: "New provider" } })
  fireEvent.change(screen.getByLabelText("API 網址"), { target: { value: "https://new.example/v1" } })
  fireEvent.change(screen.getByLabelText("通訊協定"), { target: { value: "openai-completions" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  await waitFor(() => expect(screen.getByRole("button", { name: /New provider/ }).getAttribute("aria-current")).toBe("true"))
  expect(request).toHaveBeenCalledWith({ kind: "desktop/provider/mutate", workspaceId: "w", command: { action: "provider/create", id: "new-route", fields: { displayName: "New provider", baseURL: "https://new.example/v1", protocol: "openai-completions" } } })
})

it("keeps a failed creation inside the dialog with the entered values", async () => {
  const request = vi.fn(async (value: { kind: string }) => value.kind === "desktop/provider/directory" ? [] : Promise.reject(new Error("provider write failed")))
  render(<ProviderDirectory workspaceId="w" bridge={{ request, onEvent: () => () => {} }} />)
  fireEvent.click(screen.getByRole("button", { name: "新增提供商" }))
  fireEvent.change(screen.getByLabelText("提供商 ID"), { target: { value: "new-route" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("provider write failed"))
  expect((screen.getByLabelText("提供商 ID") as HTMLInputElement).value).toBe("new-route")
})

it("does not dismiss provider creation while its write is still pending", async () => {
  let finish!: () => void
  const pending = new Promise<void>((resolve) => { finish = resolve })
  const request = vi.fn(async (value: { kind: string }) => value.kind === "desktop/provider/directory" ? [] : pending)
  render(<ProviderDirectory workspaceId="w" bridge={{ request, onEvent: () => () => {} }} />)
  fireEvent.click(screen.getByRole("button", { name: "新增提供商" }))
  fireEvent.change(screen.getByLabelText("提供商 ID"), { target: { value: "new-route" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  await waitFor(() => expect(request.mock.calls.some(([value]) => value.kind === "desktop/provider/mutate")).toBe(true))
  const advanced = within(screen.getByRole("dialog")).getByText("進階設定")
  advanced.focus()
  expect(fireEvent.keyDown(advanced, { key: "Tab" })).toBe(false)
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
  expect(screen.getByRole("dialog")).toBeTruthy()
  finish()
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
})
it("loads real directory metadata and supports retry without discovering models", async () => {
  const request = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue([{
    id: "local-route", displayName: "My provider", auth: { configured: true },
    models: [{ id: "my-model", contextWindow: 272000 }],
  }])
  render(<ProviderDirectory workspaceId="w1" bridge={{ request, onEvent: () => () => {} }} />)
  await screen.findByText("offline")
  fireEvent.click(screen.getByRole("button", { name: "重試" }))
  await screen.findByRole("button", { name: /My provider/ })
  expect(screen.getByText("my-model")).toBeTruthy()
  expect(screen.getByTitle("上下文大小：272,000").textContent).toBe("272K")
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
  expect(request).toHaveBeenLastCalledWith({ kind: "desktop/provider/directory", workspaceId: "w1" })
})

it("shows one provider at a time and scopes connection drafts to that provider", async () => {
  const request = vi.fn().mockResolvedValue([
    { id: "a", displayName: "Alpha", configured: true, baseURL: "https://a.example", auth: { configured: false }, models: [{ id: "alpha-model" }] },
    { id: "b", displayName: "Beta", configured: true, baseURL: "https://b.example", auth: { configured: false }, models: [{ id: "beta-model" }] },
  ])
  render(<ProviderDirectory workspaceId="w1" bridge={{ request, onEvent: () => () => {} }} />)
  await screen.findByRole("button", { name: /Alpha/ })
  expect(screen.queryByText("beta-model")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "編輯提供商" }))
  fireEvent.change(screen.getByLabelText("API 網址"), { target: { value: "https://draft.example" } })
  fireEvent.click(screen.getByRole("button", { name: /Beta/ }))
  expect(screen.queryByText("alpha-model")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "編輯提供商" }))
  expect((screen.getByLabelText("API 網址") as HTMLInputElement).value).toBe("https://b.example")
  expect(request).toHaveBeenCalledTimes(1)
})

it("filters provider navigation locally while keeping the selected detail in sync", async () => {
  const request = vi.fn().mockResolvedValue([
    { id: "a", displayName: "Alpha", configured: true, auth: { configured: true }, models: [{ id: "alpha-model" }] },
    { id: "b", displayName: "Beta", configured: true, auth: { configured: true }, models: [{ id: "beta-model" }] },
  ])
  render(<ProviderDirectory workspaceId="w" bridge={{ request, onEvent: () => () => {} }} />)
  await screen.findByRole("button", { name: /Alpha/ })
  fireEvent.change(screen.getByRole("searchbox", { name: "搜尋提供商" }), { target: { value: "beta" } })
  expect(screen.queryByRole("button", { name: /Alpha/ })).toBeNull()
  expect(screen.getByRole("button", { name: /Beta/ })).toBeTruthy()
  expect(screen.getByText("beta-model")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "清除提供商搜尋" }))
  expect(screen.getByRole("button", { name: /Alpha/ })).toBeTruthy()
  expect(screen.getByText("alpha-model")).toBeTruthy()
  expect(request).toHaveBeenCalledTimes(1)
})

it("explains when model input changes take effect without leaving settings", async () => {
  useUiStore.getState().setSurface("settings")
  const row = { id: "p", displayName: "Provider", configured: true, auth: { configured: true }, models: [{ id: "m", inputModalities: ["text"] }] }
  const request = vi.fn(async (command: { kind: string }) => command.kind === "desktop/provider/directory" ? [row] : {})
  render(<ProviderDirectory workspaceId="w" bridge={{ request, onEvent: () => () => {} }} />)
  await screen.findByText("m")
  fireEvent.click(screen.getByRole("button", { name: "編輯模型" }))
  fireEvent.change(screen.getByLabelText("輸入類型"), { target: { value: "text,image" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  expect(await screen.findByText(/現有會話/)).toBeTruthy()
  expect(screen.queryByRole("button", { name: "返回會話並重新套用模型" })).toBeNull()
  expect(useUiStore.getState().surface).toBe("settings")
})
