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
  it("shows the approval reason and replies with an explicit decision", async () => {
    const onReply = vi.fn(async () => {})
    render(<PendingPanel pending={[approval]} onReply={onReply} />)

    expect(screen.getByText(/edit D:\/workspace\/notes\.md/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "批准" }))
    await waitFor(() => {
      expect(onReply).toHaveBeenCalledWith({ requestId: "r1", decision: { kind: "approval", approved: true } })
    })
    fireEvent.click(screen.getByRole("button", { name: "拒絕" }))
    await waitFor(() => {
      expect(onReply).toHaveBeenCalledWith({ requestId: "r1", decision: { kind: "approval", approved: false } })
    })
  })

  it("answers a question with the selected option", async () => {
    const onReply = vi.fn(async () => {})
    render(<PendingPanel pending={[question]} onReply={onReply} />)

    expect(screen.getByText("要用哪個方案？")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "B" }))
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
