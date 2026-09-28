// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { PendingPanel } from "../src/renderer/interaction/PendingPanel.tsx"
import type { PendingInteraction } from "../src/renderer/interaction/pending.ts"

afterEach(cleanup)

const approval: PendingInteraction = {
  requestId: "r1",
  sessionId: "s1",
  kind: "approval",
  payload: { name: "write", reason: "edit D:/workspace/notes.md" },
  openedAt: 1,
}

const question: PendingInteraction = {
  requestId: "r2",
  sessionId: "s1",
  kind: "question",
  payload: { id: "q1", prompt: "要用哪個方案？", options: ["A", "B"] },
  openedAt: 2,
}

describe("PendingPanel", () => {
  it("preserves a typed question answer when submission fails", async () => {
    render(<PendingPanel pending={[{ ...question, payload: { prompt: "補充說明" } }]} onReply={async () => { throw new Error("reply failed") }} />)
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "不要遺失" } })
    fireEvent.click(screen.getByRole("button", { name: "送出回答" }))
    await screen.findByText("reply failed")
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("不要遺失")
  })
  it("keeps concurrent requests independently busy", async () => {
    let finishFirst!: () => void
    let finishSecond!: () => void
    const onReply = vi.fn(({ requestId }: { requestId: string }) => new Promise<void>((resolve) => {
      if (requestId === "r1") finishFirst = resolve
      else finishSecond = resolve
    }))
    render(<PendingPanel pending={[approval, { ...approval, requestId: "other" }]} onReply={onReply} />)
    fireEvent.click(screen.getAllByRole("button", { name: "批准" })[0]!)
    fireEvent.click(screen.getAllByRole("button", { name: "批准" })[1]!)
    expect(screen.getAllByRole("button", { name: "批准" }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true)
    finishFirst()
    await waitFor(() => expect((screen.getAllByRole("button", { name: "批准" })[0] as HTMLButtonElement).disabled).toBe(false))
    expect((screen.getAllByRole("button", { name: "批准" })[1] as HTMLButtonElement).disabled).toBe(true)
    finishSecond()
    await waitFor(() => expect(screen.getAllByRole("button", { name: "批准" }).every((button) => !(button as HTMLButtonElement).disabled)).toBe(true))
  })
  it("shows the approval reason and replies with an explicit decision", async () => {
    const onReply = vi.fn(async () => {})
    render(<PendingPanel pending={[approval]} onReply={onReply} />)

    expect(screen.getByText(/edit D:\/workspace\/notes\.md/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: "確認" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "批准" }))
    await waitFor(() => {
      expect(onReply).toHaveBeenCalledWith({ requestId: "r1", decision: { kind: "approval", approved: true } })
    })
    fireEvent.click(screen.getByRole("button", { name: "拒絕" }))
    await waitFor(() => {
      expect(onReply).toHaveBeenCalledWith({ requestId: "r1", decision: { kind: "approval", approved: false } })
    })
  })
  it("shows the command itself before one-click approval", () => {
    render(<PendingPanel pending={[{ ...approval, payload: { name: "bash", reason: "tool requires approval", command: "pwd && echo APPROVAL_ACTION_42" } }]} onReply={async () => {}} />)
    expect(screen.getByText("pwd && echo APPROVAL_ACTION_42")).toBeTruthy()
    expect(screen.getByRole("button", { name: "批准" })).toBeTruthy()
  })
  it("shows executable arguments instead of only its name", () => {
    render(<PendingPanel pending={[{ ...approval, payload: { name: "terminal_open", reason: "tool requires approval", command: "powershell.exe", argumentsSummary: '{"command":"powershell.exe","args":["-Command","Remove-Item outside"]}' } }]} onReply={async () => {}} />)
    expect(screen.getByText(/Remove-Item outside/)).toBeTruthy()
  })

  it("answers a question with the selected option", async () => {
    const onReply = vi.fn(async () => {})
    render(<PendingPanel pending={[question]} onReply={onReply} />)

    expect(screen.getByText("要用哪個方案？")).toBeTruthy()
    fireEvent.click(screen.getByRole("radio", { name: "B" }))
    expect(onReply).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "送出回答" }))
    await waitFor(() => {
      expect(onReply).toHaveBeenCalledWith({ requestId: "r2", decision: { kind: "question", answer: "B" } })
    })
  })

  it("keeps a failed reply visible instead of pretending it was accepted", async () => {
    const onReply = vi.fn(async () => { throw new Error("宿主拒絕") })
    render(<PendingPanel pending={[approval]} onReply={onReply} />)

    fireEvent.click(screen.getByRole("button", { name: "批准" }))

    await waitFor(() => { expect(screen.getByText("宿主拒絕")).toBeTruthy() })
    expect(screen.getByRole("button", { name: "批准" })).toBeTruthy()
  })

  it("renders nothing when nothing is pending", () => {
    const view = render(<PendingPanel pending={[]} onReply={async () => {}} />)
    expect(view.container.innerHTML).toBe("")
  })
})
