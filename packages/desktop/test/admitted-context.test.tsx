// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { append, contextStateFromBudget, createSession, readSessionContextState } from "../../core-session/src/index.ts"
import { createOwnedBudget } from "../../core-agent/src/agent/budget.ts"
import { createAnthropicClient } from "../../llm-anthropic/src/index.ts"
import { ContextUsage } from "../src/renderer/session/ContextUsage.tsx"

afterEach(cleanup)
async function projection() {
  const session = createSession()
  const owner = createOwnedBudget(session, "owned", () => undefined, () => 0, () => ({ surface: "fixture", model: client }))
  append(session, { type: "user/message", text: "hello" })
  const client = createAnthropicClient({ model: "controlled", apiKey: "fixture", inputModalities: ["text", "image"] })
  const prepared = await client.prepare!({ systemPrompt: "Actual system", messages: [
    { role: "user", content: "hello" },
    { role: "assistant", content: "answer", toolCalls: [{ id: "c", name: "read", args: {} }], thinkingBlocks: [{ type: "thinking", thinking: "controlled replayed plan", signature: "fixture-signature" }], providerContinuation: { kind: "anthropic", model: "controlled", contentOrder: [{ kind: "reasoning", index: 0 }, { kind: "text", text: "answer" }, { kind: "tool", index: 0 }] } },
    { role: "tool", toolCallId: "c", content: "controlled result" },
  ], tools: [{ name: "read", description: "Actual schema", inputSchema: { type: "object" } }] })
  const { snapshot } = owner.assess(prepared, 10000, 1024)
  return { snapshot, owner, state: contextStateFromBudget(owner.read()) }
}
async function show(state: unknown) {
  const request = vi.fn().mockResolvedValue(state)
  render(<ContextUsage bridge={{ request, onEvent: () => () => {} }} workspaceId="w" sessionId="owned" />)
  await act(async () => {})
  fireEvent.click(screen.getByRole("button", { name: "上下文容量" }))
  return request
}

function fact(label: string, value: number) {
  const term = screen.getByText(label, { selector: "dt" })
  expect(within(term.parentElement!).getByRole("definition").textContent).toBe(new Intl.NumberFormat("en-US").format(value))
}

it("renders actual projected components, reserve, coverage, and cap support", async () => {
  const { state, snapshot } = await projection()
  const request = await show(state)
  fact("系統提示", snapshot.systemTokens)
  fact("工具定義", snapshot.schemaTokens)
  expect(snapshot.reasoningTokens).toBeGreaterThan(0)
  fact("重用推理", snapshot.reasoningTokens)
  expect(screen.getByText("已準備輸入的估算 · 部分內容成本不確定 · 已包含完整輸入")).toBeTruthy()
  fact("輸出預留", snapshot.outputReserve)
  fact("上次估算輸入", snapshot.estimatedInputTokens)
  fact("安全餘量", snapshot.safetyMargin)
  fact("剩餘輸入預算", snapshot.remainingInputBudget!)
  expect(request).toHaveBeenCalledTimes(1)
})

it("shows input uncertainty from the actual projection without exposing signatures", async () => {
  const { state } = await projection()
  await show(state)
  expect(screen.getByText(/部分內容成本不確定 · 已包含完整輸入/)).toBeTruthy()
  expect(document.body.textContent).not.toMatch(/iVBOR|fixture-signature|controlled replayed plan/)
})

it.each(["accepted", "provider"])("keeps %s facts without a healthy gauge", async kind => {
  const { snapshot } = await projection()
  const state = contextStateFromBudget({ kind: "ready", snapshot: { ...snapshot,
    admission: kind === "accepted" ? "unavailable" : "compact", recoveryRequired: kind === "provider", fullByProvider: kind === "provider",
    reason: kind === "accepted" ? "Accepted output awaits the next protocol projection" : "Provider context recovery remains required" } })
  await show(state)
  expect(screen.getByRole("button", { name: "上下文容量" }).textContent).toBe("—")
  expect(screen.queryByRole("progressbar")).toBeNull()
  fact("系統提示", snapshot.systemTokens)
  expect(screen.queryByText("剩餘輸入預算")).toBeNull()
  expect(screen.getByText(kind === "accepted" ? /模型已回覆；下一次請求準備完成後會重新估算容量。/ : /供應商拒絕了目前上下文，需先壓縮或更換模型。/)).toBeTruthy()
})

it("rejects invalid or cross-owner snapshots while preserving legacy gateway readings", async () => {
  const { state, snapshot } = await projection()
  expect(readSessionContextState({ ...state, snapshot: { ...snapshot, outputReserve: -1 } }).kind).toBe("unavailable")
  expect(readSessionContextState(state, "other").kind).toBe("unavailable")
  expect(readSessionContextState({ kind: "ready", estimatedTokens: 12, contextWindow: 100 })).toEqual({ kind: "ready", estimatedTokens: 12, contextWindow: 100 })
})
