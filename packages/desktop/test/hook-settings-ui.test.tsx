// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { HookSettings } from "../src/renderer/settings/HookSettings.tsx"
import { useLocale } from "../src/renderer/design/i18n.ts"
beforeEach(() => useLocale.getState().setLocale("zh-TW"))
afterEach(() => { cleanup(); useLocale.getState().setLocale("zh-TW") })
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
  expect(screen.queryByText(/I-harness 目前支援原生 v1 設定/)).toBeNull()
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

it("reviews the complete Claude plugin content before approving its exact handler and bundle hash", async () => {
  const sha256 = "b".repeat(64)
  const pluginRoot = "C:\\plugins\\superpowers"
  const command = { cmd: "bash", args: ["hooks/run-hook.cmd", "session-start"], cwd: pluginRoot }
  const request = vi.fn().mockResolvedValue({ handlers: [{ id: "claude-session-start", name: "superpowers:SessionStart:0", pluginName: "superpowers", event: "session/start", sourceEvent: "SessionStart", configPath: `${pluginRoot}\\hooks\\hooks.json`, configRevision: "configuration-revision-1", command, script: `${pluginRoot}\\hooks\\run-hook.cmd`, sha256, status: "needs-approval", format: "claude-plugin", trustScope: "plugin", pluginRoot }], grants: [], errors: [] })
  render(<HookSettings bridge={{ request, onEvent: () => () => {} }} workspaceId="project-folder" />)
  expect(await screen.findByText("Claude 插件 · SessionStart")).toBeTruthy()
  expect(screen.getByText("superpowers")).toBeTruthy()
  expect(screen.getByText("superpowers:SessionStart:0").closest("details")?.open).toBe(false)
  expect(screen.getByText("等待插件內容授權")).toBeTruthy()
  expect(screen.queryByRole("button", { name: "批准腳本" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "審查插件內容" }))
  expect(request).toHaveBeenCalledTimes(1)
  const confirmation = within(screen.getByRole("group", { name: "確認授權此內容" }))
  expect(confirmation.getByText("superpowers · SessionStart")).toBeTruthy()
  expect(confirmation.getByText(/涵蓋整個插件內容/)).toBeTruthy()
  expect(confirmation.getByText(/使用同一插件內容及設定的已支援處理器可在各自宣告的事件執行/)).toBeTruthy()
  expect(confirmation.getByText(`插件目錄：${pluginRoot}`)).toBeTruthy()
  expect(confirmation.getByText(sha256)).toBeTruthy()
  expect(confirmation.getByText("configuration-revision-1")).toBeTruthy()
  expect(confirmation.getByText((_content, element) => element?.tagName === "PRE" && element.textContent === JSON.stringify(command, null, 2))).toBeTruthy()
  fireEvent.click(confirmation.getByRole("button", { name: "確認授權此內容" }))
  expect(request).toHaveBeenCalledWith({ kind: "desktop/hooks/mutate", workspaceId: "project-folder", command: { action: "approve", id: "claude-session-start", sha256 } })
})

it("keeps each unsupported Claude handler diagnostic alongside the supported SessionStart handler", async () => {
  const configPath = "plugin/hooks/hooks.json"
  const messages = ["PreToolUse hook is not connected", "SessionStart prompt hook is not connected"]
  const request = vi.fn().mockResolvedValue({ handlers: [{ id: "startup", name: "startup command", event: "session/start", sourceEvent: "SessionStart", configPath, script: "plugin", sha256: "c".repeat(64), status: "ready", format: "claude-plugin", trustScope: "plugin", pluginRoot: "plugin" }], grants: [], errors: messages.map((message, index) => ({ configPath, message, kind: "unsupported-handler", source: "plugin", format: "claude-plugin", handlerId: `unsupported-${index}`, event: index === 0 ? "PreToolUse" : "SessionStart" })) })
  render(<HookSettings bridge={{ request, onEvent: () => () => {} }} workspaceId="w" />)
  expect(await screen.findByText("信任檢查通過")).toBeTruthy()
  expect(screen.getByText("Claude 插件 · SessionStart")).toBeTruthy()
  const diagnostics = screen.getAllByRole("note")
  expect(diagnostics).toHaveLength(2)
  for (const [index, diagnostic] of diagnostics.entries()) {
    expect(within(diagnostic).getByText("此 Hook 處理器尚未連接")).toBeTruthy()
    expect(within(diagnostic).getByText(`處理器：unsupported-${index}`)).toBeTruthy()
    expect(within(diagnostic).getByText(index === 0 ? "事件：PreToolUse" : "事件：SessionStart")).toBeTruthy()
    const disclosure = within(diagnostic).getByText(configPath).closest("details")!
    expect(disclosure.open).toBe(false)
    expect(disclosure.textContent).toContain(messages[index])
  }
  expect(screen.queryByRole("alert")).toBeNull()
  expect(screen.queryByText("不支援的 Hook 格式")).toBeNull()
})

it.each([["ready", "信任檢查通過"], ["invalid", "插件內容或設定無效"]] as const)("shows the real %s status of a supported Claude handler without offering approval", async (status, label) => {
  const request = vi.fn().mockResolvedValue({ handlers: [{ id: "startup", name: "startup command", event: "session/start", sourceEvent: "SessionStart", configPath: "plugin/hooks/hooks.json", script: "plugin", sha256: "c".repeat(64), status, format: "claude-plugin", trustScope: "plugin", pluginRoot: "plugin", ...(status === "invalid" ? { error: "plugin contents changed" } : {}) }], grants: [], errors: [] })
  render(<HookSettings bridge={{ request, onEvent: () => () => {} }} workspaceId="w" />)
  expect(await screen.findByText(label)).toBeTruthy()
  expect(screen.getByText("Claude 插件 · SessionStart")).toBeTruthy()
  expect(screen.queryByRole("button", { name: "審查插件內容" })).toBeNull()
  if (status === "invalid") expect(screen.getByText("plugin contents changed").closest("details")).toBeTruthy()
})

it("discards a Claude plugin confirmation when the project folder changes", async () => {
  const sha256 = "d".repeat(64)
  const request = vi.fn().mockResolvedValue({ handlers: [{ id: "a-startup", name: "A startup", event: "session/start", sourceEvent: "SessionStart", configPath: "A/hooks/hooks.json", script: "A", sha256, status: "needs-approval", format: "claude-plugin", trustScope: "plugin", pluginRoot: "A" }], grants: [], errors: [] })
  const bridge = { request, onEvent: () => () => {} }
  const view = render(<HookSettings bridge={bridge} workspaceId="a" />)
  fireEvent.click(await screen.findByRole("button", { name: "審查插件內容" }))
  expect(screen.getByRole("group", { name: "確認授權此內容" })).toBeTruthy()
  request.mockResolvedValueOnce({ handlers: [], grants: [], errors: [] })
  view.rerender(<HookSettings bridge={bridge} workspaceId="b" />)
  expect(await screen.findByText("目前沒有已啟用插件宣告的 Hooks。")).toBeTruthy()
  expect(screen.queryByRole("group", { name: "確認授權此內容" })).toBeNull()
  expect(request.mock.calls.map(([input]) => input.kind)).toEqual(["desktop/hooks/state", "desktop/hooks/state"])
})

it("translates Claude plugin scope and individual unsupported handler diagnostics into English", async () => {
  useLocale.getState().setLocale("en")
  const request = vi.fn().mockResolvedValue({ handlers: [{ id: "startup", name: "startup command", event: "session/start", sourceEvent: "SessionStart", configPath: "plugin/hooks/hooks.json", script: "plugin", sha256: "e".repeat(64), status: "needs-approval", format: "claude-plugin", trustScope: "plugin", pluginRoot: "plugin" }], grants: [], errors: [{ configPath: "plugin/hooks/hooks.json", message: "Stop command is not connected", kind: "unsupported-handler", source: "plugin", format: "claude-plugin", handlerId: "stop-command", event: "Stop" }] })
  render(<HookSettings bridge={{ request, onEvent: () => () => {} }} workspaceId="w" />)
  expect(await screen.findByText("Claude plugin · SessionStart")).toBeTruthy()
  expect(screen.getByText("Awaiting plugin content approval")).toBeTruthy()
  expect(screen.getByText("Event: Stop")).toBeTruthy()
  expect(screen.getByText("Handler: stop-command")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Review plugin content" }))
  expect(within(screen.getByRole("group", { name: "Confirm content approval" })).getByText(/complete plugin content, including scripts and resources/)).toBeTruthy()
})

it.each([["global", "全域"], ["workspace", "專案"]] as const)("retains an alert for %s authored configuration errors", async (source, label) => {
  const request = vi.fn().mockResolvedValue({ handlers: [], grants: [], errors: [{ configPath: "home/hooks/authored/hooks.json", message: "HookUnsupportedFormatError: unsupported", kind: "invalid", source, format: "claude-plugin" }] })
  render(<HookSettings bridge={{ request, onEvent: () => () => {} }} workspaceId="w" />)
  expect(await screen.findByRole("alert")).toBeTruthy()
  expect(screen.getByText("Hook 設定無效")).toBeTruthy()
  expect(screen.getByText(`來源：${label}`)).toBeTruthy()
  expect(screen.queryByRole("button", { name: "批准腳本" })).toBeNull()
})
