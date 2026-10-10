// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { AgentProcessesRequest, AgentProcessesView } from "@i-harness/desktop-gateway/src/agent-processes.ts"
import { AgentProcessesPane } from "../src/renderer/session/AgentProcessesPane.tsx"

afterEach(() => { cleanup(); vi.useRealTimers() })
const terminal = { id: "t1", ownerSessionId: "s", command: "node owned-fixture.mjs", pid: 42, status: "running" as const, cols: 80, rows: 24, live: true, canControl: true, outputAvailable: true }
const job = { jobId: "j1", ownerSessionId: "s", kind: "shell", label: "Owned job", status: "running" as const, outputAvailable: true, live: true, canCancel: true }
const base: AgentProcessesView = { sessionId: "s", live: true, terminals: [terminal], jobs: [job] }

it("replaces full job snapshots when refreshing instead of duplicating the captured output", async () => {
  let reads = 0
  const request = async (input: AgentProcessesRequest) => input.kind === "desktop/session/processes/job-output" ? { text: ++reads === 1 ? "first snapshot" : "first snapshot\nnew evidence", truncated: false, ownerSessionId: "s", live: true } : { ...base, terminals: [] }
  const view = render(<AgentProcessesPane bridge={{ request }} workspaceId="w" sessionId="s" />)
  fireEvent.click(await screen.findByRole("button", { name: "查看輸出" }))
  await waitFor(() => expect(view.container.querySelector("pre")?.textContent).toBe("first snapshot"))
  fireEvent.click(screen.getByRole("button", { name: /讀取後續輸出|重新讀取輸出/ }))
  await waitFor(() => expect(view.container.querySelector("pre")?.textContent).toBe("first snapshot\nnew evidence"))
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
