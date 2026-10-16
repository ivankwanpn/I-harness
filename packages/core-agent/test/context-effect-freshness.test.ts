import { expect, it } from "vitest"
import { append, createSession } from "@i-harness/core-session"
import { captureRequestCandidate, sameRequestCandidate } from "../src/agent/request-snapshot.ts"

it.each([false, true])("contradictory dispatch invalidates the actual candidate guard for a closed exchange (explicit=%s)", explicit => {
  const session = createSession()
  if (explicit) append(session, { type: "conversation/semantics", version: 1, mode: "accepted-exchange-v1" })
  const step = session.events.length
  append(session, { type: "step/start", ...(explicit ? { actionId: "a", attemptId: "attempt" } : {}) })
  const call = session.events.length
  append(session, { type: "tool/call", callId: "c", name: "probe", args: {} })
  const assistant = session.events.length
  append(session, { type: "assistant/message", text: "called" })
  if (explicit) append(session, { type: "model/exchange-accepted", version: 1, exchangeId: "accepted", actionId: "a", attemptId: "attempt", stepStartSeq: step, assistantSeq: assistant, callSeqs: [call] })
  append(session, { type: "tool/result", callId: "c", name: "probe", isError: true, output: { code: "TOOL_ABORTED_BEFORE_DISPATCH" } })
  append(session, { type: "step/end" })
  const model = { async *stream() {} }, surface = { systemPrompt: "s", tools: [] }
  const before = captureRequestCandidate(session, "owner", { model }, surface, 0)
  const exchange = before.snapshot.conversation.items.find(item => item.exchange)!
  expect(exchange.exchange).toMatchObject({ state: "closed", calls: [{ outcome: "error" }] })
  expect(before.snapshot.protection.itemIds).toEqual([])
  append(session, { type: "tool/dispatch", callId: "c", eventSeq: call })
  const after = captureRequestCandidate(session, "owner", { model }, surface, 0)
  expect(after.snapshot.conversation.items.find(item => item.exchange)?.exchange).toMatchObject({ state: "closed", calls: [{ outcome: "unknown" }] })
  expect(after.snapshot.coordinates.semanticRevision).toBe(before.snapshot.coordinates.semanticRevision)
  expect(after.snapshot.coordinates.branchId).toBe(before.snapshot.coordinates.branchId)
  expect(after.snapshot.coordinates.contextEpoch).toBe(before.snapshot.coordinates.contextEpoch)
  expect(after.snapshot.surfaceRevision).toBe(before.snapshot.surfaceRevision)
  expect(after.snapshot.coordinates.protectionRevision).not.toBe(before.snapshot.coordinates.protectionRevision)
  expect(after.snapshot.protection.itemIds).toContain(exchange.id)
  expect(sameRequestCandidate(before, after)).toBe(false)
})

it("keeps a settled closed success eligible and stable under matching dispatch evidence", () => {
  const session = createSession()
  append(session, { type: "step/start" }); append(session, { type: "tool/call", callId: "c", name: "probe", args: {} })
  append(session, { type: "assistant/message", text: "called" }); append(session, { type: "tool/result", callId: "c", name: "probe", output: "ok" }); append(session, { type: "step/end" })
  const model = { async *stream() {} }, surface = { systemPrompt: "s", tools: [] }
  const before = captureRequestCandidate(session, "owner", { model }, surface, 0)
  append(session, { type: "tool/dispatch", callId: "c", eventSeq: 1 })
  const after = captureRequestCandidate(session, "owner", { model }, surface, 0)
  expect(after.snapshot.protection.itemIds).toEqual([])
  expect(sameRequestCandidate(before, after)).toBe(true)
})

it("hashes pending-to-unknown effect state even when protected source IDs stay equal", () => {
  const session = createSession()
  append(session, { type: "step/start" }); append(session, { type: "tool/call", callId: "c", name: "probe", args: {} })
  const model = { async *stream() {} }, surface = { systemPrompt: "s", tools: [] }
  const before = captureRequestCandidate(session, "owner", { model }, surface, 0)
  append(session, { type: "step/end" })
  const after = captureRequestCandidate(session, "owner", { model }, surface, 0)
  expect(before.snapshot.conversation.items[0]!.exchange!.calls[0]!.outcome).toBe("pending")
  expect(after.snapshot.conversation.items[0]!.exchange!.calls[0]!.outcome).toBe("unknown")
  expect(after.snapshot.protection).toEqual(before.snapshot.protection)
  expect(after.snapshot.coordinates.semanticRevision).toBe(before.snapshot.coordinates.semanticRevision)
  expect(sameRequestCandidate(before, after)).toBe(false)
})
