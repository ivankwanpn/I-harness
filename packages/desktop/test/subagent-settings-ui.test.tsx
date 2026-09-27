// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { SubagentSettings } from "../src/renderer/settings/SubagentSettings.tsx"
afterEach(cleanup)
it("edits a role mapping without silently enabling the global model gate", async () => {
  const state = { enabled: false, effectiveEnabled: false, restartRequired: false, roles: [{ name: "explore" }] }
  const request = vi.fn(async (request) => request.kind === "desktop/provider/directory" ? [{ id: "local", displayName: "Local", models: [{ id: "small" }] }] : state)
  render(<SubagentSettings workspaceId="w" bridge={{ request, onEvent: () => () => {} }} />)
  fireEvent.click(await screen.findByRole("button", { name: "設定角色模型" }))
  fireEvent.change(screen.getByLabelText("提供商 ID"), { target: { value: "local" } })
  fireEvent.change(screen.getByLabelText("模型 ID"), { target: { value: "small" } })
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
    if (request.kind === "desktop/provider/directory") return [{ id: "p", displayName: "P", models: [] }]
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
  fireEvent.click(screen.getByRole("button", { name: "重試" }))
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  await screen.findByText("p / new-model")
  await act(async () => release(initial))
  expect(screen.getByText("p / new-model")).toBeTruthy()
})
