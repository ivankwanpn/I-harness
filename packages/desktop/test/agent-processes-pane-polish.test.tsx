// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { AgentProcessesRequest, AgentProcessesView } from "@i-harness/desktop-gateway/src/agent-processes.ts"
import { AgentProcessesPane } from "../src/renderer/session/AgentProcessesPane.tsx"
import { WindowVisibilityProvider } from "../src/renderer/window-visibility.tsx"
import type { DesktopBridge, DesktopEvent, DesktopRequest } from "../src/shared/bridge.ts"

afterEach(() => { cleanup(); vi.useRealTimers() })
const terminal = { id: "t1", ownerSessionId: "s", command: "node owned-fixture.mjs", pid: 42, status: "running" as const, cols: 80, rows: 24, live: true, canControl: true, outputAvailable: true }
const job = { jobId: "j1", ownerSessionId: "s", kind: "shell", label: "Owned job", status: "running" as const, outputAvailable: true, live: true, canCancel: true }
const base: AgentProcessesView = { sessionId: "s", live: true, terminals: [terminal], jobs: [job] }

it("coalesces same-session process changes, falls back while idle, and keeps polling live jobs", async () => {
  vi.useFakeTimers()
  const first = Promise.withResolvers<AgentProcessesView>()
  const quiet = { ...base, terminals: [], jobs: [{ ...job, status: "completed" as const, live: false, canCancel: false }] }
  let snapshot: AgentProcessesView = quiet, listener: ((event: DesktopEvent) => void) | undefined
  const request = vi.fn(async () => {
    expect(listener).toBeDefined()
    return request.mock.calls.length === 1 ? first.promise : snapshot
  })
  const bridge = { request, onEvent: (subscribe: (event: DesktopEvent) => void) => { listener = subscribe; return () => { listener = undefined } } }
  const notice = (event: { type: string; name?: string; kind?: string }, workspaceId = "w", sessionId = "s"): DesktopEvent =>
    ({ kind: "sdk/notification", workspaceId, method: "session/event", params: { sessionId, event } })
  await act(async () => { render(<AgentProcessesPane bridge={bridge} workspaceId="w" sessionId="s" />) })
  await act(async () => {
    listener!(notice({ type: "exec/end" }))
    listener!(notice({ type: "tool/result", name: "terminal_open" }))
    await vi.advanceTimersByTimeAsync(750)
    expect(request).toHaveBeenCalledTimes(1)
    first.resolve(quiet)
  })
  await act(async () => { await vi.advanceTimersByTimeAsync(250) })
  expect(request).toHaveBeenCalledTimes(2)
  await act(async () => {
    listener!(notice({ type: "assistant/message" }))
    listener!(notice({ type: "tool/result", name: "read" }))
    listener!(notice({ type: "exec/end" }, "other"))
    listener!(notice({ type: "exec/end" }, "w", "other"))
    await vi.advanceTimersByTimeAsync(5000)
  })
  expect(request).toHaveBeenCalledTimes(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(10050) })
  expect(request).toHaveBeenCalledTimes(3)
  snapshot = { ...base, terminals: [] }
  await act(async () => {
    listener!(notice({ type: "agent/delivery-source", kind: "exec" }))
    await vi.advanceTimersByTimeAsync(250)
  })
  expect(request).toHaveBeenCalledTimes(4)
  await act(async () => { await vi.advanceTimersByTimeAsync(1550) })
  expect(request).toHaveBeenCalledTimes(5)
})

it("revalidates a quiet process list when the native window becomes visible again", async () => {
  vi.useFakeTimers()
  const listeners = new Set<(event: DesktopEvent) => void>()
  const request = vi.fn(async (input: DesktopRequest) => input.kind === "window/state" ? { visible: true, maximized: false } : { ...base, jobs: [], terminals: [] })
  const bridge: DesktopBridge = { request, onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) } }
  const emit = (event: DesktopEvent) => { for (const listener of listeners) listener(event) }
  const reads = () => request.mock.calls.filter(([input]) => input.kind === "desktop/session/processes/read")
  await act(async () => { render(<WindowVisibilityProvider bridge={bridge}><AgentProcessesPane bridge={bridge} workspaceId="w" sessionId="s" /></WindowVisibilityProvider>) })
  expect(reads()).toHaveLength(1)
  await act(async () => { emit({ kind: "window/state", maximized: false, visible: false }) })
  await act(async () => {
    emit({ kind: "sdk/notification", workspaceId: "w", method: "session/status", params: { sessionId: "s", status: "completed" } })
    await vi.advanceTimersByTimeAsync(16000)
  })
  expect(reads()).toHaveLength(1)
  await act(async () => { emit({ kind: "window/state", maximized: false, visible: true }) })
  await act(async () => { await vi.advanceTimersByTimeAsync(10) })
  expect(reads()).toHaveLength(2)
})

it("replaces full job snapshots when refreshing instead of duplicating the captured output", async () => {
  let reads = 0
  const request = async (input: AgentProcessesRequest) => input.kind === "desktop/session/processes/job-output" ? { text: ++reads === 1 ? "first snapshot" : "first snapshot\nnew evidence", truncated: false, ownerSessionId: "s", live: true } : { ...base, terminals: [] }
  const view = render(<AgentProcessesPane bridge={{ request }} workspaceId="w" sessionId="s" />)
  fireEvent.click(await screen.findByRole("button", { name: "查看輸出" }))
  await waitFor(() => expect(view.container.querySelector("pre")?.textContent).toBe("first snapshot"))
  fireEvent.click(screen.getByRole("button", { name: /讀取後續輸出|重新讀取輸出/ }))
  await waitFor(() => expect(view.container.querySelector("pre")?.textContent).toBe("first snapshot\nnew evidence"))
})

it("opens and refreshes the exact historical native job when a new runtime reuses the short ID", async () => {
  const older = { ...job, backend: "shell" as const, label: "Previous command", status: "completed" as const, live: false, canCancel: false,
    nativeJob: { version: 1 as const, jobId: job.jobId, ownerSessionId: "s", instanceId: "older-instance", sourceId: "process:previous" } }
  const newer = { ...job, backend: "shell" as const, label: "Current command",
    nativeJob: { ...older.nativeJob, instanceId: "current-instance", sourceId: "process:current" } }
  const requests: AgentProcessesRequest[] = []
  const request = async (input: AgentProcessesRequest) => {
    if (input.kind === "desktop/session/processes/read") return { ...base, terminals: [], jobs: [newer, older] }
    requests.push(input)
    if (input.kind === "desktop/session/processes/job-output") return { text: input.instanceId, ownerSessionId: "s", live: false }
    return {}
  }
  const { container } = render(<AgentProcessesPane bridge={{ request }} workspaceId="w" sessionId="s" />)
  const history = (await screen.findByRole("heading", { name: "Previous command" })).closest("article")!
  const current = screen.getByRole("heading", { name: "Current command" }).closest("article")!
  fireEvent.click(within(history).getByRole("button", { name: "查看輸出" }))
  await waitFor(() => expect(container.querySelector("pre")?.textContent).toBe("older-instance"))
  fireEvent.click(screen.getByRole("button", { name: "重新讀取輸出" }))
  await waitFor(() => expect(requests).toHaveLength(2))
  await waitFor(() => expect(within(current).getByRole("button", { name: "取消工作" }).hasAttribute("disabled")).toBe(false))
  fireEvent.click(within(current).getByRole("button", { name: "取消工作" }))
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "確認執行" }))
  await waitFor(() => expect(requests).toEqual([
    ...Array.from({ length: 2 }, () => ({ kind: "desktop/session/processes/job-output", workspaceId: "w", sessionId: "s",
      id: "j1", backend: "shell", instanceId: "older-instance", sourceId: "process:previous" })),
    { kind: "desktop/session/processes/control", workspaceId: "w", sessionId: "s",
      command: { action: "job/cancel", id: "j1", backend: "shell", instanceId: "current-instance", sourceId: "process:current" } },
  ]))
})

it("appends only live terminal offset data and preserves prior retention loss", async () => {
  const commands: unknown[] = []
  const request = async (input: AgentProcessesRequest) => {
    if (input.kind === "desktop/session/processes/control") {
      commands.push(input.command)
      return input.command.action === "read" && input.command.offset === 0 ? { data: "first\n", nextOffset: 6, truncated: true, dropped: true } : { data: "second", nextOffset: 12, truncated: false, dropped: false }
    }
    return { ...base, jobs: [] }
  }
  const view = render(<AgentProcessesPane bridge={{ request }} workspaceId="w" sessionId="s" />)
  fireEvent.click(await screen.findByRole("button", { name: "附接輸出" }))
  await waitFor(() => expect(view.container.querySelector("pre")?.textContent).toBe("first\n"))
  fireEvent.click(screen.getByRole("button", { name: "讀取後續輸出" }))
  await waitFor(() => expect(view.container.querySelector("pre")?.textContent).toBe("first\nsecond"))
  expect(commands).toEqual([{ action: "read", id: "t1", offset: 0 }, { action: "read", id: "t1", offset: 6 }])
  expect(screen.getByText("較早輸出已離開保留視窗")).toBeTruthy()
  expect(screen.getByText("輸出已截斷")).toBeTruthy()
})

it("bounds large snapshot output while copying all of the returned capture", async () => {
  const text = "captured " + "x".repeat(120000) + " final evidence", writes: string[] = []
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { writes.push(value) } } })
  const request = async (input: AgentProcessesRequest) => input.kind === "desktop/session/processes/job-output" ? { text, truncated: true, ownerSessionId: "s", live: false } : { ...base, live: false, terminals: [], jobs: [{ ...job, live: false, canCancel: false }] }
  const view = render(<AgentProcessesPane bridge={{ request }} workspaceId="w" sessionId="s" />)
  fireEvent.click(await screen.findByRole("button", { name: "查看輸出" }))
  await waitFor(() => expect(view.container.querySelector("pre")).toBeTruthy())
  expect(view.container.textContent!.length).toBeLessThan(6000)
  fireEvent.click(screen.getByRole("button", { name: "複製 程序輸出" }))
  await waitFor(() => expect(writes).toEqual([text]))
  expect(screen.queryByRole("button", { name: "讀取後續輸出" })).toBeNull()
})

it("keeps terminal input drafts with their selected terminal and retains a refused send", async () => {
  const commands: unknown[] = []
  const request = async (input: AgentProcessesRequest) => {
    if (input.kind === "desktop/session/processes/control") {
      commands.push(input.command)
      if (input.command.action === "send") throw new Error("actual refusal")
      return { data: "captured terminal", nextOffset: 17, truncated: false }
    }
    return { ...base, terminals: [terminal, { ...terminal, id: "t2", command: "pwsh owned-fixture.ps1" }], jobs: [] }
  }
  render(<AgentProcessesPane bridge={{ request }} workspaceId="w" sessionId="s" />)
  const attach = await screen.findAllByRole("button", { name: "附接輸出" })
  fireEvent.click(attach[0]!)
  const first = await screen.findByRole("textbox", { name: "終端輸入" }) as HTMLTextAreaElement
  fireEvent.change(first, { target: { value: "first command" } })
  fireEvent.click(attach[1]!)
  await waitFor(() => expect(screen.getByRole("textbox", { name: "終端輸入" }).getAttribute("data-terminal-id")).toBe("t2"))
  expect((screen.getByRole("textbox", { name: "終端輸入" }) as HTMLTextAreaElement).value).toBe("")
  fireEvent.change(screen.getByRole("textbox", { name: "終端輸入" }), { target: { value: "second command" } })
  fireEvent.click(attach[0]!)
  await waitFor(() => expect((screen.getByRole("textbox", { name: "終端輸入" }) as HTMLTextAreaElement).value).toBe("first command"))
  fireEvent.click(screen.getByRole("button", { name: "送出輸入" }))
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "actual refusal")
  expect((screen.getByRole("textbox", { name: "終端輸入" }) as HTMLTextAreaElement).value).toBe("first command")
  expect(commands.at(-1)).toEqual({ action: "send", id: "t1", data: "first command\r" })
})

it("uses a focused modal, honors IME Escape and restores the process action trigger", async () => {
  const request = async () => ({ ...base, jobs: [] })
  render(<AgentProcessesPane bridge={{ request }} workspaceId="w" sessionId="s" />)
  const trigger = await screen.findByRole("button", { name: "終止程序" })
  trigger.focus(); fireEvent.click(trigger)
  const dialog = screen.getByRole("dialog", { name: "確認程序操作" })
  const back = within(dialog).getByRole("button", { name: "返回" })
  expect(document.activeElement).toBe(back)
  fireEvent.compositionStart(back)
  fireEvent.keyDown(back, { key: "Escape" })
  expect(screen.getByRole("dialog")).toBeTruthy()
  fireEvent.compositionEnd(back); fireEvent.keyUp(back, { key: "Escape" }); fireEvent.keyDown(back, { key: "Escape" })
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it.each(["signal", "job/cancel"] as const)("rechecks %s control when backend polling changes eligibility and keeps the confirmation readable", async action => {
  vi.useFakeTimers()
  let current = base
  const commands: unknown[] = []
  const request = async (input: AgentProcessesRequest) => { if (input.kind === "desktop/session/processes/control") { commands.push(input.command); return {} } return current }
  await act(async () => { render(<AgentProcessesPane bridge={{ request }} workspaceId="w" sessionId="s" />) })
  fireEvent.click(screen.getByRole("button", { name: action === "signal" ? "終止程序" : "取消工作" }))
  const dialog = screen.getByRole("dialog", { name: "確認程序操作" })
  current = { ...base, terminals: [{ ...terminal, canControl: false }], jobs: [{ ...job, canCancel: false }] }
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
  expect(within(dialog).getByRole("button", { name: "確認執行" }).hasAttribute("disabled")).toBe(true)
  expect(within(dialog).getByRole("status").textContent).toContain("執行狀態或控制權已變更")
  fireEvent.submit(dialog.querySelector("form")!)
  expect(commands).toEqual([])
  current = base
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
  expect(within(dialog).getByRole("button", { name: "確認執行" }).hasAttribute("disabled")).toBe(false)
  await act(async () => { fireEvent.submit(dialog.querySelector("form")!) })
  expect(commands).toEqual([action === "signal" ? { action: "signal", id: "t1", signal: "TERM" } : { action: "job/cancel", id: "j1" }])
})

it("keeps a pending destructive confirmation busy and preserves a backend refusal for retry", async () => {
  let refuse: (reason: unknown) => void = () => {}
  const commands: unknown[] = []
  const request = (input: AgentProcessesRequest): Promise<unknown> => {
    if (input.kind === "desktop/session/processes/control") { commands.push(input.command); return new Promise((_resolve, reject) => { refuse = reject }) }
    return Promise.resolve({ ...base, jobs: [] })
  }
  render(<AgentProcessesPane bridge={{ request }} workspaceId="w" sessionId="s" />)
  fireEvent.click(await screen.findByRole("button", { name: "強制終止" }))
  const dialog = screen.getByRole("dialog", { name: "確認程序操作" })
  fireEvent.submit(dialog.querySelector("form")!)
  expect(dialog.getAttribute("aria-busy")).toBe("true")
  expect(within(dialog).getByRole("button", { name: "返回" }).hasAttribute("disabled")).toBe(true)
  fireEvent.keyDown(dialog, { key: "Escape" }); fireEvent.submit(dialog.querySelector("form")!)
  expect(commands).toHaveLength(1)
  refuse(new Error("actual stop refusal"))
  await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toBe("actual stop refusal"))
  expect(within(dialog).getByRole("button", { name: "確認執行" }).hasAttribute("disabled")).toBe(false)
  expect(screen.queryByText("已停止")).toBeNull()
})
