// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { SubagentSettings } from "../src/renderer/settings/SubagentSettings.tsx"
import { useLocale } from "../src/renderer/design/i18n.ts"
beforeEach(() => useLocale.getState().setLocale("zh-TW"))
afterEach(cleanup)
const directory = [{ id: "p", displayName: "Provider", auth: { configured: true }, protocol: "openai-completions", models: [{ id: "small" }, { id: "other" }] }]
function setup(selection?: { provider: string; model: string; protocol?: string; reasoningEffort?: string }, fail = false) {
  let state = { enabled: false, effectiveEnabled: false, restartRequired: false, roles: [{ name: "general", selection }, { name: "reviewer", selection }] }
  const request = vi.fn(async (input) => {
    if (input.kind === "desktop/provider/directory") return directory
    if (input.kind === "desktop/subagents/mutate") {
      if (fail) throw new Error("save failed")
      const { command } = input
      state = { ...state, roles: state.roles.map((row) => row.name === command.role ? { ...row, selection: command.action === "role/clear" ? undefined : command.selection } : row) }
    }
    return state
  })
  render(<SubagentSettings workspaceId="w" bridge={{ request, onEvent: () => () => {} }} />)
  return request
}
it("edits grouped model and effort controls inline without a protocol selector", async () => {
  const request = setup()
  const model = await screen.findByRole("combobox", { name: "模型 general" })
  expect((model.querySelector("optgroup") as HTMLOptGroupElement).label).toBe("Provider")
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(screen.queryByLabelText("通訊協定")).toBeNull()
  fireEvent.change(model, { target: { value: JSON.stringify(["p", "small"]) } })
  await waitFor(() => expect(request).toHaveBeenLastCalledWith({ kind: "desktop/subagents/mutate", workspaceId: "w", command: { action: "role/set", role: "general", selection: { provider: "p", model: "small" } } }))
  fireEvent.change(screen.getByRole("combobox", { name: "推理強度 general" }), { target: { value: "low" } })
  await waitFor(() => expect(request).toHaveBeenLastCalledWith({ kind: "desktop/subagents/mutate", workspaceId: "w", command: { action: "role/set", role: "general", selection: { provider: "p", model: "small", reasoningEffort: "low" } } }))
})
it("provides an independent reviewer even when ordinary role models are disabled", async () => {
  const request = setup()
  fireEvent.change(await screen.findByRole("combobox", { name: "模型 代我審批" }), { target: { value: JSON.stringify(["p", "small"]) } })
  await waitFor(() => expect(request).toHaveBeenLastCalledWith({ kind: "desktop/subagents/mutate", workspaceId: "w", command: { action: "role/set", role: "reviewer", selection: { provider: "p", model: "small" } } }))
  expect((screen.getByRole("checkbox", { name: "允許角色使用獨立模型" }) as HTMLInputElement).checked).toBe(false)
})
it("preserves same-model legacy protocol on effort edits and drops it on model change", async () => {
  const request = setup({ provider: "p", model: "small", protocol: "anthropic-messages" })
  fireEvent.change(await screen.findByRole("combobox", { name: "推理強度 general" }), { target: { value: "high" } })
  await waitFor(() => expect(request).toHaveBeenLastCalledWith({ kind: "desktop/subagents/mutate", workspaceId: "w", command: { action: "role/set", role: "general", selection: { provider: "p", model: "small", protocol: "anthropic-messages", reasoningEffort: "high" } } }))
  fireEvent.change(screen.getByRole("combobox", { name: "模型 general" }), { target: { value: JSON.stringify(["p", "other"]) } })
  await waitFor(() => expect(request).toHaveBeenLastCalledWith({ kind: "desktop/subagents/mutate", workspaceId: "w", command: { action: "role/set", role: "general", selection: { provider: "p", model: "other", reasoningEffort: "high" } } }))
})
it("clears an override back to inheritance", async () => {
  const request = setup({ provider: "p", model: "small" })
  fireEvent.change(await screen.findByRole("combobox", { name: "模型 general" }), { target: { value: "" } })
  await waitFor(() => expect(request).toHaveBeenLastCalledWith({ kind: "desktop/subagents/mutate", workspaceId: "w", command: { action: "role/clear", role: "general" } }))
})
it("keeps the previous selection when persistence fails", async () => {
  setup({ provider: "p", model: "small" }, true)
  const model = await screen.findByRole("combobox", { name: "模型 general" })
  fireEvent.change(model, { target: { value: JSON.stringify(["p", "other"]) } })
  await screen.findByRole("alert")
  expect((model as HTMLSelectElement).value).toBe(JSON.stringify(["p", "small"]))
})
it("disables uncredentialed and unresolved routes", async () => {
  const state = { enabled: true, effectiveEnabled: true, restartRequired: false, roles: [{ name: "general" }] }
  const request = vi.fn(async (input) => input.kind === "desktop/provider/directory" ? [
    { id: "no-key", displayName: "No key", auth: { configured: false }, protocol: "openai-completions", models: [{ id: "m" }] },
    { id: "no-wire", displayName: "No wire", auth: { configured: true }, models: [{ id: "m" }] },
  ] : state)
  render(<SubagentSettings workspaceId="w" bridge={{ request, onEvent: () => () => {} }} />)
  const model = await screen.findByRole("combobox", { name: "模型 general" })
  expect(Array.from((model as HTMLSelectElement).options).filter((row) => row.value).every((row) => row.disabled)).toBe(true)
})
