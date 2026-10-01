// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { HistoryRange } from "@i-harness/sdk"
import type { DesktopBridge, DesktopEvent, DesktopRequest } from "../src/shared/bridge.ts"
import type { DesktopSubagentCatalog, DesktopSubagentRow } from "@i-harness/desktop-gateway/src/session-subagents.ts"
// JSDOM has no measured viewport. Keep the real Timeline/projection and only
// replace the upstream virtual viewport adapter so its rows can be inspected.
vi.mock("@tanstack/react-virtual", () => ({ useVirtualizer: (options: { count: number }) => ({
  getTotalSize: () => options.count * 56,
  getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, start: index * 56 })),
  measureElement: () => {}, scrollToIndex: () => {},
}) }))
import { SubagentPane } from "../src/renderer/session/SubagentPane.tsx"

afterEach(cleanup)
const child: DesktopSubagentRow = {
  sessionId: "child-a", parentSessionId: "parent", path: "/root/reader", roleName: "reader", label: "Reader", status: "completed", live: true,
  canFollowup: true, canMessage: false, canInterrupt: false, canClose: false,
}
const second: DesktopSubagentRow = { ...child, sessionId: "child-b", parentSessionId: "child-a", path: "/root/reader/checker", label: "Checker", status: "running", modelLabel: "Provider / Checker model", canFollowup: false, canMessage: true, canInterrupt: true, canClose: true }
const history = (text: string): HistoryRange["events"] => [{ type: "user/message", text: "Inspect the project", seq: 0 }, { type: "assistant/message", text, seq: 1 }]

function fixture(handle?: (request: DesktopRequest) => unknown, initial: DesktopSubagentCatalog = { parentSessionId: "parent", agents: [child, second] }) {
  let catalog = initial
  const listeners = new Set<(event: DesktopEvent) => void>()
  const bridge: DesktopBridge = {
    request: vi.fn(async (request) => {
      const override = handle?.(request)
      if (override !== undefined) return override
      if (request.kind === "desktop/session/subagents/list") return catalog
      if (request.kind === "desktop/session/subagents/history") {
        const events = history(request.childSessionId === "child-a" ? "Reader transcript" : "Checker transcript")
        const cursor = Math.min(request.afterSeq ?? 0, events.length)
        return { events: events.slice(cursor, cursor + (request.limit ?? 200)), nextSeq: Math.min(cursor + (request.limit ?? 200), events.length) }
      }
      if (request.kind === "desktop/session/subagents/control") return { parentSessionId: "parent", childSessionId: request.childSessionId, action: request.action, result: { accepted: true } }
      throw new Error(`Unexpected request ${request.kind}`)
    }),
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return { bridge, setCatalog(value: DesktopSubagentCatalog) { catalog = value }, emit(event: DesktopEvent) { for (const listener of listeners) listener(event) } }
}
async function open(name = "Reader") { fireEvent.click(await screen.findByRole("button", { name: `查看子代理 ${name}` })) }

describe("dedicated subagent pane", () => {
  it("shows the catalog and source errors without starting child work or loading every transcript", async () => {
    const { bridge } = fixture(undefined, { parentSessionId: "parent", agents: [child, second], errors: [{ sessionId: "broken", message: "Saved child record unreadable" }] })
    render(<SubagentPane bridge={bridge} workspaceId="w" sessionId="parent" parentTitle="Main task" />)
    await screen.findByRole("button", { name: "查看子代理 Reader" })
    expect(screen.getByRole("button", { name: "查看子代理 Checker" })).toBeTruthy()
    expect(screen.getByRole("alert").textContent).toContain("Saved child record unreadable")
    expect((bridge.request as ReturnType<typeof vi.fn>).mock.calls.map(([request]) => request.kind)).toEqual(["desktop/session/subagents/list"])
  })

  it("opens the scoped child transcript with lineage and no normal composer or child model setup error", async () => {
    const { bridge } = fixture()
    render(<SubagentPane bridge={bridge} workspaceId="w" sessionId="parent" parentTitle="Main task" />)
    await open("Checker")
    await screen.findByText("Checker transcript")
    expect(screen.getByRole("navigation", { name: "子代理執行記錄" }).textContent).toContain("Main task")
    expect(screen.getByRole("navigation", { name: "子代理執行記錄" }).textContent).toContain("Reader")
    expect(screen.getByText("Provider / Checker model")).toBeTruthy()
    expect(screen.getByText("子會話為唯讀；可用操作由父會話管理。")).toBeTruthy()
    expect(screen.queryByRole("textbox", { name: "提示" })).toBeNull()
    expect(screen.queryByText("選擇模型")).toBeNull()
    expect(bridge.request).toHaveBeenCalledWith({ kind: "desktop/session/subagents/history", workspaceId: "w", sessionId: "parent", childSessionId: "child-b", afterSeq: Number.MAX_SAFE_INTEGER, limit: 1 })
    fireEvent.click(screen.getByRole("button", { name: "返回子代理列表" }))
    await screen.findByRole("button", { name: "查看子代理 Reader" })
    expect(screen.queryByText("Checker transcript")).toBeNull()
  })

  it("renders only authoritative controls and submits follow-up through the parent without clearing failed input", async () => {
    const { bridge } = fixture((request) => request.kind === "desktop/session/subagents/control" ? Promise.reject(new Error("The child is busy")) : undefined)
    render(<SubagentPane bridge={bridge} workspaceId="w" sessionId="parent" />)
    await open()
    await screen.findByText("Reader transcript")
    expect(screen.queryByRole("button", { name: "傳送訊息" })).toBeNull()
    expect(screen.queryByRole("button", { name: "中斷子代理" })).toBeNull()
    expect(screen.getByText("繼承主會話模型")).toBeTruthy()
    fireEvent.change(screen.getByRole("textbox", { name: "子代理輸入" }), { target: { value: "Inspect another file" } })
    fireEvent.click(screen.getByRole("button", { name: "派發後續任務" }))
    await screen.findByText("The child is busy")
    expect(bridge.request).toHaveBeenCalledWith({ kind: "desktop/session/subagents/control", workspaceId: "w", sessionId: "parent", childSessionId: "child-a", action: "followup", text: "Inspect another file" })
    expect((screen.getByRole("textbox", { name: "子代理輸入" }) as HTMLTextAreaElement).value).toBe("Inspect another file")
  })

  it("blocks duplicate controls and requires successful readback after a failed mutation", async () => {
    let fail!: (error: Error) => void
    let failRead = false
    const { bridge } = fixture((request) => {
      if (request.kind === "desktop/session/subagents/control") return new Promise((_done, reject) => { fail = reject })
      if (request.kind === "desktop/session/subagents/list" && failRead) return Promise.reject(new Error("Catalog offline"))
    })
    render(<SubagentPane bridge={bridge} workspaceId="w" sessionId="parent" />)
    await open()
    await screen.findByText("Reader transcript")
    fireEvent.change(screen.getByRole("textbox", { name: "子代理輸入" }), { target: { value: "Retain this task" } })
    const send = screen.getByRole("button", { name: "派發後續任務" }) as HTMLButtonElement
    fireEvent.click(send)
    fireEvent.click(send)
    expect((bridge.request as ReturnType<typeof vi.fn>).mock.calls.filter(([request]) => request.kind === "desktop/session/subagents/control")).toHaveLength(1)
    failRead = true
    await act(async () => { fail(new Error("Write outcome unavailable")) })
    await screen.findByText(/重新讀取失敗/)
    expect(send.disabled).toBe(true)
    expect((screen.getByRole("textbox", { name: "子代理輸入" }) as HTMLTextAreaElement).value).toBe("Retain this task")
    failRead = false
    fireEvent.click(screen.getByRole("button", { name: "重新整理" }))
    await waitFor(() => expect(send.disabled).toBe(false))
  })

  it("keeps cold unavailable records readable and refuses all unavailable controls", async () => {
    const saved = { ...child, live: false, status: "unavailable" as const, controlReason: "The prior runtime is unavailable", canFollowup: false }
    const { bridge } = fixture(undefined, { parentSessionId: "parent", agents: [saved] })
    render(<SubagentPane bridge={bridge} workspaceId="w" sessionId="parent" />)
    await open()
    await screen.findByText("Reader transcript")
    expect(screen.getByText("已保存的子代理記錄")).toBeTruthy()
    expect(screen.getByText("The prior runtime is unavailable")).toBeTruthy()
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.queryByRole("button", { name: "派發後續任務" })).toBeNull()
  })

  it("drops an old child history response after selecting another child or parent", async () => {
    let finish!: (value: HistoryRange) => void
    const { bridge } = fixture((request) => request.kind === "desktop/session/subagents/history" && request.childSessionId === "child-a"
      ? new Promise<HistoryRange>((resolve) => { finish = resolve }) : undefined)
    const view = render(<SubagentPane bridge={bridge} workspaceId="w" sessionId="parent" />)
    await open()
    await waitFor(() => expect(finish).toBeTypeOf("function"))
    fireEvent.click(screen.getByRole("button", { name: "返回子代理列表" }))
    await open("Checker")
    await screen.findByText("Checker transcript")
    await act(async () => { finish({ events: history("Late Reader transcript"), nextSeq: 2 }) })
    expect(screen.queryByText("Late Reader transcript")).toBeNull()
    view.rerender(<SubagentPane bridge={bridge} workspaceId="other-workspace" sessionId="other-parent" />)
    await waitFor(() => expect(screen.queryByText("Checker transcript")).toBeNull())
  })

  it("submits message, interrupt and close only through the selected child's control flags", async () => {
    const { bridge } = fixture()
    render(<SubagentPane bridge={bridge} workspaceId="w" sessionId="parent" />)
    await open("Checker")
    await screen.findByText("Checker transcript")
    expect(screen.queryByRole("button", { name: "派發後續任務" })).toBeNull()
    fireEvent.change(screen.getByRole("textbox", { name: "子代理輸入" }), { target: { value: "A quiet update" } })
    fireEvent.click(screen.getByRole("button", { name: "傳送訊息" }))
    await waitFor(() => expect((screen.getByRole("textbox", { name: "子代理輸入" }) as HTMLTextAreaElement).value).toBe(""))
    fireEvent.click(screen.getByRole("button", { name: "中斷子代理" }))
    await waitFor(() => expect((screen.getByRole("button", { name: "關閉子代理" }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole("button", { name: "關閉子代理" }))
    await waitFor(() => expect((bridge.request as ReturnType<typeof vi.fn>).mock.calls.filter(([request]) => request.kind === "desktop/session/subagents/control").map(([request]) => request.action)).toEqual(["message", "interrupt", "close"]))
  })

  it("does not turn partial unreadable source records into a successful empty catalog", async () => {
    const { bridge } = fixture(undefined, { parentSessionId: "parent", agents: [], errors: [{ message: "Child source unavailable" }] })
    render(<SubagentPane bridge={bridge} workspaceId="w" sessionId="parent" />)
    await screen.findByText("Child source unavailable")
    expect(screen.queryByText("尚無子代理")).toBeNull()
    expect(screen.getByText("部分子代理資料無法讀取，請重新整理。")).toBeTruthy()
  })

  it("keeps an unreadable child error inside its detail and still permits returning to the catalog", async () => {
    const { bridge } = fixture((request) => request.kind === "desktop/session/subagents/history" && request.childSessionId === "child-a" ? Promise.reject(new Error("Unreadable child log")) : undefined)
    render(<SubagentPane bridge={bridge} workspaceId="w" sessionId="parent" />)
    await open()
    await screen.findByText(/讀取子代理記錄失敗.*Unreadable child log/)
    expect(screen.queryByText("選擇模型")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "返回子代理列表" }))
    await open("Checker")
    await screen.findByText("Checker transcript")
    expect(screen.queryByText(/Unreadable child log/)).toBeNull()
  })

  it("does not clear a draft when the control acknowledgement belongs to another child", async () => {
    const { bridge } = fixture((request) => request.kind === "desktop/session/subagents/control" ? { parentSessionId: "parent", childSessionId: "different-child", action: request.action, result: {} } : undefined)
    render(<SubagentPane bridge={bridge} workspaceId="w" sessionId="parent" />)
    await open()
    await screen.findByText("Reader transcript")
    fireEvent.change(screen.getByRole("textbox", { name: "子代理輸入" }), { target: { value: "Preserve this draft" } })
    fireEvent.click(screen.getByRole("button", { name: "派發後續任務" }))
    await screen.findByText(/Invalid subagent control/)
    expect((screen.getByRole("textbox", { name: "子代理輸入" }) as HTMLTextAreaElement).value).toBe("Preserve this draft")
  })
})
