// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { AgentSettings } from "../src/renderer/settings/AgentSettings.tsx"
afterEach(cleanup)
it("saves an explicit experimental Windows backend choice for new assemblies", async () => {
  const defaults = { sandboxMode: "workspace-write", autoCompaction: true, approvalMode: "dangerous", windowsSandboxBackend: "legacy" }
  const initial = { saved: defaults, effective: defaults, source: "settings", restartRequired: false }
  const request = vi.fn(async action => action.kind === "desktop/approval-rules/state" ? { rules: [], candidates: [] } : action.kind === "desktop/agent-settings/state" ? initial : { ...initial, saved: { ...defaults, windowsSandboxBackend: "psec" }, effective: { ...defaults, windowsSandboxBackend: "psec" } })
  render(<AgentSettings workspaceId="w" bridge={{ request, onEvent: () => () => {} }} />)
  fireEvent.change(await screen.findByRole("combobox", { name: "Windows sandbox backend" }), { target: { value: "psec" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  expect(request).toHaveBeenLastCalledWith({ kind: "desktop/agent-settings/configure", workspaceId: "w", patch: { windowsSandboxBackend: "psec" } })
  expect(screen.getByText(/PSEC is experimental/)).toBeTruthy()
})
it("saves automatic compaction live without a restart notice", async () => {
  const initial = { saved: { sandboxMode: "read-only", autoCompaction: true, approvalMode: "dangerous" }, effective: { sandboxMode: "read-only", autoCompaction: true, approvalMode: "dangerous" }, restartRequired: false, source: "settings" }
  const request = vi.fn(async (action) => action.kind === "desktop/approval-rules/state" ? { rules: [], candidates: [] } : action.kind === "desktop/agent-settings/state" ? initial : { ...initial, saved: { ...initial.saved, autoCompaction: false }, effective: { ...initial.effective, autoCompaction: false } })
  render(<AgentSettings workspaceId="w" bridge={{ request, onEvent: () => () => {} }} />)
  const toggle = await screen.findByRole("checkbox", { name: "自動壓縮上下文" })
  fireEvent.click(toggle)
  expect(request.mock.calls.some(([action]) => action.kind === "desktop/agent-settings/configure")).toBe(false)
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  await screen.findByText("已停用")
  expect(screen.queryByText(/重啟/)).toBeNull()
  expect(request).toHaveBeenLastCalledWith({ kind: "desktop/agent-settings/configure", workspaceId: "w", patch: { autoCompaction: false } })
})

it("saves a delegated approval choice", async () => {
  const initial = { saved: { sandboxMode: "workspace-write", autoCompaction: true, approvalMode: "dangerous" }, effective: { sandboxMode: "workspace-write", autoCompaction: true, approvalMode: "dangerous" }, restartRequired: false, source: "settings" }
  const request = vi.fn(async (action) => action.kind === "desktop/approval-rules/state" ? { rules: [], candidates: [] } : action.kind === "desktop/agent-settings/state" ? initial : { ...initial, saved: { ...initial.saved, approvalMode: "delegate" }, effective: { ...initial.effective, approvalMode: "delegate" } })
  render(<AgentSettings workspaceId="w" bridge={{ request, onEvent: () => () => {} }} />)
  const select = await screen.findByRole("combobox", { name: "核準模式" })
  fireEvent.change(select, { target: { value: "delegate" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  expect(request).toHaveBeenLastCalledWith({ kind: "desktop/agent-settings/configure", workspaceId: "w", patch: { approvalMode: "delegate" } })
})

it("selecting full access pairs it with the full-access sandbox in one save", async () => {
  const initial = { saved: { sandboxMode: "workspace-write", autoCompaction: true, approvalMode: "dangerous" }, effective: { sandboxMode: "workspace-write", autoCompaction: true, approvalMode: "dangerous" }, restartRequired: false, source: "settings" }
  const request = vi.fn(async (action) => action.kind === "desktop/approval-rules/state" ? { rules: [], candidates: [] } : action.kind === "desktop/agent-settings/state" ? initial : { ...initial, saved: { ...initial.saved, sandboxMode: "danger-full-access", approvalMode: "full-access" }, effective: { ...initial.effective, sandboxMode: "danger-full-access", approvalMode: "full-access" } })
  const onSandboxChange = vi.fn()
  render(<AgentSettings workspaceId="w" bridge={{ request, onEvent: () => () => {} }} onSandboxChange={onSandboxChange} />)
  const approval = await screen.findByRole("combobox", { name: "核準模式" })
  fireEvent.change(approval, { target: { value: "full-access" } })
  expect((screen.getByRole("combobox", { name: "沙箱" }) as HTMLSelectElement).value).toBe("danger-full-access")
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  expect(request).toHaveBeenLastCalledWith({ kind: "desktop/agent-settings/configure", workspaceId: "w", patch: { approvalMode: "full-access", sandboxMode: "danger-full-access" } })
  await waitFor(() => expect(onSandboxChange).toHaveBeenCalledWith("danger-full-access"))
})
