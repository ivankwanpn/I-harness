// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { PendingPanel } from "../src/renderer/interaction/PendingPanel.tsx"
import { ApprovalRuleManager } from "../src/renderer/settings/ApprovalRuleManager.tsx"
import type { DesktopBridge } from "../src/shared/bridge.ts"
afterEach(cleanup)

it("defaults remembering off and sends exact scope and expiry only after explicit checkbox input", async () => {
  const reply = vi.fn(async (_input: import("../src/renderer/interaction/PendingPanel.tsx").InteractionReply) => {})
  render(<PendingPanel pending={[{ requestId: "r", sessionId: "s", kind: "approval", openedAt: 1, payload: { name: "native", reason: "ask", remember: { available: true, candidateId: "c", arguments: '{"value":"one"}' } } }]} onReply={reply} />)
  const checkbox = screen.getByRole("checkbox", { name: "記住此操作的完整參數" }) as HTMLInputElement
  expect(checkbox.checked).toBe(false)
  fireEvent.click(screen.getByRole("button", { name: "批准" }))
  await waitFor(() => expect(reply).toHaveBeenCalledWith({ requestId: "r", decision: { kind: "approval", approved: true } }))
  fireEvent.click(checkbox)
  fireEvent.change(screen.getByRole("combobox", { name: "規則作用範圍" }), { target: { value: "workspace" } })
  fireEvent.click(screen.getByRole("button", { name: "批准" }))
  await waitFor(() => expect(reply.mock.calls[1]?.[0]).toMatchObject({ decision: { kind: "approval", approved: true, remember: { scope: "workspace", expiresAt: expect.any(Number) } } }))
})

it("keeps failed remember input visible and never offers remembered grants for restored cards", async () => {
  const row = { requestId: "r", sessionId: "s", kind: "approval" as const, openedAt: 1, payload: { name: "native", reason: "ask", remember: { available: true, candidateId: "c", arguments: '{"value":"one"}' } } }
  const view = render(<PendingPanel pending={[row]} onReply={async () => { throw new Error("rule save failed") }} />)
  fireEvent.click(screen.getByRole("checkbox", { name: "記住此操作的完整參數" }))
  fireEvent.click(screen.getByRole("button", { name: "批准" }))
  await screen.findByText("rule save failed")
  expect((screen.getByRole("checkbox", { name: "記住此操作的完整參數" }) as HTMLInputElement).checked).toBe(true)
  view.rerender(<PendingPanel pending={[{ ...row, state: "interrupted" }]} onReply={async () => {}} />)
  expect(screen.queryByRole("checkbox", { name: "記住此操作的完整參數" })).toBeNull()
})

it("offers pending validated operations to add and durable rules to revoke", async () => {
  const request = vi.fn(async (action: any) => action.kind === "desktop/approval-rules/state" ? { rules: [{ id: "rule", evidence: { name: "native", arguments: '{"value":"one"}' }, scope: { kind: "workspace" }, createdAt: 1, expiresAt: Date.now() + 86400000 }], candidates: [{ requestId: "r", sessionId: "s", name: "native", arguments: '{"value":"two"}' }] } : { accepted: true })
  render(<ApprovalRuleManager bridge={{ request } as unknown as DesktopBridge} workspaceId="w" />)
  await screen.findByRole("button", { name: "撤銷規則" })
  fireEvent.click(screen.getByRole("button", { name: "撤銷規則" }))
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "desktop/approval-rules/revoke", workspaceId: "w", ruleId: "rule" }))
  fireEvent.click(screen.getByRole("button", { name: "新增規則" }))
  await waitFor(() => expect(request.mock.calls.some(([action]: any) => action.kind === "desktop/approval-rules/add" && action.requestId === "r" && action.sessionId === "s")).toBe(true))
})
