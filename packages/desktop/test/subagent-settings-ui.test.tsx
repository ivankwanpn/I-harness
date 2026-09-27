// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { SubagentSettings } from "../src/renderer/settings/SubagentSettings.tsx"
afterEach(cleanup)
it("opens a focused role dialog and restores its trigger on Escape", async () => {
  const state = { enabled: true, effectiveEnabled: true, restartRequired: false, roles: [{ name: "explore" }] }
  const request = vi.fn(async (input) => input.kind === "desktop/provider/directory" ? [{ id: "p", displayName: "Provider", protocol: "openai-completions", models: [{ id: "m" }] }] : state)
  render(<SubagentSettings workspaceId="w" bridge={{ request, onEvent: () => () => {} }} />)
  const trigger = await screen.findByRole("button", { name: "設定角色模型" })
  fireEvent.click(trigger)
  const dialog = screen.getByRole("dialog", { name: "設定角色模型" })
  expect(dialog.getAttribute("aria-modal")).toBe("true")
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
  expect(document.activeElement).toBe(screen.getByLabelText("提供商 ID"))
  const cancel = within(dialog).getByRole("button", { name: "取消" })
  cancel.focus()
  fireEvent.keyDown(dialog, { key: "Tab" })
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "關閉角色設定" }))
  fireEvent.keyDown(dialog, { key: "Escape" })
  expect(screen.queryByRole("dialog")).toBeNull()
  await waitFor(() => expect(document.activeElement).toBe(trigger))
})

it("edits a role mapping without silently enabling the global model gate", async () => {
  const state = { enabled: false, effectiveEnabled: false, restartRequired: false, roles: [{ name: "explore" }] }
  const request = vi.fn(async (request) => request.kind === "desktop/provider/directory" ? [{ id: "local", displayName: "Local", protocol: "openai-completions", models: [{ id: "small" }] }] : state)
  render(<SubagentSettings workspaceId="w" bridge={{ request, onEvent: () => () => {} }} />)
  fireEvent.click(await screen.findByRole("button", { name: "設定角色模型" }))
  expect(screen.getByRole("dialog", { name: "設定角色模型" })).toBeTruthy()
  fireEvent.change(screen.getByLabelText("提供商 ID"), { target: { value: "local" } })
  expect((screen.getByLabelText("模型 ID") as HTMLSelectElement).tagName).toBe("SELECT")
  fireEvent.change(screen.getByLabelText("模型 ID"), { target: { value: "small" } })
  expect(screen.queryByLabelText("通訊協定")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  await screen.findByText("角色設定已儲存，下一個新子代理會讀取此設定。")
  expect(request).toHaveBeenCalledWith({ kind: "desktop/subagents/mutate", workspaceId: "w", command: { action: "role/set", role: "explore", selection: { provider: "local", model: "small" } } })
  expect((screen.getByRole("checkbox", { name: "允許角色使用獨立模型" }) as HTMLInputElement).checked).toBe(false)
})

it("does not let an older retry read replace a successfully saved mapping", async () => {
  const initial = { enabled: true, effectiveEnabled: true, restartRequired: false, roles: [{ name: "explore" }] }
  let release!: (value: unknown) => void
  let reads = 0; let writes = 0
  const request = vi.fn(async (request) => {
    if (request.kind === "desktop/provider/directory") return [{ id: "p", displayName: "P", protocol: "openai-completions", models: [{ id: "new-model" }] }]
    if (request.kind === "desktop/subagents/state") return ++reads === 1 ? initial : new Promise((resolve) => { release = resolve })
    if (++writes === 1) throw new Error("save failed")
    return { ...initial, roles: [{ name: "explore", selection: { provider: "p", model: "new-model" } }] }
  })
  render(<SubagentSettings workspaceId="w" bridge={{ request, onEvent: () => () => {} }} />)
  fireEvent.click(await screen.findByRole("button", { name: "設定角色模型" }))
  fireEvent.change(screen.getByLabelText("提供商 ID"), { target: { value: "p" } })
  fireEvent.change(screen.getByLabelText("模型 ID"), { target: { value: "new-model" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  await screen.findByRole("alert")
  expect(within(screen.getByRole("dialog")).getByRole("alert").textContent).toContain("save failed")
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "重試" }))
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  await screen.findByText("p / new-model")
  await act(async () => release(initial))
  expect(screen.getByText("p / new-model")).toBeTruthy()
})

it("only lets a role use a model in the selected provider's directory", async () => {
  const state = { enabled: true, effectiveEnabled: true, restartRequired: false, roles: [{ name: "explore" }] }
  const request = vi.fn(async (input) => input.kind === "desktop/provider/directory" ? [
    { id: "first", displayName: "First", models: [{ id: "one" }] },
    { id: "second", displayName: "Second", models: [{ id: "two" }] },
  ] : state)
  render(<SubagentSettings workspaceId="w" bridge={{ request, onEvent: () => () => {} }} />)
  fireEvent.click(await screen.findByRole("button", { name: "設定角色模型" }))
  fireEvent.change(screen.getByLabelText("提供商 ID"), { target: { value: "first" } })
  expect(Array.from((screen.getByLabelText("模型 ID") as HTMLSelectElement).options).map((option) => option.value)).toEqual(["", "one"])
  fireEvent.change(screen.getByLabelText("模型 ID"), { target: { value: "one" } })
  fireEvent.change(screen.getByLabelText("提供商 ID"), { target: { value: "second" } })
  expect((screen.getByLabelText("模型 ID") as HTMLSelectElement).value).toBe("")
  expect(Array.from((screen.getByLabelText("模型 ID") as HTMLSelectElement).options).map((option) => option.value)).toEqual(["", "two"])
  expect((screen.getByRole("button", { name: "儲存" }) as HTMLButtonElement).disabled).toBe(true)
})

it("preserves a hidden legacy protocol when only changing reasoning effort", async () => {
  const state = { enabled: true, effectiveEnabled: true, restartRequired: false,
    roles: [{ name: "explore", selection: { provider: "p", model: "m", protocol: "anthropic-messages" } }] }
  const request = vi.fn(async (input) => input.kind === "desktop/provider/directory"
    ? [{ id: "p", displayName: "Provider", auth: { configured: true }, models: [{ id: "m" }] }] : state)
  render(<SubagentSettings workspaceId="w" bridge={{ request, onEvent: () => () => {} }} />)
  fireEvent.click(await screen.findByRole("button", { name: "設定角色模型" }))
  fireEvent.change(screen.getByLabelText("推理強度"), { target: { value: "high" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  expect(request).toHaveBeenCalledWith({ kind: "desktop/subagents/mutate", workspaceId: "w", command: {
    action: "role/set", role: "explore", selection: { provider: "p", model: "m", protocol: "anthropic-messages", reasoningEffort: "high" },
  } })
})

it("shows missing credentials and prevents assigning a role to that provider", async () => {
  const state = { enabled: true, effectiveEnabled: true, restartRequired: false, roles: [{ name: "explore" }] }
  const request = vi.fn(async (input) => input.kind === "desktop/provider/directory"
    ? [{ id: "p", displayName: "Provider", auth: { configured: false }, models: [{ id: "m" }] }] : state)
  render(<SubagentSettings workspaceId="w" bridge={{ request, onEvent: () => () => {} }} />)
  fireEvent.click(await screen.findByRole("button", { name: "設定角色模型" }))
  fireEvent.change(screen.getByLabelText("提供商 ID"), { target: { value: "p" } })
  fireEvent.change(screen.getByLabelText("模型 ID"), { target: { value: "m" } })
  expect(screen.getByText("此提供商尚未設定憑證，無法供子代理使用。")).toBeTruthy()
  expect((screen.getByRole("button", { name: "儲存" }) as HTMLButtonElement).disabled).toBe(true)
})

it("requires a protocol from the managed model or provider for a new role selection", async () => {
  const state = { enabled: true, effectiveEnabled: true, restartRequired: false, roles: [{ name: "explore" }] }
  const request = vi.fn(async (input) => input.kind === "desktop/provider/directory"
    ? [{ id: "p", displayName: "Provider", auth: { configured: true }, models: [{ id: "m" }] }] : state)
  render(<SubagentSettings workspaceId="w" bridge={{ request, onEvent: () => () => {} }} />)
  fireEvent.click(await screen.findByRole("button", { name: "設定角色模型" }))
  fireEvent.change(screen.getByLabelText("提供商 ID"), { target: { value: "p" } })
  fireEvent.change(screen.getByLabelText("模型 ID"), { target: { value: "m" } })
  expect(screen.getByText("請先在模型與提供商設定通訊協定。")).toBeTruthy()
  expect((screen.getByRole("button", { name: "儲存" }) as HTMLButtonElement).disabled).toBe(true)
})
