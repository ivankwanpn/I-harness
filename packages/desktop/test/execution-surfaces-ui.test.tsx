// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ExecutionPane } from "../src/renderer/session/ExecutionPane.tsx"
import { AgentProcessesPane } from "../src/renderer/session/AgentProcessesPane.tsx"
import { CodeModeSettings } from "../src/renderer/settings/CodeModeSettings.tsx"
import { DiagnosticsPane } from "../src/renderer/settings/DiagnosticsPane.tsx"
import { WorkflowJobs } from "../src/renderer/session/WorkflowJobsReviews.tsx"
afterEach(cleanup)
const cell = { id: "cell", ownerSessionId: "s", status: "running", source: "text('hi')", live: true, canTerminate: true, truncated: false, output: [{ kind: "text", text: "hi" }], calls: [{ id: "call", name: "read", args: "{}", output: "nested result", dispatched: true }] }
const execution = { sessionId: "s", live: true, effectiveMode: "mixed", cells: [cell], total: 1, offset: 0, hasMore: false }
it("shows historical PTY evidence and saved output without offering live controls", async () => {
  const request = vi.fn(async input => input.kind.endsWith("terminal-output") ? { text: "saved PTY output", live: false, reason: "Only saved read snapshots are available", truncated: false }
    : { sessionId: "s", live: false, jobs: [], terminals: [{ id: "old", command: "node", pid: 1, ownerSessionId: "s", status: "running", cols: 80, rows: 24, live: false, canControl: false, outputAvailable: true, outputReason: "Only saved read snapshots are available" }, { id: "empty", command: "pwsh", ownerSessionId: "s", status: "running", live: false, canControl: false, outputAvailable: false, outputReason: "No terminal_read output was saved" }] })
  render(<AgentProcessesPane bridge={{ request }} workspaceId="w" sessionId="s" />)
  fireEvent.click(await screen.findByRole("button", { name: "查看輸出" }))
  expect(await screen.findByText("saved PTY output")).toBeTruthy()
  expect(screen.getByText("No terminal_read output was saved")).toBeTruthy()
  expect(screen.queryByRole("button", { name: "終止程序" })).toBeNull(); expect(screen.queryByRole("textbox", { name: "終端輸入" })).toBeNull(); expect(screen.queryByRole("button", { name: "讀取後續輸出" })).toBeNull()
  expect(request).toHaveBeenCalledWith({ kind: "desktop/session/processes/terminal-output", workspaceId: "w", sessionId: "s", id: "old" })
  expect(request.mock.calls.some(([input]) => input.kind.endsWith("control"))).toBe(false)
})

it("shows code/output/nested trace and confirms a cell stop using the exact session owner", async () => {
  const request = vi.fn().mockImplementation(async input => input.kind.endsWith("stop") ? { stopped: true } : execution)
  render(<ExecutionPane bridge={{ request }} workspaceId="w" sessionId="s" />)
  expect(await screen.findByText("text('hi')")).toBeTruthy()
  fireEvent.click(screen.getByRole("tab", { name: "輸出" })); expect(screen.getByText("hi")).toBeTruthy()
  fireEvent.click(screen.getByRole("tab", { name: "巢狀呼叫" })); expect(screen.getByText("nested result")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "停止 cell" }))
  expect(request.mock.calls.some(([input]) => input.kind.endsWith("stop"))).toBe(false)
  fireEvent.click(within(screen.getByRole("dialog", { name: "確認停止 cell" })).getByRole("button", { name: "確認停止" }))
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "desktop/session/execution/stop", workspaceId: "w", sessionId: "s", cellId: "cell" }))
})

it("discards a stale history response after changing sessions and keeps cold cells read only", async () => {
  let release!: (value: unknown) => void
  const old = new Promise(resolve => { release = resolve })
  const request = vi.fn().mockImplementation(input => input.sessionId === "s" ? old : Promise.resolve({ ...execution, sessionId: "cold", live: false, cells: [{ ...cell, id: "cold-cell", ownerSessionId: "cold", source: "cold source", live: false, canTerminate: false }] }))
  const view = render(<ExecutionPane bridge={{ request }} workspaceId="w" sessionId="s" />)
  view.rerender(<ExecutionPane bridge={{ request }} workspaceId="w" sessionId="cold" />)
  expect(await screen.findByText("cold source")).toBeTruthy()
  release(execution)
  await vi.waitFor(() => expect(screen.queryByText("text('hi')")).toBeNull())
  expect(screen.queryByRole("button", { name: "停止 cell" })).toBeNull()
})

it("shows saved and effective Code Mode separately and retains the saved value on failure", async () => {
  const request = vi.fn().mockResolvedValueOnce({ saved: { mode: "only" }, effective: "mixed", live: true }).mockRejectedValueOnce(new Error("disk failure"))
  render(<CodeModeSettings bridge={{ request }} workspaceId="w" sessionId="s" />)
  const select = await screen.findByRole("combobox", { name: "Code Mode" }) as HTMLSelectElement
  expect(select.value).toBe("only")
  expect(screen.getByRole("status").textContent).toContain("mixed")
  fireEvent.change(select, { target: { value: "off" } })
  expect(await screen.findByRole("alert")).toBeTruthy()
  expect(select.value).toBe("only")
})

it("reads owner process output, sends only explicit input, and retains its draft on refusal", async () => {
  const request = vi.fn().mockImplementation(async input => {
    if (input.kind.endsWith("control")) { if (input.command.action === "send") throw new Error("sandbox refused"); return { data: "actual output", nextOffset: 13, truncated: false, status: "running" } }
    return { sessionId: "s", live: true, jobs: [], terminals: [{ id: "t", ownerSessionId: "s", command: "node", pid: 123, status: "running", cols: 80, rows: 24, beganAt: "2026-10-03", live: true, canControl: true }] }
  })
  render(<AgentProcessesPane bridge={{ request }} workspaceId="w" sessionId="s" />)
  fireEvent.click(await screen.findByRole("button", { name: "附接輸出" }))
  expect(await screen.findByText("actual output")).toBeTruthy()
  fireEvent.change(screen.getByRole("textbox", { name: "終端輸入" }), { target: { value: "my command" } })
  fireEvent.click(screen.getByRole("button", { name: "送出輸入" }))
  expect(await screen.findByRole("alert")).toBeTruthy()
  expect((screen.getByRole("textbox", { name: "終端輸入" }) as HTMLTextAreaElement).value).toBe("my command")
  expect(request).toHaveBeenCalledWith({ kind: "desktop/session/processes/control", workspaceId: "w", sessionId: "s", command: { action: "send", id: "t", data: "my command\r" } })
})

it("keeps diagnostics declarations distinct from actual version probe statuses", async () => {
  const request = vi.fn().mockResolvedValue({ live: true, effectiveMode: "only", tools: [{ name: "read", exposure: "direct", modelVisible: false }, { name: "remote", exposure: "deferred", modelVisible: false }], roles: [{ name: "explore", allowlist: ["read"] }], shell: { selected: "cmd", options: [], error: "shell unavailable" }, executables: [{ name: "missing", status: "not-installed" }] })
  render(<DiagnosticsPane bridge={{ request }} workspaceId="w" sessionId="s" />)
  expect(await screen.findByText("remote")).toBeTruthy()
  expect(screen.getByText("not-installed")).toBeTruthy()
  expect(screen.getByText("explore")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "檢測執行檔版本" }))
  await vi.waitFor(() => expect(request).toHaveBeenLastCalledWith({ kind: "desktop/environment/diagnostics", workspaceId: "w", sessionId: "s", probe: true }))
})

it("clears an old workflow job output on session switch and ignores its pending reply", async () => {
  let release!: (value: unknown) => void
  const request = vi.fn(() => new Promise(resolve => { release = resolve }))
  const props = { bridge: { request, onEvent: () => () => {} }, workspaceId: "w", disabled: false, mutate: async () => true, jobs: [{ jobId: "job", label: "old job", kind: "shell", status: "completed" as const, outputAvailable: true, live: false, canCancel: false }] }
  const pane = render(<WorkflowJobs {...props} sessionId="old" />)
  fireEvent.click(screen.getByRole("button", { name: "查看輸出" }))
  pane.rerender(<WorkflowJobs {...props} sessionId="new" jobs={[]} />)
  release({ text: "old output", truncated: false })
  await vi.waitFor(() => expect(screen.queryByRole("region", { name: "背景任務輸出" })).toBeNull())
})
