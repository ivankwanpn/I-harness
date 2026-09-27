// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ContextUsage } from "../src/renderer/session/ContextUsage.tsx"

afterEach(cleanup)
it("shows only backend-estimated context usage on demand", async () => {
  const request = vi.fn().mockResolvedValue({ kind: "ready", estimatedTokens: 49000, contextWindow: 1000000,
    roleTokens: { user: 10000, assistant: 9000, tool: 30000 } })
  render(<ContextUsage bridge={{ request, onEvent: () => () => {} }} workspaceId="w" sessionId="s" />)
  expect(request).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "上下文容量" }))
  expect(await screen.findByText(/49,000/)).toBeTruthy()
  expect(screen.getByText(/1,000,000/)).toBeTruthy()
  expect(screen.getByText(/4.9%/)).toBeTruthy()
  expect(screen.getByText(/30,000/)).toBeTruthy()
  expect(screen.getByText(/10,000/)).toBeTruthy()
  expect(screen.queryByText(/^快取命中率/)).toBeNull()
  expect(request).toHaveBeenCalledWith({ kind: "session/context", workspaceId: "w", sessionId: "s" })
})

it("keeps the context total visible when a running gateway has no role breakdown", async () => {
  const request = vi.fn().mockResolvedValue({ kind: "ready", estimatedTokens: 12, contextWindow: 100 })
  render(<ContextUsage bridge={{ request, onEvent: () => () => {} }} workspaceId="w" sessionId="s" />)
  fireEvent.click(screen.getByRole("button", { name: "上下文容量" }))
  expect(await screen.findByText(/12 \/ 100/)).toBeTruthy()
  expect(screen.queryByText("使用者訊息")).toBeNull()
})

it("moves focus into context details and returns it to the trigger on Escape", async () => {
  const request = vi.fn().mockResolvedValue({ kind: "ready", estimatedTokens: 12, contextWindow: 100 })
  render(<ContextUsage bridge={{ request, onEvent: () => () => {} }} workspaceId="w" sessionId="s" />)
  const trigger = screen.getByRole("button", { name: "上下文容量" })
  trigger.focus()
  fireEvent.click(trigger)
  const dialog = await screen.findByRole("dialog", { name: "上下文容量" })
  expect(document.activeElement).toBe(dialog)
  fireEvent.keyDown(document, { key: "Escape" })
  expect(document.activeElement).toBe(trigger)
})
