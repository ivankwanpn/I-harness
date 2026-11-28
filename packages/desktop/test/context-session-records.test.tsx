// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ContextSessionRecords } from "../src/renderer/session/ContextSessionRecords.tsx"
import type { DesktopBridge } from "../src/shared/bridge.ts"

afterEach(cleanup)

it("reads earlier public records on demand and can return to the live window", async () => {
  const request = vi.fn<DesktopBridge["request"]>().mockResolvedValue({ startSeq: 0, nextSeq: 2, events: [
    { type: "user/message", seq: 0, text: "Earlier public input" },
    { type: "user/message", seq: 1, text: "Internal input", internal: true },
  ] })
  const bridge: DesktopBridge = { request, onEvent: () => () => {} }
  render(<ContextSessionRecords bridge={bridge} workspaceId="workspace" sessionId="session"
    recent={[{ type: "assistant/message", seq: 2, text: "Recent reply" }]} instructions={false} />)
  expect(request).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText("assistant"))
  expect(screen.getByText(/Recent reply/)).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "較早記錄" }))
  await waitFor(() => expect(screen.getByText("user")).toBeTruthy())
  expect(request).toHaveBeenCalledExactlyOnceWith({ kind: "session/history", workspaceId: "workspace", sessionId: "session", afterSeq: 0, beforeSeq: 2, limit: 100 })
  expect(screen.queryByText("#1")).toBeNull()
  expect(screen.queryByText(/Earlier public input/)).toBeNull()
  fireEvent.click(screen.getByText("user"))
  expect(screen.getByText(/Earlier public input/)).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "返回最新記錄" }))
  expect(screen.getByText("#2")).toBeTruthy()
  expect(screen.queryByText(/Earlier public input/)).toBeNull()
})
