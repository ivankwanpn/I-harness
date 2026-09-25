// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { boundedDraft, Composer } from "../src/renderer/session/Composer.tsx"
import { sendGate } from "../src/renderer/session/send-gate.ts"
import { TaskPane } from "../src/renderer/session/TaskPane.tsx"

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

const base = { workspaceId: "ws-1", sessionId: "s1", running: false, onCancel: vi.fn() }

function textarea(): HTMLTextAreaElement {
  return screen.getByLabelText("提示") as HTMLTextAreaElement
}

describe("Composer", () => {
  it("disables Send with a reason when the model is unconfigured", () => {
    render(<Composer {...base} canSend={false} sendReason="模型尚未設定" onPrompt={async () => {}} />)

    expect((screen.getByRole("button", { name: "送出" }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText("模型尚未設定")).toBeTruthy()
  })

  it("enables Stop only while a prompt is running and keeps Send behind the gate", () => {
    const running = render(<Composer {...base} running canSend onPrompt={async () => {}} />)
    expect((screen.getByRole("button", { name: "停止" }) as HTMLButtonElement).disabled).toBe(false)
    running.unmount()

    render(<Composer {...base} canSend onPrompt={async () => {}} />)
    expect((screen.getByRole("button", { name: "停止" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("keeps the draft when a send fails and clears it only after a confirmed send", async () => {
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

    await waitFor(() => { expect(succeeded).toHaveBeenCalledWith("keep me") })
    await waitFor(() => { expect(textarea().value).toBe("") })
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
    expect(sendGate({ model: undefined, sandbox: undefined })).toEqual({
      canSend: false,
      reason: expect.stringContaining("沙箱"),
    })
  })

  it("refuses to send when the model is not ready and carries the host reason", () => {
    const gate = sendGate({
      model: { status: "unconfigured", reason: "尚未選擇模型" },
      sandbox: { mode: "read-only", source: "settings", wired: true },
    })

    expect(gate.canSend).toBe(false)
    expect(gate.reason).toContain("尚未選擇模型")
  })

  it("allows a send only when the sandbox is wired and the model is ready", () => {
    expect(sendGate({
      model: { status: "ready", providerId: "fixture", modelId: "m", label: "fixture: m" },
      sandbox: { mode: "workspace-write", source: "settings", wired: true },
    })).toEqual({ canSend: true })
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
