// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { Workbench } from "../src/renderer/shell/Workbench.tsx"
import { PendingPanel } from "../src/renderer/interaction/PendingPanel.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"

afterEach(() => { cleanup(); localStorage.clear(); useUiStore.setState({ surface: "conversation", locale: "zh-TW", reviewOpen: false }) })
const row = { requestId: "owned-question", sessionId: "owned-session", kind: "question" as const, openedAt: 1, payload: { prompt: "Owned free answer", options: [] } }
it("keeps the free answer through actual Workbench Settings navigation", async () => {
  const bridge = { request: vi.fn(async () => undefined), onEvent: () => () => {} }
  render(<Workbench bridge={bridge} workspaces={[{ id: "owned", label: "Owned", path: "D:/owned" }]} selectedWorkspaceId="owned" selectedSessionId="owned-session" capabilities={{}} onSelectWorkspace={() => {}} onSelectSession={() => {}}
    conversation={{ rows: [], running: true, canSend: true, pending: [row], onPrompt: async () => {}, onCancel() {}, onCancelTask() {}, onCancelQueue() {}, onReply: async () => {} }} />)
  fireEvent.change(screen.getByRole("textbox", { name: "回答 Owned free answer" }), { target: { value: "Keep my answer" } })
  fireEvent.click(screen.getByRole("button", { name: "設定" }))
  fireEvent.click(screen.getByRole("button", { name: "返回會話" }))
  expect((screen.getByRole("textbox", { name: "回答 Owned free answer" }) as HTMLTextAreaElement).value).toBe("Keep my answer")
})

it("keeps the pending reply owner and error through unmount, preventing duplicate submission", async () => {
  let reject!: (reason: Error) => void
  const pending = new Promise<void>((_, fail) => { reject = fail })
  const reply = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(undefined)
  const props = { draftOwner: {}, workspaceId: "owned", pending: [row], onReply: reply }
  const view = render(<PendingPanel {...props} />)
  fireEvent.change(screen.getByRole("textbox", { name: "回答 Owned free answer" }), { target: { value: "Retained answer" } })
  fireEvent.click(screen.getByRole("button", { name: "送出回答" }))
  view.unmount(); render(<PendingPanel {...props} />)
  const busy = screen.getByRole("button", { name: "正在送出…" }) as HTMLButtonElement
  expect(busy.disabled).toBe(true)
  fireEvent.click(busy)
  expect(reply).toHaveBeenCalledTimes(1)
  await act(async () => reject(new Error("Owned reply rejected")))
  expect((await screen.findByRole("alert")).textContent).toContain("Owned reply rejected")
  expect((screen.getByRole("textbox", { name: "回答 Owned free answer" }) as HTMLTextAreaElement).value).toBe("Retained answer")
  fireEvent.click(screen.getByRole("button", { name: "送出回答" }))
  await waitFor(() => expect(reply).toHaveBeenCalledTimes(2))
  await waitFor(() => expect((screen.getByRole("textbox", { name: "回答 Owned free answer" }) as HTMLTextAreaElement).value).toBe(""))
})

it("separates identical question identifiers in two workspace scopes", () => {
  const props = { draftOwner: {}, pending: [row], onReply: async () => {} }
  const view = render(<PendingPanel {...props} workspaceId="a" />)
  fireEvent.change(screen.getByRole("textbox", { name: "回答 Owned free answer" }), { target: { value: "Only A" } })
  view.rerender(<PendingPanel {...props} workspaceId="b" />)
  expect((screen.getByRole("textbox", { name: "回答 Owned free answer" }) as HTMLTextAreaElement).value).toBe("")
  view.rerender(<PendingPanel {...props} workspaceId="a" />)
  expect((screen.getByRole("textbox", { name: "回答 Owned free answer" }) as HTMLTextAreaElement).value).toBe("Only A")
})
