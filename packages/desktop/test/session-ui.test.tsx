// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { boundedDraft, clearDraft, Composer } from "../src/renderer/session/Composer.tsx"
import { sendGate } from "../src/renderer/session/send-gate.ts"
import { TaskPane } from "../src/renderer/session/TaskPane.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"

afterEach(async () => {
  await act(async () => { cleanup() })
  // The owner keeps a memory draft across remounts even if localStorage is
  // unavailable. Reset the actual fixture scopes as well as browser storage.
  clearDraft("ws-1", "s1")
  clearDraft("ws-1", "s2")
  window.localStorage.clear()
  useUiStore.setState({ followupDelivery: "queue" } as never)
})

const base = { workspaceId: "ws-1", sessionId: "s1", running: false, onCancel: vi.fn() }

it("keeps Stop available with a follow-up draft and an admitted pending request", async () => {
  let admitted!: () => void, release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const onCancel = vi.fn()
  const onPrompt = vi.fn(async (_text: string, _context?: string, _images?: unknown, ack?: () => void) => { admitted = ack!; await pending })
  render(<Composer workspaceId="stop-regression" sessionId="pending" canSend running onCancel={onCancel} onPrompt={onPrompt} />)
  fireEvent.change(textarea(), { target: { value: "follow-up draft" } })
  expect(screen.queryByRole("button", { name: "停止" })).not.toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "停止" }))
  expect(onCancel).toHaveBeenCalledTimes(1)
  expect(textarea().value).toBe("follow-up draft")
  fireEvent.click(screen.getByRole("button", { name: "送出" }))
  await waitFor(() => expect(admitted).toBeDefined())
  act(() => admitted())
  expect(textarea().value).toBe("")
  expect((screen.getByRole("button", { name: "停止" }) as HTMLButtonElement).disabled).toBe(false)
  await act(async () => { release(); await pending })
})

function textarea(): HTMLTextAreaElement {
  return screen.getByLabelText("提示") as HTMLTextAreaElement
}

describe("Composer", () => {
  it.each([
    { defaultDelivery: "queue" as const, inverse: "steer" },
    { defaultDelivery: "steer" as const, inverse: "queue" },
  ])("uses Ctrl+Enter for $inverse when running with default $defaultDelivery", async ({ defaultDelivery, inverse }) => {
    useUiStore.setState({ followupDelivery: defaultDelivery } as never)
    const onPrompt = vi.fn(async () => {})
    const onSteer = vi.fn(async () => {})
    render(<Composer {...base} running canSend steeringEnabled onPrompt={onPrompt} onSteer={onSteer} />)
    fireEvent.change(textarea(), { target: { value: "opposite follow-up" } })
    fireEvent.keyDown(textarea(), { key: "Enter", ctrlKey: true, shiftKey: true })
    fireEvent.keyDown(textarea(), { key: "Enter", ctrlKey: true, isComposing: true })
    expect(onPrompt).not.toHaveBeenCalled()
    expect(onSteer).not.toHaveBeenCalled()
    fireEvent.keyDown(textarea(), { key: "Enter", ctrlKey: true })
    await waitFor(() => expect(inverse === "steer" ? onSteer : onPrompt).toHaveBeenCalledWith("opposite follow-up", undefined, undefined, expect.any(Function)))
    expect(inverse === "steer" ? onPrompt : onSteer).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole("button", { name: "停止" })).toBeTruthy())
    expect(screen.getAllByRole("button")).toHaveLength(1)
  })

  it("uses live defaults while a per-message override stays local and clears after admission", async () => {
    const onPrompt = vi.fn(async () => {})
    const onSteer = vi.fn(async () => {})
    render(<Composer {...base} running canSend steeringEnabled onPrompt={onPrompt} onSteer={onSteer} />)
    act(() => useUiStore.getState().setFollowupDelivery("steer"))
    const delivery = screen.getByRole("combobox", { name: "輸入處理方式" }) as HTMLSelectElement
    expect(delivery.value).toBe("steer")
    fireEvent.change(delivery, { target: { value: "queue" } })
    expect(useUiStore.getState().followupDelivery).toBe("steer")
    fireEvent.change(textarea(), { target: { value: "one queue override" } })
    fireEvent.click(screen.getByRole("button", { name: "送出" }))
    await waitFor(() => expect(onPrompt).toHaveBeenCalledWith("one queue override", undefined, undefined, expect.any(Function)))
    await waitFor(() => expect(delivery.value).toBe("steer"))
    fireEvent.change(textarea(), { target: { value: "next default steer" } })
    fireEvent.keyDown(textarea(), { key: "Enter" })
    await waitFor(() => expect(onSteer).toHaveBeenCalledWith("next default steer", undefined, undefined, expect.any(Function)))
  })

  it("starts idle work normally even when the saved follow-up default is steer", async () => {
    useUiStore.setState({ followupDelivery: "steer" } as never)
    const onPrompt = vi.fn(async () => {})
    const onSteer = vi.fn(async () => {})
    render(<Composer {...base} canSend steeringEnabled onPrompt={onPrompt} onSteer={onSteer} />)
    fireEvent.change(textarea(), { target: { value: "start idle work" } })
    fireEvent.keyDown(textarea(), { key: "Enter", ctrlKey: true })
    await waitFor(() => expect(onPrompt).toHaveBeenCalledWith("start idle work", undefined, undefined, expect.any(Function)))
    expect(onSteer).not.toHaveBeenCalled()
  })

  it("runs /compact through the compaction operation without submitting a prompt", async () => {
    const onPrompt = vi.fn(async () => {})
    const onCompact = vi.fn(async () => {})
    render(<Composer {...base} canSend canCompact onCompact={onCompact} onPrompt={onPrompt} />)
    fireEvent.change(textarea(), { target: { value: "/compact 保留關鍵決策" } })
    fireEvent.click(screen.getByRole("button", { name: "送出" }))
    await waitFor(() => expect(onCompact).toHaveBeenCalledWith("保留關鍵決策"))
    expect(onPrompt).not.toHaveBeenCalled()
    await waitFor(() => expect(textarea().value).toBe(""))
  })
  it("retains a pending send across A to B to A navigation", async () => {
    let finish!: () => void
    const onPrompt = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const view = render(<Composer {...base} canSend onPrompt={onPrompt} />)
    fireEvent.change(textarea(), { target: { value: "one send" } })
    fireEvent.click(screen.getByRole("button", { name: "送出" }))
    view.rerender(<Composer {...base} sessionId="s2" canSend onPrompt={onPrompt} />)
    view.rerender(<Composer {...base} canSend onPrompt={onPrompt} />)
    expect((screen.getByRole("button", { name: "送出" }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(textarea(), { key: "Enter" })
    expect(onPrompt).toHaveBeenCalledTimes(1)
    finish()
    await waitFor(() => expect(textarea().value).toBe(""))
  })
  it("sends with Enter but preserves Shift+Enter and IME composition", async () => {
    const onPrompt = vi.fn(async () => {})
    render(<Composer {...base} canSend onPrompt={onPrompt} />)
    fireEvent.change(textarea(), { target: { value: "中文提示" } })
    fireEvent.keyDown(textarea(), { key: "Enter", shiftKey: true })
    fireEvent.keyDown(textarea(), { key: "Enter", isComposing: true })
    expect(onPrompt).not.toHaveBeenCalled()
    fireEvent.keyDown(textarea(), { key: "Enter" })
    await waitFor(() => expect(onPrompt).toHaveBeenCalledWith("中文提示", undefined, undefined, expect.any(Function)))
  })

  it("does not erase edits made while the previous send is pending", async () => {
    let finish!: () => void
    render(<Composer {...base} canSend onPrompt={() => new Promise<void>((resolve) => { finish = resolve })} />)
    fireEvent.change(textarea(), { target: { value: "first prompt" } })
    fireEvent.click(screen.getByRole("button", { name: "送出" }))
    fireEvent.change(textarea(), { target: { value: "next draft" } })
    finish()
    await waitFor(() => expect((screen.getByRole("button", { name: "送出" }) as HTMLButtonElement).disabled).toBe(false))
    expect(textarea().value).toBe("next draft")
    expect(localStorage.getItem("ih:draft:ws-1:s1")).toBe("next draft")
  })

  it("does not clear another session when the old request finishes", async () => {
    let finish!: () => void
    const pending = () => new Promise<void>((resolve) => { finish = resolve })
    const view = render(<Composer {...base} canSend onPrompt={pending} />)
    fireEvent.change(textarea(), { target: { value: "first session" } })
    fireEvent.click(screen.getByRole("button", { name: "送出" }))
    view.rerender(<Composer {...base} sessionId="s2" canSend onPrompt={async () => {}} />)
    fireEvent.change(textarea(), { target: { value: "other session draft" } })
    finish()
    await waitFor(() => expect(localStorage.getItem("ih:draft:ws-1:s1")).toBeNull())
    expect(textarea().value).toBe("other session draft")
  })
  it("disables Send with a reason when the model is unconfigured", () => {
    render(<Composer {...base} canSend={false} sendReason="模型尚未設定" onPrompt={async () => {}} />)

    expect((screen.getByRole("button", { name: "送出" }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText("模型尚未設定")).toBeTruthy()
  })

  it("omits Stop in an idle new conversation even after entering a draft", () => {
    render(<Composer {...base} canSend onPrompt={async () => {}} />)
    expect(screen.queryByRole("button", { name: "停止" })).toBeNull()
    fireEvent.change(textarea(), { target: { value: "new task" } })
    expect(screen.queryByRole("button", { name: "停止" })).toBeNull()
  })

  it("uses one primary Stop while executing with no draft and returns to an idle disabled Send", () => {
    const onCancel = vi.fn()
    const onPrompt = vi.fn(async () => {})
    const view = render(<Composer {...base} running canSend onPrompt={onPrompt} onCancel={onCancel} />)
    expect(screen.getAllByRole("button")).toHaveLength(1)
    fireEvent.keyDown(textarea(), { key: "Enter" })
    expect(onCancel).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "停止" }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onPrompt).not.toHaveBeenCalled()
    expect(textarea().value).toBe("")
    view.rerender(<Composer {...base} canSend onPrompt={onPrompt} onCancel={onCancel} />)
    expect(screen.queryByRole("button", { name: "停止" })).toBeNull()
    expect((screen.getByRole("button", { name: "送出" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("keeps Stop beside the primary control while queuing a draft", async () => {
    const onPrompt = vi.fn(async () => {})
    const onSteer = vi.fn(async () => {})
    render(<Composer {...base} running canSend steeringEnabled onPrompt={onPrompt} onSteer={onSteer} />)
    const primary = screen.getByRole("button", { name: "停止" })
    fireEvent.change(textarea(), { target: { value: "next queued step" } })
    expect(screen.getByRole("button", { name: "停止" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "送出" })).toBe(primary)
    expect(screen.getAllByRole("button")).toHaveLength(2)
    expect((screen.getByRole("button", { name: "送出" }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "送出" }))
    await waitFor(() => expect(onPrompt).toHaveBeenCalledWith("next queued step", undefined, undefined, expect.any(Function)))
    expect(onSteer).not.toHaveBeenCalled()
    await waitFor(() => expect(textarea().value).toBe(""))
    expect(screen.getByRole("button", { name: "停止" })).toBe(primary)
  })

  it("disables Send while admission is pending, retaining Stop and the failed draft", async () => {
    let fail!: (error: Error) => void
    const onPrompt = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject }))
    render(<Composer {...base} running canSend onPrompt={onPrompt} />)
    fireEvent.change(textarea(), { target: { value: "keep failed queued draft" } })
    fireEvent.click(screen.getByRole("button", { name: "送出" }))
    expect(screen.getAllByRole("button")).toHaveLength(2)
    expect((screen.getByRole("button", { name: "送出" }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(textarea(), { key: "Enter" })
    expect(onPrompt).toHaveBeenCalledOnce()
    fail(new Error("admission failed"))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("admission failed"))
    expect(textarea().value).toBe("keep failed queued draft")
    expect((screen.getByRole("button", { name: "送出" }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByRole("button", { name: "停止" })).toBeTruthy()
  })

  it("keeps the draft when submission fails before admission and clears a successful send", async () => {
    const failing = vi.fn(async () => { throw new Error("boom") })
    const first = render(<Composer {...base} canSend onPrompt={failing} />)
    fireEvent.change(textarea(), { target: { value: "keep me" } })
    fireEvent.click(screen.getByRole("button", { name: "送出" }))

    await waitFor(() => { expect(failing).toHaveBeenCalledTimes(1) })
    await waitFor(() => { expect(screen.getByText("boom")).toBeTruthy() })
    expect(textarea().value).toBe("keep me")
    expect(window.localStorage.getItem("ih:draft:ws-1:s1")).toBe("keep me")
    first.unmount()

    const succeeded = vi.fn(async () => {})
    render(<Composer {...base} canSend onPrompt={succeeded} />)
    expect(textarea().value).toBe("keep me")
    fireEvent.click(screen.getByRole("button", { name: "送出" }))

    await waitFor(() => { expect(succeeded).toHaveBeenCalledWith("keep me", undefined, undefined, expect.any(Function)) })
    await waitFor(() => { expect(textarea().value).toBe("") })
    expect(window.localStorage.getItem("ih:draft:ws-1:s1")).toBeNull()
  })

  it("clears an admitted prompt even when the provider fails later", async () => {
    const onPrompt = vi.fn(async (_text: string, _context?: string, _images?: unknown, onAdmitted?: () => void) => {
      onAdmitted?.()
      throw new Error("provider 400")
    })
    render(<Composer {...base} canSend onPrompt={onPrompt} />)
    fireEvent.change(textarea(), { target: { value: "already in the conversation" } })
    fireEvent.click(screen.getByRole("button", { name: "送出" }))
    await waitFor(() => expect(screen.getByText("provider 400")).toBeTruthy())
    expect(textarea().value).toBe("")
    expect(window.localStorage.getItem("ih:draft:ws-1:s1")).toBeNull()
  })

  it("restores the same bounded draft after a remount", () => {
    const first = render(<Composer {...base} canSend onPrompt={async () => {}} />)
    fireEvent.change(textarea(), { target: { value: "persisted" } })
    first.unmount()

    render(<Composer {...base} canSend onPrompt={async () => {}} />)
    expect(textarea().value).toBe("persisted")
  })

  it("bounds a draft to 32 KiB without splitting a code point", () => {
    expect(boundedDraft("a".repeat(40_000))).toHaveLength(32 * 1024)
    const wide = boundedDraft("🙂".repeat(20_000))
    expect(new TextEncoder().encode(wide).length).toBeLessThanOrEqual(32 * 1024)
    expect(wide.endsWith("🙂")).toBe(true)
  })
})

describe("sendGate", () => {
  it("refuses to send without a wired sandbox and says why", () => {
    expect(sendGate({ model: undefined, sandbox: undefined, connection: "online" })).toEqual({
      canSend: false,
      reason: expect.stringContaining("沙箱"),
    })
  })

  it("refuses to send when the model is not ready and carries the host reason", () => {
    const gate = sendGate({
      model: { status: "unconfigured", reason: "尚未選擇模型" },
      sandbox: { mode: "read-only", source: "settings", wired: true },
      connection: "online",
    })

    expect(gate.canSend).toBe(false)
    expect(gate.reason).toContain("尚未選擇模型")
  })

  it("allows a send only when the sandbox is wired and the model is ready", () => {
    expect(sendGate({
      model: { status: "ready", providerId: "fixture", modelId: "m", label: "fixture: m" },
      sandbox: { mode: "workspace-write", source: "settings", wired: true },
      connection: "online",
    })).toEqual({ canSend: true })
  })

  it("keeps Send disabled while the SDK connection is down", () => {
    const gate = sendGate({
      model: { status: "ready", providerId: "fixture", modelId: "m", label: "fixture: m" },
      sandbox: { mode: "workspace-write", source: "settings", wired: true },
      connection: "offline",
    })

    expect(gate.canSend).toBe(false)
    expect(gate.reason).toContain("中斷")
  })
})

describe("TaskPane", () => {
  it("shows an unconfirmed empty task list instead of claiming everything finished", () => {
    render(<TaskPane queue={[]} tasks={[]} />)

    expect(screen.getByText("暫無可確認的任務")).toBeTruthy()
    expect(screen.queryByText("全部完成")).toBeNull()
  })

  it("offers cancel only for task rows that allow it", () => {
    const onCancelTask = vi.fn()
    render(<TaskPane
      queue={[{ id: "q1", text: "next turn", delivery: "queue", intent: "user", state: "queued", order: 1 }]}
      tasks={[
        { id: "t1", group: "subagent", label: "child run", status: "running", canCancel: true },
        { id: "t2", group: "job", label: "scheduled job", status: "completed", canCancel: false },
      ]}
      onCancelTask={onCancelTask}
    />)

    const buttons = screen.getAllByRole("button", { name: "取消" })
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0]!)
    expect(onCancelTask).toHaveBeenCalledWith("t1")
    expect(screen.getByText("next turn")).toBeTruthy()
  })
})
