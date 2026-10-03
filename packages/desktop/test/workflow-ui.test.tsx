// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { DesktopBridge, DesktopEvent, DesktopRequest } from "../src/shared/bridge.ts"
import type { DesktopWorkflowView } from "@i-harness/desktop-gateway/src/workflow.ts"
import { WorkflowPane } from "../src/renderer/session/WorkflowPane.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"

afterEach(() => { cleanup(); useUiStore.setState({ locale: "zh-TW" }); vi.useRealTimers() })

function view(overrides: Partial<DesktopWorkflowView> = {}): DesktopWorkflowView {
  return { goal: null, plan: { active: false }, jobs: [], team: { enabled: true, members: [], tasks: [] }, reviews: [], ...overrides }
}
const goal = { id: "g1", revision: 4, phase: "active" as const, objective: "Inspect the repository" }
function bridgeWith(value: DesktopWorkflowView, mutate?: (request: DesktopRequest) => Promise<unknown>) {
  const listeners = new Set<(event: DesktopEvent) => void>()
  let authoritative = value
  const request = vi.fn(async (input: DesktopRequest) => {
    if (input.kind === "desktop/session/workflow/read") return authoritative
    const next = mutate ? await mutate(input) : authoritative
    if (input.kind === "desktop/session/workflow/mutate" && next && typeof next === "object" && "goal" in next) authoritative = next as DesktopWorkflowView
    return next
  })
  const bridge: DesktopBridge = { request, onEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  return { bridge, request, emit: (event: DesktopEvent) => listeners.forEach((listener) => listener(event)) }
}
async function loaded() {
  // The form exists while its authoritative read is still pending. Flush that
  // response before issuing a user action against the enabled controls.
  await act(async () => {})
  await screen.findByRole("textbox", { name: "目標內容" })
}

it("creates and starts a goal only after the user submits its objective", async () => {
  const current = view()
  const { bridge, request } = bridgeWith(current, async () => view({ goal: { ...goal, revision: 1, objective: "Explore" } }))
  render(<WorkflowPane bridge={bridge} workspaceId="w" sessionId="s" />)
  await loaded()
  expect(request).toHaveBeenCalledWith({ kind: "desktop/session/workflow/read", workspaceId: "w", sessionId: "s" })
  expect(request).toHaveBeenCalledTimes(1)
  fireEvent.change(screen.getByRole("textbox", { name: "目標內容" }), { target: { value: " Explore " } })
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "建立並開始" })) })
  await screen.findByText("Explore", { selector: ".workflow-objective" })
  expect(request).toHaveBeenCalledWith({ kind: "desktop/session/workflow/mutate", workspaceId: "w", sessionId: "s", command: { action: "goal", operation: "create", request: { objective: "Explore" }, start: true } })
})

it("uses the latest goal revision for editing, pausing, resuming, completing and clearing", async () => {
  let revision = 4
  const { bridge, request } = bridgeWith(view({ goal }), async (input) => {
    if (input.kind !== "desktop/session/workflow/mutate" || input.command.action !== "goal") throw new Error("unexpected mutation")
    revision++
    const command = input.command
    return view({ goal: command.operation === "clear" ? null : { ...goal, revision, objective: command.request.objective ?? "Inspect", phase: command.operation === "pause" ? "paused" : command.operation === "complete" ? "complete" : "active" } })
  })
  render(<WorkflowPane bridge={bridge} workspaceId="w" sessionId="s" />)
  await loaded()
  fireEvent.change(screen.getByRole("textbox", { name: "目標內容" }), { target: { value: "Inspect" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存目標" }))
  await waitFor(() => expect(screen.getByRole("button", { name: "暫停目標" }).hasAttribute("disabled")).toBe(false))
  fireEvent.click(screen.getByRole("button", { name: "暫停目標" }))
  await screen.findByRole("button", { name: "繼續目標" })
  fireEvent.click(screen.getByRole("button", { name: "繼續目標" }))
  await screen.findByRole("button", { name: "暫停目標" })
  fireEvent.click(screen.getByRole("button", { name: "完成目標" }))
  await screen.findByText("已完成")
  fireEvent.click(screen.getByRole("button", { name: "清除目標" }))
  await screen.findByRole("button", { name: "建立目標" })
  expect(request.mock.calls.filter(([input]) => input.kind === "desktop/session/workflow/mutate").map(([input]) => (input as Extract<DesktopRequest, { kind: "desktop/session/workflow/mutate" }>).command)).toEqual([
    { action: "goal", operation: "edit", request: { ref: { id: "g1", revision: 4 }, objective: "Inspect" } },
    { action: "goal", operation: "pause", request: { ref: { id: "g1", revision: 5 } } },
    { action: "goal", operation: "resume", request: { ref: { id: "g1", revision: 6 } } },
    { action: "goal", operation: "complete", request: { ref: { id: "g1", revision: 7 } } },
    { action: "goal", operation: "clear", request: { ref: { id: "g1", revision: 8 } } },
  ])
})

it("applies plan mode with the edited proposal", async () => {
  const { bridge, request } = bridgeWith(view(), async () => view({ plan: { active: true, proposal: "Inspect files first" } }))
  render(<WorkflowPane bridge={bridge} workspaceId="w" sessionId="s" />)
  await loaded()
  fireEvent.click(screen.getByRole("checkbox", { name: "計畫模式" }))
  fireEvent.change(screen.getByRole("textbox", { name: "計畫內容" }), { target: { value: " Inspect files first " } })
  fireEvent.click(screen.getByRole("button", { name: "套用計畫" }))
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "desktop/session/workflow/mutate", workspaceId: "w", sessionId: "s", command: { action: "plan", enabled: true, proposal: "Inspect files first" } }))
})

it("creates a teammate explicitly and targets roster names for quiet messages, followups and interrupts", async () => {
  const member = { id: "m1", name: "Reader", description: "Reads files", provider: "spawn", context: "fresh" as const, phase: "active" as const, sessionId: "child" }
  const populated = view({ team: { enabled: true, members: [member], tasks: [] } })
  const { bridge, request } = bridgeWith(populated)
  render(<WorkflowPane bridge={bridge} workspaceId="w" sessionId="s" />)
  await loaded()
  fireEvent.click(screen.getByRole("tab", { name: "團隊" }))
  expect(screen.getByText("Reader")).toBeTruthy()
  fireEvent.click(screen.getByText("建立團隊成員"))
  fireEvent.change(screen.getByRole("textbox", { name: "成員名稱" }), { target: { value: "Writer" } })
  fireEvent.change(screen.getByRole("textbox", { name: "成員職責" }), { target: { value: "Edits files" } })
  fireEvent.change(screen.getByRole("textbox", { name: "初始任務" }), { target: { value: "Update docs" } })
  fireEvent.click(screen.getByRole("button", { name: "建立成員" }))
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "desktop/session/workflow/mutate", workspaceId: "w", sessionId: "s", command: { action: "team", tool: "spawn_teammate", args: { name: "Writer", description: "Edits files", prompt: "Update docs", context: "fresh" } } }))
  const roster = within(screen.getByRole("article", { name: "成員 Reader" }))
  fireEvent.change(roster.getByRole("textbox", { name: "訊息 Reader" }), { target: { value: "Read a.md" } })
  fireEvent.click(roster.getByRole("button", { name: "傳送訊息" }))
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "desktop/session/workflow/mutate", workspaceId: "w", sessionId: "s", command: { action: "team", tool: "send_message", args: { target: "Reader", message: "Read a.md" } } }))
  fireEvent.change(roster.getByRole("textbox", { name: "訊息 Reader" }), { target: { value: "Now b.md" } })
  fireEvent.click(roster.getByRole("button", { name: "派發後續任務" }))
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "desktop/session/workflow/mutate", workspaceId: "w", sessionId: "s", command: { action: "team", tool: "followup_task", args: { target: "Reader", message: "Now b.md" } } }))
  fireEvent.click(roster.getByRole("button", { name: "中斷成員" }))
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "desktop/session/workflow/mutate", workspaceId: "w", sessionId: "s", command: { action: "team", tool: "interrupt_agent", args: { target: "Reader" } } }))
})

it("creates board tasks and supplies the latest revision when completing or reopening one", async () => {
  const task = { id: "t1", revision: 2, subject: "Read docs", description: "Inspect README", status: "pending" as const, blockedBy: [], writeScopes: [] }
  let current = view({ team: { enabled: true, members: [], tasks: [task] } })
  const { bridge, request } = bridgeWith(current, async (input) => {
    if (input.kind === "desktop/session/workflow/mutate" && input.command.action === "team" && input.command.tool === "team_task_update") current = view({ team: { ...current.team, tasks: [{ ...task, revision: 3, status: "completed" }] } })
    return current
  })
  render(<WorkflowPane bridge={bridge} workspaceId="w" sessionId="s" />)
  await loaded()
  fireEvent.click(screen.getByRole("tab", { name: "團隊" }))
  fireEvent.change(screen.getByRole("textbox", { name: "任務標題" }), { target: { value: "Build" } })
  fireEvent.change(screen.getByRole("textbox", { name: "任務說明" }), { target: { value: "Run targeted checks" } })
  fireEvent.click(screen.getByRole("button", { name: "建立任務" }))
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "desktop/session/workflow/mutate", workspaceId: "w", sessionId: "s", command: { action: "team", tool: "team_task_create", args: { subject: "Build", description: "Run targeted checks" } } }))
  fireEvent.click(screen.getByRole("button", { name: "完成任務 Read docs" }))
  await screen.findByRole("button", { name: "重新開啟 Read docs" })
  fireEvent.click(screen.getByRole("button", { name: "重新開啟 Read docs" }))
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "desktop/session/workflow/mutate", workspaceId: "w", sessionId: "s", command: { action: "team", tool: "team_task_update", args: { task_id: "t1", expected_revision: 3, action: "reopen" } } }))
})

it("distinguishes saved running jobs from owned live jobs and reads bounded output", async () => {
  const { bridge, request } = bridgeWith(view({ jobs: [
    { jobId: "cold", label: "Saved worker", kind: "subagent", status: "running", outputAvailable: true, live: false, canCancel: false },
    { jobId: "live", label: "Live worker", kind: "subagent", status: "running", outputAvailable: false, live: true, canCancel: true },
  ] }), async (input) => input.kind === "desktop/session/job/output" ? { text: "saved output", truncated: true } : view())
  render(<WorkflowPane bridge={bridge} workspaceId="w" sessionId="s" />)
  await loaded()
  fireEvent.click(screen.getByRole("tab", { name: "背景任務" }))
  const saved = within(screen.getByRole("article", { name: "背景任務 Saved worker" }))
  expect(saved.getByText("已儲存狀態，未確認仍在執行")).toBeTruthy()
  expect(saved.queryByRole("button", { name: "取消工作" })).toBeNull()
  fireEvent.click(saved.getByRole("button", { name: "查看輸出" }))
  await screen.findByText("saved output")
  expect(screen.getByText("輸出已截斷")).toBeTruthy()
  expect(request).toHaveBeenCalledWith({ kind: "desktop/session/job/output", workspaceId: "w", sessionId: "s", id: "cold" })
  fireEvent.click(within(screen.getByRole("article", { name: "背景任務 Live worker" })).getByRole("button", { name: "取消工作" }))
  expect(request.mock.calls.some(([input]) => input.kind === "desktop/session/workflow/mutate")).toBe(false)
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "確認執行" }))
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "desktop/session/workflow/mutate", workspaceId: "w", sessionId: "s", command: { action: "job/cancel", id: "live" } }))
})

it("shows delegated review decisions with request, effective model and rationale", async () => {
  const { bridge } = bridgeWith(view({ reviews: [{ id: "r1", startedAt: 1, durationMs: 80, status: "completed", request: { name: "shell", reason: "write check", args: '{"command":"git status"}', argsTruncated: false }, model: { provider: "p", model: "cheap", protocol: "openai-responses" }, reusedContext: true, outcome: "approve", rationale: "Read-only inspection" }] }))
  render(<WorkflowPane bridge={bridge} workspaceId="w" sessionId="s" />)
  await loaded()
  fireEvent.click(screen.getByRole("tab", { name: "代審記錄" }))
  expect(screen.getByText("shell")).toBeTruthy()
  expect(screen.getByText("已核准")).toBeTruthy()
  fireEvent.click(screen.getByText("shell"))
  expect(screen.getByText("p / cheap")).toBeTruthy()
  expect(screen.getByText("Read-only inspection")).toBeTruthy()
  expect(screen.getByText('{"command":"git status"}')).toBeTruthy()
})

it("ignores stale reads after session selection changes and refreshes only matching notifications", async () => {
  let release!: (value: DesktopWorkflowView) => void
  const first = new Promise<DesktopWorkflowView>((resolve) => { release = resolve })
  const listeners = new Set<(event: DesktopEvent) => void>()
  const request = vi.fn(async (input: DesktopRequest) => "sessionId" in input && input.sessionId === "a" ? first : view({ goal: { ...goal, objective: "Current session" } }))
  const bridge: DesktopBridge = { request, onEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  const pane = render(<WorkflowPane bridge={bridge} workspaceId="w" sessionId="a" />)
  pane.rerender(<WorkflowPane bridge={bridge} workspaceId="w" sessionId="b" />)
  await screen.findByText("Current session", { selector: "p" })
  await act(async () => { release(view({ goal: { ...goal, objective: "Old session" } })); await first })
  expect(screen.queryByText("Old session")).toBeNull()
  request.mockClear()
  vi.useFakeTimers()
  const notify = (sessionId: string, type: string) => listeners.forEach((listener) => listener({ kind: "sdk/notification", workspaceId: "w", method: "session/event", params: { sessionId, event: { type } } }))
  act(() => { notify("a", "goal/change"); notify("b", "reasoning/chunk"); notify("b", "assistant/chunk") })
  await act(async () => { await vi.advanceTimersByTimeAsync(250) })
  expect(request).not.toHaveBeenCalled()
  act(() => { notify("b", "goal/change"); notify("b", "team/task"); notify("b", "tool/result") })
  await act(async () => { await vi.advanceTimersByTimeAsync(250) })
  expect(request).toHaveBeenCalledTimes(1)
  expect(request).toHaveBeenCalledWith({ kind: "desktop/session/workflow/read", workspaceId: "w", sessionId: "b" })
  pane.unmount()
  expect(listeners.size).toBe(0)
})

it("does not apply an old mutation response or notification to a newly selected session", async () => {
  let release!: (value: DesktopWorkflowView) => void
  const pending = new Promise<DesktopWorkflowView>((resolve) => { release = resolve })
  const onChanged = vi.fn()
  const request = vi.fn(async (input: DesktopRequest) => input.kind === "desktop/session/workflow/mutate" ? pending : view({ goal: { ...goal, objective: "sessionId" in input && input.sessionId === "a" ? "First" : "Second" } }))
  const bridge: DesktopBridge = { request, onEvent: () => () => {} }
  const pane = render(<WorkflowPane bridge={bridge} workspaceId="w" sessionId="a" onChanged={onChanged} />)
  await loaded()
  fireEvent.click(screen.getByRole("button", { name: "暫停目標" }))
  pane.rerender(<WorkflowPane bridge={bridge} workspaceId="w" sessionId="b" onChanged={onChanged} />)
  await screen.findByText("Second", { selector: "p" })
  await act(async () => { release(view({ goal: { ...goal, objective: "stale response", phase: "paused" } })); await pending })
  expect(screen.queryByText("stale response")).toBeNull()
  expect(screen.getByText("Second", { selector: "p" })).toBeTruthy()
  expect(onChanged).not.toHaveBeenCalled()
})

it("keeps plan changes disabled during an active turn and team commands disabled in plan mode", async () => {
  const { bridge } = bridgeWith(view({ plan: { active: true } }))
  render(<WorkflowPane bridge={bridge} workspaceId="w" sessionId="s" running />)
  await loaded()
  expect(screen.getByRole("button", { name: "套用計畫" }).hasAttribute("disabled")).toBe(true)
  fireEvent.click(screen.getByRole("tab", { name: "團隊" }))
  expect(screen.getByText("請先退出計畫模式再管理團隊。")).toBeTruthy()
  expect(screen.getByRole("button", { name: "建立任務" }).hasAttribute("disabled")).toBe(true)
})

it("starts an existing active goal with its current reference", async () => {
  const { bridge, request } = bridgeWith(view({ goal }))
  render(<WorkflowPane bridge={bridge} workspaceId="w" sessionId="s" />)
  await loaded()
  fireEvent.click(screen.getByRole("button", { name: "開始執行目標" }))
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "desktop/session/workflow/mutate", workspaceId: "w", sessionId: "s", command: { action: "goal", operation: "resume", request: { ref: { id: "g1", revision: 4 } }, start: true } }))
})

it("holds further writes after a failed mutation until a fresh read confirms state", async () => {
  let reads = 0
  const request = vi.fn(async (input: DesktopRequest) => {
    if (input.kind === "desktop/session/workflow/mutate") throw new Error("Save failed")
    if (++reads === 2) throw new Error("Read failed")
    return view({ goal })
  })
  render(<WorkflowPane bridge={{ request, onEvent: () => () => {} }} workspaceId="w" sessionId="s" />)
  await loaded()
  fireEvent.click(screen.getByRole("button", { name: "暫停目標" }))
  await screen.findByRole("alert")
  expect(screen.getByRole("button", { name: "完成目標" }).hasAttribute("disabled")).toBe(true)
  fireEvent.click(screen.getByRole("button", { name: "重試" }))
  await waitFor(() => expect(screen.getByRole("button", { name: "完成目標" }).hasAttribute("disabled")).toBe(false))
  expect(request.mock.calls.filter(([input]) => input.kind === "desktop/session/workflow/mutate")).toHaveLength(1)
})

it("ignores an output reply after its job panel closes", async () => {
  let release!: (value: { text: string; truncated: boolean }) => void
  const pending = new Promise<{ text: string; truncated: boolean }>((resolve) => { release = resolve })
  const { bridge } = bridgeWith(view({ jobs: [{ jobId: "j1", label: "Worker", kind: "subagent", status: "completed", outputAvailable: true, live: false, canCancel: false }] }), async () => pending)
  render(<WorkflowPane bridge={bridge} workspaceId="w" sessionId="s" />)
  await loaded()
  fireEvent.click(screen.getByRole("tab", { name: "背景任務" }))
  fireEvent.click(screen.getByRole("button", { name: "查看輸出" }))
  fireEvent.click(screen.getByRole("button", { name: "關閉輸出" }))
  await act(async () => { release({ text: "late output", truncated: false }); await pending })
  expect(screen.queryByText("late output")).toBeNull()
  expect(screen.queryByRole("button", { name: "關閉輸出" })).toBeNull()
})

it("uses roster names when assigning a task whose snapshot owner is a member ID", async () => {
  const { bridge, request } = bridgeWith(view({ team: { enabled: true, members: [
    { id: "member-uuid", name: "Reader", description: "Reads", provider: "spawn", context: "fresh", phase: "active" },
  ], tasks: [{ id: "t1", revision: 7, subject: "Read", description: "Read docs", status: "pending", blockedBy: [], writeScopes: [] }] } }))
  render(<WorkflowPane bridge={bridge} workspaceId="w" sessionId="s" />)
  await loaded()
  fireEvent.click(screen.getByRole("tab", { name: "團隊" }))
  fireEvent.change(screen.getByRole("combobox", { name: "負責成員 Read" }), { target: { value: "Reader" } })
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "desktop/session/workflow/mutate", workspaceId: "w", sessionId: "s", command: { action: "team", tool: "team_task_update", args: { task_id: "t1", expected_revision: 7, action: "reassign", owner: "Reader" } } }))
})

it("shows the actual goal runner and prevents duplicate starts even before parent status refreshes", async () => {
  const { bridge, request } = bridgeWith(view({ goal, goalRun: { running: true } }))
  render(<WorkflowPane bridge={bridge} workspaceId="w" sessionId="s" />)
  await loaded()
  expect(screen.getByText("執行中")).toBeTruthy()
  expect(screen.getByRole("button", { name: "開始執行目標" }).hasAttribute("disabled")).toBe(true)
  fireEvent.click(screen.getByRole("button", { name: "開始執行目標" }))
  expect(request.mock.calls.filter(([input]) => input.kind === "desktop/session/workflow/mutate")).toHaveLength(0)
})

it("shows the saved reason why autonomous goal execution paused", async () => {
  const { bridge } = bridgeWith(view({ goal: { ...goal, phase: "paused" }, goalRun: { running: false, error: "Provider refused the Goal request" } }))
  render(<WorkflowPane bridge={bridge} workspaceId="w" sessionId="s" />)
  await loaded()
  expect(screen.getByRole("alert").textContent).toContain("Provider refused the Goal request")
  expect(screen.getByRole("button", { name: "繼續目標" })).toBeTruthy()
})

it("labels the selected conversation's lead as informational without self-target actions", async () => {
  const { bridge } = bridgeWith(view())
  render(<WorkflowPane bridge={bridge} workspaceId="w" sessionId="s" running />)
  await loaded()
  fireEvent.click(screen.getByRole("tab", { name: "團隊" }))
  const lead = within(screen.getByRole("article", { name: "主代理 · 本會話" }))
  expect(lead.getByText("執行中")).toBeTruthy()
  expect(lead.queryByRole("button")).toBeNull()
  expect(lead.queryByRole("textbox")).toBeNull()
})
