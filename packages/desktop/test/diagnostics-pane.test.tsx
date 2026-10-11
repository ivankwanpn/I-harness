// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { DiagnosticsPane } from "../src/renderer/settings/DiagnosticsPane.tsx"
import { useLocale } from "../src/renderer/design/i18n.ts"
import type { DiagnosticsRequest, EnvironmentDiagnosticsView } from "@i-harness/desktop-gateway/src/environment-diagnostics.ts"

const cold: EnvironmentDiagnosticsView = { live: false, tools: [], roles: [], executables: [{ name: "Agent Shell", command: "C:/Windows/pwsh.exe", status: "untested" }, { name: "Node.js", command: "C:/Program Files/I-harness/I-harness.exe", status: "untested" }, { name: "Git", command: "git", status: "untested" }], shell: { selected: "pwsh", options: [], executionTarget: "host", resolved: { id: "pwsh", label: "PowerShell", command: "C:/Windows/pwsh.exe", dialect: "powershell" } } }
const live: EnvironmentDiagnosticsView = { ...cold, live: true, effectiveMode: "mixed", tools: [{ name: "read_file", exposure: "direct", modelVisible: true }, { name: "web_search", exposure: "deferred", modelVisible: false }, { name: "internal_commit", exposure: "hidden", modelVisible: false }], roles: [{ name: "explore", allowlist: ["read_file", "rg"] }] }
beforeEach(() => useLocale.getState().setLocale("zh-TW"))
afterEach(cleanup)

it("explains cold diagnostics without reporting zero healthy tools or running a probe", async () => {
  const request = vi.fn(async (_value: DiagnosticsRequest) => cold)
  render(<DiagnosticsPane bridge={{ request }} workspaceId="w" />)
  expect(await screen.findByText("尚無活躍環境")).toBeTruthy()
  expect(screen.getByText(/下一次傳送任務/)).toBeTruthy()
  expect(screen.getByText("設定的 Agent Shell")).toBeTruthy()
  expect(screen.getAllByText("尚未檢查").length).toBeGreaterThan(0)
  expect(screen.queryByText("0 個可用工具")).toBeNull()
  expect(request).toHaveBeenCalledTimes(1)
  expect(request).toHaveBeenCalledWith({ kind: "desktop/environment/diagnostics", workspaceId: "w", probe: false })
  fireEvent.click(screen.getByRole("button", { name: "重新整理" }))
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
  expect(request.mock.calls.every(([value]) => value.probe === false)).toBe(true)
})

it("probes only on explicit action and preserves previous evidence after probe failure", async () => {
  const request = vi.fn(async (value: DiagnosticsRequest) => { if (value.probe) throw new Error("probe failed"); return live })
  render(<DiagnosticsPane bridge={{ request }} workspaceId="w" sessionId="s" />)
  await screen.findByText("執行環境已建立")
  fireEvent.click(screen.getByRole("button", { name: "檢查環境" }))
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("probe failed"))
  expect(screen.getByText("PowerShell")).toBeTruthy()
  expect(request).toHaveBeenLastCalledWith({ kind: "desktop/environment/diagnostics", workspaceId: "w", sessionId: "s", probe: true })
})

it("shows localized probe status with collapsed paths and explains the bundled Node runtime", async () => {
  const snapshot = { ...live, executables: [{ name: "Node.js", command: cold.executables[1]!.command, status: "available" as const, version: "v24.1.0" }, { name: "Git", command: "git", status: "not-installed" as const }, { name: "ripgrep", command: "rg", status: "unavailable" as const, error: "Version probe timed out" }] }
  const { container } = render(<DiagnosticsPane bridge={{ request: async () => snapshot }} workspaceId="w" />)
  await screen.findByText("已確認可用")
  expect(screen.getByText("找不到執行檔")).toBeTruthy()
  expect(screen.getByText("檢查失敗")).toBeTruthy()
  expect(screen.getAllByText(/I-harness.exe/)[0]).toBeTruthy()
  expect(container.querySelector(".diagnostics-executable details")?.hasAttribute("open")).toBe(false)
  expect(screen.queryByText("not-installed")).toBeNull()
})

it("keeps WSL shell diagnosis separate from host executable checks", async () => {
  const snapshot = { ...cold, shell: { ...cold.shell!, executionTarget: "wsl" as const, resolved: { id: "bash" as const, label: "WSL Bash", command: "/bin/bash", dialect: "posix" as const } } }
  render(<DiagnosticsPane bridge={{ request: async () => snapshot }} workspaceId="w" />)
  await screen.findByText("WSL · Linux")
  expect(screen.getByText(/此處的版本檢查在主機執行/)).toBeTruthy()
  expect(screen.getAllByText(/設定 → 執行與權限/)[0]).toBeTruthy()
})

it("searches advanced declarations and explains visibility without implying execution permission", async () => {
  render(<DiagnosticsPane bridge={{ request: async () => live }} workspaceId="w" />)
  await screen.findByText("執行環境已建立")
  fireEvent.click(screen.getByText("工具與角色"))
  expect(screen.getByText(/工具宣告不等於執行權限/)).toBeTruthy()
  fireEvent.change(screen.getByRole("searchbox", { name: "搜尋工具名稱" }), { target: { value: "web" } })
  expect(screen.getByText("web_search")).toBeTruthy()
  expect(screen.queryByText("internal_commit")).toBeNull()
  expect(screen.getByText("按需載入")).toBeTruthy()
  expect(screen.getByText("explore")).toBeTruthy()
})

it("ignores a probe response belonging to an earlier conversation", async () => {
  let resolve!: (value: EnvironmentDiagnosticsView) => void
  const request = vi.fn((value: DiagnosticsRequest) => value.probe ? new Promise<EnvironmentDiagnosticsView>(done => { resolve = done }) : Promise.resolve(value.sessionId === "old" ? live : { ...cold, shell: undefined }))
  const props = { bridge: { request }, workspaceId: "w" }
  const pane = render(<DiagnosticsPane {...props} sessionId="old" />)
  await screen.findByText("執行環境已建立")
  fireEvent.click(screen.getByRole("button", { name: "檢查環境" }))
  pane.rerender(<DiagnosticsPane {...props} sessionId="new" />)
  await screen.findByText("尚無活躍環境")
  await act(async () => resolve(live))
  expect(screen.queryByText("執行環境已建立")).toBeNull()
  expect(screen.queryByText("PowerShell")).toBeNull()
})

it("does not count shell configuration failure as an executed version check", async () => {
  render(<DiagnosticsPane bridge={{ request: async () => ({ ...cold, shell: { selected: "auto", options: [], error: "configured shell missing" }, executables: [{ name: "Agent Shell", status: "unavailable", error: "configured shell missing" }] }) }} workspaceId="w" />)
  await screen.findByText("尚無活躍環境")
  expect(screen.queryByText("1 項有檢查結果")).toBeNull()
  expect(screen.queryByText("檢查失敗")).toBeNull()
  expect(screen.getByText("設定不可用")).toBeTruthy()
})
