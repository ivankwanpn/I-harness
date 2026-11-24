// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { ConversationBranches } from "../src/renderer/session/ConversationBranches.tsx"
import { SessionHistoryView } from "../src/renderer/session/SessionHistoryView.tsx"

afterEach(cleanup)

it("navigates to the original conversation or confirmed source point", async () => {
  const onSelect = vi.fn(), onHistory = vi.fn()
  render(<ConversationBranches bridge={{ request: async () => ({
    events: [{ type: "conversation/seed-manifest", selection: { kind: "completed", atSeq: 25 } }],
  }), onEvent: () => () => {} }} workspaceId="folder" sessionId="b"
    sessions={[{ id: "a", title: "原會話" }, { id: "b", forkParentId: "a", title: "另一方案" }]}
    onSelect={onSelect} onHistory={onHistory} onClose={() => {}} />)
  fireEvent.click(screen.getByRole("button", { name: /來源.*原會話/ }))
  expect(onSelect).toHaveBeenCalledWith("a")
  fireEvent.click(await screen.findByRole("button", { name: "前往分叉位置" }))
  expect(onHistory).toHaveBeenCalledWith({ workspaceId: "folder", sessionId: "a", seq: 25 })
})

it("forks a search result at its confirmed completed turn boundary", async () => {
  const onForkAt = vi.fn(async () => {})
  render(<SessionHistoryView selection={{ workspaceId: "folder", sessionId: "a", seq: 11 }}
    request={async () => ({
      nextSeq: 18, events: [{ type: "user/message", seq: 11, text: "result" }],
      turns: [{ startSeq: 10, endSeq: 17 }],
    })} onLatest={() => {}} onForkAt={onForkAt} />)
  fireEvent.click(await screen.findByRole("button", { name: "從這個已完成回合建立分支" }))
  expect(onForkAt).toHaveBeenCalledWith({ workspaceId: "folder", sessionId: "a", seq: 17 })
})
