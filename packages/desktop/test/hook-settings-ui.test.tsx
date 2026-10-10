// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { HookSettings } from "../src/renderer/settings/HookSettings.tsx"
afterEach(cleanup)
it("requires reviewing the exact script grant before sending approval", async () => {
  const sha256 = "a".repeat(64)
  const state = { handlers: [{ id: "h", name: "observe", event: "pre-tool", configPath: "plugin/hooks.json", script: "plugin/hook.cjs", sha256, status: "needs-approval" }], grants: [], errors: [] }
  const request = vi.fn().mockResolvedValue(state)
  render(<HookSettings bridge={{ request, onEvent: () => () => {} }} workspaceId="w" />)
  fireEvent.click(await screen.findByRole("button", { name: "批准腳本" }))
  expect(request).toHaveBeenCalledTimes(1)
  expect(screen.getAllByText(sha256).length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole("button", { name: "確認授權此內容" }))
  expect(request).toHaveBeenCalledWith({ kind: "desktop/hooks/mutate", workspaceId: "w", command: { action: "approve", id: "h", sha256 } })
})

it("shows inactive plugin source and format with raw diagnostics in a disclosure", async () => {
  const configPath = "C:\\Users\\fixture\\.i-harness\\plugins\\superpowers\\hooks\\hooks.json"
  const message = "HookUnsupportedFormatError: Claude plugin hook format is unsupported"
  const request = vi.fn().mockResolvedValue({ handlers: [], grants: [], errors: [{ configPath, message, kind: "unsupported-format", source: "plugin", format: "claude-plugin" }] })
  render(<HookSettings bridge={{ request, onEvent: () => () => {} }} workspaceId="w" />)
  expect(await screen.findByText("不支援的 Hook 格式")).toBeTruthy()
  expect(screen.getByText("來源：插件")).toBeTruthy()
  expect(screen.getByText("格式：Claude 插件格式")).toBeTruthy()
  expect(screen.queryByRole("button", { name: "批准腳本" })).toBeNull()
  const disclosure = screen.getByText(configPath).closest("details")!
  expect(disclosure).toBeTruthy()
  expect(disclosure.open).toBe(false)
  expect(disclosure.textContent).toContain(message)
  expect(screen.queryByRole("alert")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "重新套用 Hooks" }))
  expect(await screen.findByText("不支援的 Hook 格式")).toBeTruthy()
  expect(request).toHaveBeenCalledWith({ kind: "desktop/hooks/refresh", workspaceId: "w" })
})

it.each([["global", "全域"], ["workspace", "專案"]] as const)("retains an alert for %s authored configuration errors", async (source, label) => {
  const request = vi.fn().mockResolvedValue({ handlers: [], grants: [], errors: [{ configPath: "home/hooks/authored/hooks.json", message: "HookUnsupportedFormatError: unsupported", kind: "invalid", source, format: "claude-plugin" }] })
  render(<HookSettings bridge={{ request, onEvent: () => () => {} }} workspaceId="w" />)
  expect(await screen.findByRole("alert")).toBeTruthy()
  expect(screen.getByText("Hook 設定無效")).toBeTruthy()
  expect(screen.getByText(`來源：${label}`)).toBeTruthy()
  expect(screen.queryByRole("button", { name: "批准腳本" })).toBeNull()
})
