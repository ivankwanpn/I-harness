// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { SettingsPane } from "../src/renderer/settings/SettingsPane.tsx"
import { AgentShellSettings } from "../src/renderer/settings/AgentShellSettings.tsx"
import { useLocale } from "../src/renderer/design/i18n.ts"
import type { DesktopRequest } from "../src/shared/bridge.ts"

beforeEach(() => { localStorage.clear(); useLocale.getState().setLocale("zh-TW") })
afterEach(cleanup)
const host = { executionTarget: "host", selected: "auto", options: [{ id: "auto", label: "Auto", command: "D:/owned/pwsh.exe", dialect: "powershell" }, { id: "pwsh", label: "PowerShell", command: "D:/owned/pwsh.exe", dialect: "powershell" }, { id: "cmd", label: "CMD", command: "D:/owned/cmd.exe", dialect: "cmd" }], resolved: { id: "auto", command: "D:/owned/pwsh.exe" } }
const wsl = { executionTarget: "wsl", nativeSelected: "auto", selected: "bash", options: [{ id: "bash", label: "Linux Bash", command: "/bin/bash", dialect: "posix" }], resolved: { id: "bash", command: "/bin/bash" } }

it("refreshes the retained shell binding after a successful WSL defaults save", async () => {
  let saved = { sandboxMode: "workspace-write", approvalMode: "ask-all", autoCompaction: true, webSearchMode: "disabled", windowsSandboxBackend: "legacy", wslExecution: { distribution: "Ubuntu", networkAccess: false, workspaceDependencies: true } }
  const request = vi.fn(async (input: DesktopRequest) => {
    if (input.kind === "desktop/agent-settings/state") return { saved, effective: saved, source: "settings", restartRequired: false }
    if (input.kind === "desktop/agent-settings/configure") { saved = { ...saved, ...input.patch } as typeof saved; return { saved, effective: saved, source: "settings", restartRequired: false } }
    if (input.kind === "desktop/agent-shell/state") return saved.windowsSandboxBackend === "wsl" ? wsl : host
    if (input.kind === "desktop/wsl/state") return { selected: saved.wslExecution, distributions: [{ name: "Ubuntu", version: 2, state: "Stopped" }], capabilities: { diagnose: false, repair: false } }
    if (input.kind === "desktop/approval-rules/state") return { rules: [], candidates: [] }
    if (input.kind === "desktop/local/state") return { notifications: false, notificationsSupported: true }
    if (input.kind === "desktop/global-preferences/state") return { enabled: false }
    return {}
  })
  render(<SettingsPane workspace={{ id: "binding-a", label: "A", path: "D:/owned/a" }} bridge={{ request, onEvent: () => () => {} }} capabilities={{ "desktop-agent-settings": ["1"], "desktop-agent-shell": ["1"] }} onClose={() => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "執行與權限" }))
  const shell = await screen.findByRole("combobox", { name: "Agent Shell" }) as HTMLSelectElement
  await waitFor(() => expect(shell.disabled).toBe(false))
  fireEvent.change(screen.getByRole("combobox", { name: "Windows 執行後端" }), { target: { value: "wsl" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存" }))
  await waitFor(() => expect(shell.value).toBe("bash"))
  expect(shell.disabled).toBe(true)
  expect(screen.getByRole("combobox", { name: "Agent Shell" })).toBe(shell)
  expect(screen.getByText("/bin/bash")).toBeTruthy()
  expect(request.mock.calls.filter(([input]) => input.kind === "desktop/agent-shell/state")).toHaveLength(2)
})

it("preserves a pending native mutation across binding reads and rejects its obsolete acknowledgement", async () => {
  let release!: (value: unknown) => void
  const pending = new Promise(resolve => { release = resolve })
  let binding = host
  const request = vi.fn(async (input: DesktopRequest) => input.kind === "desktop/agent-shell/configure" ? pending : binding)
  const props = { workspaceId: "binding-a", bridge: { request, onEvent: () => () => {} } }
  const view = render(<AgentShellSettings {...props} refreshRevision={0} />)
  const shell = screen.getByRole("combobox", { name: "Agent Shell" }) as HTMLSelectElement
  await waitFor(() => expect(shell.disabled).toBe(false))
  fireEvent.change(shell, { target: { value: "pwsh" } })
  await waitFor(() => expect(shell.disabled).toBe(true))
  binding = wsl as typeof host
  view.rerender(<AgentShellSettings {...props} refreshRevision={1} />)
  await waitFor(() => expect(shell.value).toBe("bash"))
  expect(screen.getByRole("combobox", { name: "Agent Shell" })).toBe(shell)
  binding = { ...host, selected: "cmd", resolved: { id: "cmd", command: "D:/owned/cmd.exe" } }
  view.rerender(<AgentShellSettings {...props} refreshRevision={2} />)
  await waitFor(() => expect(shell.value).toBe("cmd"))
  expect(shell.disabled).toBe(true)
  await act(async () => release({ ...host, selected: "pwsh" }))
  await waitFor(() => expect(shell.disabled).toBe(false))
  expect(shell.value).toBe("cmd")
  expect(request.mock.calls.filter(([input]) => input.kind === "desktop/agent-shell/configure")).toHaveLength(1)
})

it("rejects an old native read after a newer WSL binding has arrived", async () => {
  let release!: (value: unknown) => void
  const oldRead = new Promise(resolve => { release = resolve })
  let reads = 0
  const request = vi.fn(async () => ++reads === 1 ? oldRead : wsl)
  const props = { workspaceId: "binding-a", bridge: { request, onEvent: () => () => {} } }
  const view = render(<AgentShellSettings {...props} refreshRevision={0} />)
  view.rerender(<AgentShellSettings {...props} refreshRevision={1} />)
  const shell = screen.getByRole("combobox", { name: "Agent Shell" }) as HTMLSelectElement
  await waitFor(() => expect(shell.value).toBe("bash"))
  await act(async () => release(host))
  expect(shell.value).toBe("bash")
  expect(shell.disabled).toBe(true)
  expect(screen.getByText("/bin/bash")).toBeTruthy()
})
