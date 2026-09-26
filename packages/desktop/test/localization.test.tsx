// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { useLocale, useText } from "../src/renderer/design/i18n.ts"
import { ReviewPane } from "../src/renderer/review/ReviewPane.tsx"
import { TaskPane } from "../src/renderer/session/TaskPane.tsx"
import { PendingPanel } from "../src/renderer/interaction/PendingPanel.tsx"
import { sendGate } from "../src/renderer/session/send-gate.ts"
afterEach(() => { cleanup(); useLocale.getState().setLocale("zh-TW") })

it("updates review reasons and truncation values when language changes", () => {
  const view = render(<ReviewPane changes={{ kind: "unavailable", reason: "not-git-repo" }} onSelect={() => {}} onRefresh={() => {}} />)
  act(() => useLocale.getState().setLocale("en"))
  expect(screen.getByText("This is not a Git workspace; changes cannot be listed")).toBeTruthy()
  view.rerender(<ReviewPane selected={{ path: "test", mode: "preview" }} preview={{ kind: "text", text: "內容保持原文", bytes: 24, truncated: true }} onSelect={() => {}} onRefresh={() => {}} />)
  expect(screen.getByText(/truncated to the first 24 bytes/)).toBeTruthy()
  expect(screen.getByText("內容保持原文")).toBeTruthy()
})

it("localizes task and reply controls without translating backend content", () => {
  useLocale.getState().setLocale("en")
  render(<><TaskPane queue={[]} tasks={[{ id: "t1", group: "job", label: "原始任務名", status: "completed", canCancel: false }]} />
    <PendingPanel pending={[{ requestId: "r", sessionId: "s", kind: "approval", payload: {}, openedAt: 1 }]} onReply={async () => {}} /></>)
  expect(screen.getByText("Completed")).toBeTruthy()
  expect(screen.getByText("原始任務名")).toBeTruthy()
  expect(screen.getByText("Tool request")).toBeTruthy()
  expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy()
})

it("localizes the send gate while retaining its safety decision", () => {
  function Gate() { const t = useText(); const gate = sendGate({ connection: "offline", model: undefined, sandbox: undefined }, t); return <p>{gate.canSend ? "unexpected" : gate.reason}</p> }
  useLocale.getState().setLocale("en")
  render(<Gate />)
  expect(screen.getByText("SDK disconnected; sending is disabled")).toBeTruthy()
})
