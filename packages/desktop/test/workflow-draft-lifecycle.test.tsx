// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { DesktopBridge, DesktopEvent, DesktopRequest } from "../src/shared/bridge.ts"
import type { DesktopWorkflowView } from "@i-harness/desktop-gateway/src/workflow.ts"
import { WorkflowPane } from "../src/renderer/session/WorkflowPane.tsx"
import { SchedulePane } from "../src/renderer/session/SchedulePane.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"

afterEach(() => { cleanup(); vi.useRealTimers(); useUiStore.setState({ locale: "zh-TW" }) })

const goal = { id: "goal-a", revision: 4, phase: "active" as const, objective: "Saved objective" }
const member = { id: "member-a", name: "Reader", description: "Read files", provider: "spawn", context: "fresh" as const, phase: "active" as const }
const baseView = (patch: Partial<DesktopWorkflowView> = {}): DesktopWorkflowView => ({ goal, plan: { active: false, proposal: "Saved plan" }, team: { enabled: true, members: [member], tasks: [] }, jobs: [], reviews: [], ...patch })

function gateway(initial = baseView(), mutate?: (input: DesktopRequest) => Promise<unknown>) {
  let current = initial
  const listeners = new Set<(event: DesktopEvent) => void>()
  const request = vi.fn(async (input: DesktopRequest) => {
    if (input.kind === "desktop/session/workflow/read") return current
    if (input.kind === "desktop/schedule/list") return { schedules: [] }
    const value = mutate ? await mutate(input) : current
    if (input.kind === "desktop/session/workflow/mutate" && value && typeof value === "object" && "goal" in value) current = value as DesktopWorkflowView
    return value
  })
  const bridge: DesktopBridge = { request, onEvent: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  return { bridge, request, set: (next: DesktopWorkflowView) => { current = next }, emit: (event: DesktopEvent) => listeners.forEach(listener => listener(event)) }
}

async function loaded() { await screen.findByRole("textbox", { name: "目標內容" }) }
const textboxValue = (label: string) => (screen.getByRole("textbox", { name: label }) as HTMLTextAreaElement).value
async function changedWorkflow(api: ReturnType<typeof gateway>) {
  vi.useFakeTimers()
  act(() => api.emit({ kind: "sdk/notification", workspaceId: "w", method: "desktop/workflow/changed", params: { sessionId: "s" } }))
  await act(async () => { await vi.advanceTimersByTimeAsync(250) })
  vi.useRealTimers()
}

it("retains objective and plan drafts through another workflow tab and a complete pane remount", async () => {
  const api = gateway()
  const pane = render(<WorkflowPane bridge={api.bridge} workspaceId="w" sessionId="s" />)
  await loaded()
  fireEvent.change(screen.getByRole("textbox", { name: "目標內容" }), { target: { value: "Human objective draft" } })
  fireEvent.change(screen.getByRole("textbox", { name: "計畫內容" }), { target: { value: "Human plan draft" } })
  fireEvent.click(screen.getByRole("tab", { name: "團隊" }))
  fireEvent.click(screen.getByRole("tab", { name: "目標與計畫" }))
  expect(textboxValue("目標內容")).toBe("Human objective draft")
  expect(textboxValue("計畫內容")).toBe("Human plan draft")
  pane.unmount()
  render(<WorkflowPane bridge={api.bridge} workspaceId="w" sessionId="s" />)
  await loaded()
  expect(textboxValue("目標內容")).toBe("Human objective draft")
  expect(textboxValue("計畫內容")).toBe("Human plan draft")
})

it("keeps team creation, task and roster-message drafts scoped to the actual conversation", async () => {
  const api = gateway()
  const pane = render(<WorkflowPane bridge={api.bridge} workspaceId="w" sessionId="s" section="team" />)
  await screen.findByRole("textbox", { name: "訊息 Reader" })
  fireEvent.click(screen.getByText("建立團隊成員"))
  fireEvent.change(screen.getByRole("textbox", { name: "成員名稱" }), { target: { value: "Writer draft" } })
  fireEvent.change(screen.getByRole("textbox", { name: "任務標題" }), { target: { value: "Task draft" } })
  fireEvent.change(screen.getByRole("textbox", { name: "訊息 Reader" }), { target: { value: "Reader message draft" } })
  pane.rerender(<WorkflowPane bridge={api.bridge} workspaceId="w" sessionId="other" section="team" />)
  await screen.findByRole("textbox", { name: "訊息 Reader" })
  expect(textboxValue("訊息 Reader")).toBe("")
  expect(textboxValue("任務標題")).toBe("")
  pane.rerender(<WorkflowPane bridge={api.bridge} workspaceId="w" sessionId="s" section="team" />)
  await screen.findByRole("textbox", { name: "訊息 Reader" })
  expect(textboxValue("訊息 Reader")).toBe("Reader message draft")
  expect(textboxValue("任務標題")).toBe("Task draft")
  expect(textboxValue("成員名稱")).toBe("Writer draft")
})

it("blocks invalid teammate identifiers and retains the rejected draft until a valid name is submitted", async () => {
  const api = gateway(baseView())
  const pane = render(<WorkflowPane bridge={api.bridge} workspaceId="w" sessionId="s" section="team" />)
  await screen.findByRole("textbox", { name: "訊息 Reader" })
  fireEvent.click(screen.getByText("建立團隊成員"))
  fireEvent.change(screen.getByRole("textbox", { name: "成員職責" }), { target: { value: "Read owned fixtures" } })
  fireEvent.change(screen.getByRole("textbox", { name: "初始任務" }), { target: { value: "Inspect the fixture" } })
  for (const name of ["OwnedReader", "lead", "reader--a", " owned-reader", "owned-reader ", "a".repeat(65)]) {
    const field = screen.getByRole("textbox", { name: "成員名稱" })
    fireEvent.change(field, { target: { value: name } })
    expect(field.getAttribute("aria-invalid")).toBe("true")
    expect(screen.getByRole("button", { name: "建立成員" }).hasAttribute("disabled")).toBe(true)
    fireEvent.submit(field.closest("form")!)
  }
  await act(async () => {})
  expect(api.request.mock.calls.filter(([input]) => input.kind === "desktop/session/workflow/mutate")).toHaveLength(0)
  const field = screen.getByRole("textbox", { name: "成員名稱" })
  expect(field.getAttribute("aria-invalid")).toBe("true")
  const associated = field.getAttribute("aria-describedby")!.split(" ").map(id => document.getElementById(id)?.textContent).join(" ")
  expect(associated).toContain("64")
  expect(associated).toContain("lead")
  pane.unmount()
  render(<WorkflowPane bridge={api.bridge} workspaceId="w" sessionId="s" section="team" />)
  await screen.findByRole("textbox", { name: "成員名稱" })
  expect(textboxValue("成員名稱")).toBe("a".repeat(65))
  expect(textboxValue("成員職責")).toBe("Read owned fixtures")
  fireEvent.change(screen.getByRole("textbox", { name: "成員名稱" }), { target: { value: "owned-reader" } })
  expect(screen.getByRole("textbox", { name: "成員名稱" }).getAttribute("aria-invalid")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "建立成員" }))
  await waitFor(() => expect(api.request).toHaveBeenCalledWith({ kind: "desktop/session/workflow/mutate", workspaceId: "w", sessionId: "s", command: { action: "team", tool: "spawn_teammate", args: { name: "owned-reader", description: "Read owned fixtures", prompt: "Inspect the fixture", context: "fresh" } } }))
})

it("preserves a dirty goal's original revision until the user compares and adopts the new saved revision", async () => {
  const api = gateway(baseView(), async () => baseView({ goal: { ...goal, revision: 6, objective: "Human draft" } }))
  render(<WorkflowPane bridge={api.bridge} workspaceId="w" sessionId="s" />)
  await loaded()
  fireEvent.change(screen.getByRole("textbox", { name: "目標內容" }), { target: { value: "Human draft" } })
  api.set(baseView({ goal: { ...goal, revision: 5, objective: "Agent changed objective" } }))
  await changedWorkflow(api)
  expect(textboxValue("目標內容")).toBe("Human draft")
  expect(screen.getByRole("button", { name: "儲存目標" }).hasAttribute("disabled")).toBe(true)
  expect(screen.getByRole("alert").textContent).toContain("草稿")
  fireEvent.submit(screen.getByRole("textbox", { name: "目標內容" }).closest("form")!)
  expect(api.request.mock.calls.filter(([input]) => input.kind === "desktop/session/workflow/mutate")).toHaveLength(0)
  fireEvent.click(screen.getByRole("button", { name: "保留草稿並採用此目標修訂" }))
  expect(textboxValue("目標內容")).toBe("Human draft")
  fireEvent.click(screen.getByRole("button", { name: "儲存目標" }))
  await screen.findByText("Human draft", { selector: ".workflow-objective" })
  expect(api.request).toHaveBeenCalledWith({ kind: "desktop/session/workflow/mutate", workspaceId: "w", sessionId: "s", command: { action: "goal", operation: "edit", request: { ref: { id: "goal-a", revision: 5 }, objective: "Human draft" } } })
})

it("does not overwrite or publish a dirty plan when an incoming saved plan changes", async () => {
  const api = gateway()
  render(<WorkflowPane bridge={api.bridge} workspaceId="w" sessionId="s" />)
  await loaded()
  fireEvent.change(screen.getByRole("textbox", { name: "計畫內容" }), { target: { value: "Human plan draft" } })
  api.set(baseView({ plan: { active: true, proposal: "Agent plan" } }))
  await changedWorkflow(api)
  expect(textboxValue("計畫內容")).toBe("Human plan draft")
  expect((screen.getByRole("checkbox", { name: "計畫模式" }) as HTMLInputElement).checked).toBe(false)
  expect(screen.getByRole("button", { name: "套用計畫" }).hasAttribute("disabled")).toBe(true)
  fireEvent.submit(screen.getByRole("textbox", { name: "計畫內容" }).closest("form")!)
  expect(api.request.mock.calls.filter(([input]) => input.kind === "desktop/session/workflow/mutate")).toHaveLength(0)
  fireEvent.click(screen.getByRole("button", { name: "保留草稿並採用此計畫版本" }))
  fireEvent.click(screen.getByRole("button", { name: "套用計畫" }))
  await waitFor(() => expect(api.request).toHaveBeenCalledWith({ kind: "desktop/session/workflow/mutate", workspaceId: "w", sessionId: "s", command: { action: "plan", enabled: false, proposal: "Human plan draft" } }))
})

it("pauses hidden workflow refresh while allowing an already admitted mutation to finish", async () => {
  let release!: (value: DesktopWorkflowView) => void
  const pending = new Promise<DesktopWorkflowView>(resolve => { release = resolve })
  const api = gateway(baseView(), async () => pending)
  const onChanged = vi.fn()
  const pane = render(<WorkflowPane bridge={api.bridge} workspaceId="w" sessionId="s" onChanged={onChanged} />)
  await loaded()
  fireEvent.click(screen.getByRole("button", { name: "暫停目標" }))
  pane.rerender(<WorkflowPane bridge={api.bridge} workspaceId="w" sessionId="s" active={false} onChanged={onChanged} />)
  await act(async () => { release(baseView({ goal: { ...goal, revision: 5, phase: "paused" } })); await pending })
  expect(onChanged).toHaveBeenCalledTimes(1)
  api.request.mockClear()
  await changedWorkflow(api)
  expect(api.request).not.toHaveBeenCalled()
  pane.rerender(<WorkflowPane bridge={api.bridge} workspaceId="w" sessionId="s" active onChanged={onChanged} />)
  await screen.findByRole("button", { name: "繼續目標" })
  expect(api.request).toHaveBeenCalledWith({ kind: "desktop/session/workflow/read", workspaceId: "w", sessionId: "s" })
})

it("retains a reminder draft through unmount and isolates another workspace with the same session ID", async () => {
  const api = gateway()
  const write = vi.spyOn(Storage.prototype, "setItem")
  const pane = render(<SchedulePane bridge={api.bridge} workspaceId="w" sessionId="s" canCreate />)
  await screen.findByText("此會話尚無提醒")
  fireEvent.change(screen.getByRole("textbox", { name: "提醒內容" }), { target: { value: "Private reminder draft" } })
  fireEvent.change(screen.getByRole("combobox", { name: "提醒方式" }), { target: { value: "every" } })
  fireEvent.change(screen.getByRole("spinbutton", { name: "間隔分鐘" }), { target: { value: "11" } })
  pane.unmount()
  const other = render(<SchedulePane bridge={api.bridge} workspaceId="other" sessionId="s" canCreate />)
  await screen.findByText("此會話尚無提醒")
  expect(textboxValue("提醒內容")).toBe("")
  other.unmount()
  render(<SchedulePane bridge={api.bridge} workspaceId="w" sessionId="s" canCreate />)
  await screen.findByText("此會話尚無提醒")
  expect(textboxValue("提醒內容")).toBe("Private reminder draft")
  expect((screen.getByRole("combobox", { name: "提醒方式" }) as HTMLSelectElement).value).toBe("every")
  expect((screen.getByRole("spinbutton", { name: "間隔分鐘" }) as HTMLInputElement).value).toBe("11")
  expect(write.mock.calls.some(([, value]) => value.includes("Private reminder draft"))).toBe(false)
  write.mockRestore()
})

it("does not subscribe or read hidden reminders and refreshes when the pane is shown", async () => {
  const api = gateway()
  const pane = render(<SchedulePane bridge={api.bridge} workspaceId="w" sessionId="s" canCreate active={false} />)
  await act(async () => {})
  expect(api.request).not.toHaveBeenCalled()
  act(() => api.emit({ kind: "sdk/notification", workspaceId: "w", method: "session/event", params: { sessionId: "s", event: { type: "schedule/change" } } }))
  expect(api.request).not.toHaveBeenCalled()
  pane.rerender(<SchedulePane bridge={api.bridge} workspaceId="w" sessionId="s" canCreate active />)
  await screen.findByText("此會話尚無提醒")
  expect(api.request).toHaveBeenCalledTimes(1)
})

it("shows a failed reminder read without still claiming it is loading", async () => {
  const request = vi.fn(async () => { throw new Error("Reminder store unavailable") })
  render(<SchedulePane bridge={{ request, onEvent: () => () => {} }} workspaceId="w" sessionId="s" canCreate />)
  await screen.findByRole("alert")
  expect(screen.queryByText("正在讀取提醒…")).toBeNull()
  expect(screen.getByRole("button", { name: "重新讀取提醒" })).toBeTruthy()
})

it("does not admit reminder form submissions when a failed mutation still needs readback", async () => {
  let reads = 0
  const request = vi.fn(async (input: DesktopRequest) => {
    if (input.kind === "desktop/schedule/create") throw new Error("Unconfirmed save")
    if (++reads === 2) throw new Error("Readback unavailable")
    return { schedules: [] }
  })
  render(<SchedulePane bridge={{ request, onEvent: () => () => {} }} workspaceId="w" sessionId="s" canCreate />)
  await screen.findByText("此會話尚無提醒")
  const field = screen.getByRole("textbox", { name: "提醒內容" })
  fireEvent.change(field, { target: { value: "Retained draft" } })
  fireEvent.click(screen.getByRole("button", { name: "建立提醒" }))
  await screen.findByRole("alert")
  fireEvent.submit(field.closest("form")!)
  await act(async () => {})
  expect(request.mock.calls.filter(([input]) => input.kind === "desktop/schedule/create")).toHaveLength(1)
  expect(textboxValue("提醒內容")).toBe("Retained draft")
})

it("rejects fractional reminder minutes even when a form submit bypasses native input validation", async () => {
  const api = gateway()
  render(<SchedulePane bridge={api.bridge} workspaceId="w" sessionId="s" canCreate />)
  await screen.findByText("此會話尚無提醒")
  const field = screen.getByRole("textbox", { name: "提醒內容" })
  fireEvent.change(field, { target: { value: "Keep this draft" } })
  fireEvent.change(screen.getByRole("spinbutton", { name: "延遲分鐘" }), { target: { value: "1.5" } })
  await act(async () => { fireEvent.submit(field.closest("form")!) })
  expect(api.request.mock.calls.filter(([input]) => input.kind === "desktop/schedule/create")).toHaveLength(0)
  expect(screen.getByRole("alert")).toBeTruthy()
  expect(textboxValue("提醒內容")).toBe("Keep this draft")
})

it("bounds projected job output and exposes shared copy, wrap and expansion actions", async () => {
  const api = gateway(baseView({ jobs: [{ jobId: "job-a", label: "Worker", kind: "shell", status: "completed", outputAvailable: true, live: false, canCancel: false }] }), async () => ({ text: `${"a".repeat(5000)}ACTUAL TAIL`, truncated: true }))
  render(<WorkflowPane bridge={api.bridge} workspaceId="w" sessionId="s" section="jobs" />)
  fireEvent.click(await screen.findByRole("button", { name: "查看輸出" }))
  await screen.findByRole("button", { name: "複製 背景任務輸出" })
  expect(screen.queryByText(/ACTUAL TAIL/)).toBeNull()
  expect(screen.getByRole("button", { name: "自動換行 背景任務輸出" })).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "展開 背景任務輸出" }))
  expect(screen.getByText(/ACTUAL TAIL/)).toBeTruthy()
})

it("retains a recorded truncation notice when the returned job text is empty", async () => {
  const api = gateway(baseView({ jobs: [{ jobId: "job-a", label: "Worker", kind: "shell", status: "completed", outputAvailable: true, live: false, canCancel: false }] }), async () => ({ text: "", truncated: true }))
  render(<WorkflowPane bridge={api.bridge} workspaceId="w" sessionId="s" section="jobs" />)
  fireEvent.click(await screen.findByRole("button", { name: "查看輸出" }))
  expect(await screen.findByText("記錄的輸出已截斷")).toBeTruthy()
})

it("gives job cancellation a foreground dialog with composition-safe Escape and a pending close lock", async () => {
  let release!: (value: DesktopWorkflowView) => void
  const pending = new Promise<DesktopWorkflowView>(resolve => { release = resolve })
  const api = gateway(baseView({ jobs: [{ jobId: "job-a", label: "Worker", kind: "shell", status: "running", outputAvailable: false, live: true, canCancel: true }] }), async () => pending)
  render(<WorkflowPane bridge={api.bridge} workspaceId="w" sessionId="s" section="jobs" />)
  const cancel = await screen.findByRole("button", { name: "取消工作" })
  await waitFor(() => expect((cancel as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(cancel)
  const dialog = screen.getByRole("dialog", { name: "確認程序操作" })
  fireEvent.compositionStart(dialog)
  fireEvent.keyDown(dialog, { key: "Escape", isComposing: true })
  expect(screen.getByRole("dialog", { name: "確認程序操作" })).toBeTruthy()
  fireEvent.compositionEnd(dialog)
  fireEvent.keyUp(dialog, { key: "Escape" })
  fireEvent.click(within(dialog).getByRole("button", { name: "確認執行" }))
  expect(within(dialog).getByRole("button", { name: "返回" }).hasAttribute("disabled")).toBe(true)
  fireEvent.keyDown(dialog, { key: "Escape" })
  expect(screen.getByRole("dialog", { name: "確認程序操作" })).toBeTruthy()
  await act(async () => { release(baseView({ jobs: [] })); await pending })
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "確認程序操作" })).toBeNull())
})
