import { expect, it } from "vitest"
import { append, createSession } from "@i-harness/core-session"
import { captureContextSnapshot, readContextCoordinates } from "../src/index.ts"

it('keeps physical input closure in protection identity and telemetry outside both identities', () => {
  const session = createSession()
  append(session, { type: 'turn/start' }); append(session, { type: 'step/start' })
  append(session, { type: 'user/message', text: 'H' }); append(session, { type: 'turn/end' })
  const capture = () => {
    const result = captureContextSnapshot(session, { ownerSessionId: 'owner', surface: { systemPrompt: 's', tools: [] } })
    if (result.kind !== 'captured') throw Error('capture required')
    return result.snapshot
  }
  const before = capture()
  append(session, { type: 'step/end' })
  const closed = capture()
  expect(closed.conversation.items.map(item => item.messages)).toEqual(before.conversation.items.map(item => item.messages))
  expect(closed.coordinates.semanticRevision).toBe(before.coordinates.semanticRevision)
  expect(closed.coordinates.protectionRevision).not.toBe(before.coordinates.protectionRevision)
  expect(closed.protection.itemIds).toEqual([])
  append(session, { type: 'operator/run-end', version: 1, runId: 'diagnostic', exitCode: 0, durationMs: 1, phase: 'session' })
  const telemetry = capture()
  expect(telemetry.coordinates.semanticRevision).toBe(closed.coordinates.semanticRevision)
  expect(telemetry.coordinates.protectionRevision).toBe(closed.coordinates.protectionRevision)
})

it("keeps archive telemetry outside semantic identity and reproduces cold coordinates", () => {
  const session = createSession()
  append(session, { type: "user/message", text: "retain" })
  append(session, { type: "assistant/message", text: "answer" })
  const before = readContextCoordinates(session, { ownerSessionId: "owner" })
  append(session, { type: "operator/run-end", version: 1, runId: "run-A", exitCode: 0, durationMs: 1, phase: "turn" })
  const after = readContextCoordinates(session, { ownerSessionId: "owner" })
  expect(before.kind).toBe("available"); expect(after.kind).toBe("available")
  if (before.kind !== "available" || after.kind !== "available") throw Error("coordinates required")
  expect(after.observationRevision).toBe(before.observationRevision)
  expect(after.coordinates.archive.eventCount).toBe(before.coordinates.archive.eventCount + 1)
  const replay = { ...session, events: session.events.map(event => structuredClone(event)) }
  expect(readContextCoordinates(replay, { ownerSessionId: "owner" })).toEqual(after)
  append(session, { type: "assistant/message", text: "answer" })
  const changed = readContextCoordinates(session, { ownerSessionId: "owner" })
  expect(changed.kind === "available" && changed.coordinates.semanticRevision).not.toBe(before.coordinates.semanticRevision)
})

it("omits audit-only unaccepted fragments but identities distinguish newly accepted identical text", () => {
  const session = createSession()
  append(session, { type: "conversation/semantics", version: 1, mode: "accepted-exchange-v1" })
  const before = readContextCoordinates(session, { ownerSessionId: "owner" })
  append(session, { type: "step/start", actionId: "a", attemptId: "attempt-a" })
  append(session, { type: "assistant/message", text: "answer" }); append(session, { type: "step/failed" }); append(session, { type: "step/end" })
  const failed = readContextCoordinates(session, { ownerSessionId: "owner" })
  expect(before.kind === "available" && failed.kind === "available" && failed.coordinates.semanticRevision).toBe(before.kind === "available" && before.coordinates.semanticRevision)
  append(session, { type: "step/start", actionId: "b", attemptId: "attempt-b" }); append(session, { type: "assistant/message", text: "answer" })
  append(session, { type: "model/exchange-accepted", version: 1, exchangeId: "accepted-b", actionId: "b", attemptId: "attempt-b", stepStartSeq: 5, assistantSeq: 6, callSeqs: [] }); append(session, { type: "step/end" })
  const accepted = readContextCoordinates(session, { ownerSessionId: "owner" })
  expect(accepted.kind === "available" && accepted.coordinates.semanticRevision).not.toBe(before.kind === "available" && before.coordinates.semanticRevision)
  append(session, { type: "step/start", actionId: "c", attemptId: "attempt-c" }); append(session, { type: "assistant/message", text: "answer" })
  append(session, { type: "model/exchange-accepted", version: 1, exchangeId: "accepted-c", actionId: "c", attemptId: "attempt-c", stepStartSeq: 9, assistantSeq: 10, callSeqs: [] }); append(session, { type: "step/end" })
  const repeated = readContextCoordinates(session, { ownerSessionId: "owner" })
  expect(repeated.kind === "available" && repeated.coordinates.semanticRevision).not.toBe(accepted.kind === "available" && accepted.coordinates.semanticRevision)
})

it("distinguishes surface values but canonicalizes record key order", () => {
  const session = createSession()
  const get = (inputSchema: unknown, maxOutputTokens = 10) => captureContextSnapshot(session, { ownerSessionId: "owner", surface: { systemPrompt: "system", tools: [{ name: "probe", description: "probe", inputSchema }], maxOutputTokens } })
  const a = get({ a: 1, b: 2 }), b = get({ b: 2, a: 1 }), c = get({ a: 1, b: 2 }, 20)
  expect(a.kind).toBe("captured"); expect(b.kind).toBe("captured"); expect(c.kind).toBe("captured")
  if (a.kind !== "captured" || b.kind !== "captured" || c.kind !== "captured") throw Error("capture required")
  expect(a.snapshot.surfaceRevision).toMatch(/^[a-f0-9]{64}$/)
  expect(b.snapshot.surfaceRevision).toBe(a.snapshot.surfaceRevision)
  expect(c.snapshot.surfaceRevision).not.toBe(a.snapshot.surfaceRevision)
})

it("keeps accepted pending dispatch evidence outside model-input semantic identity", () => {
  const session = createSession()
  append(session, { type: "conversation/semantics", version: 1, mode: "accepted-exchange-v1" })
  append(session, { type: "step/start", actionId: "a", attemptId: "attempt-a" })
  append(session, { type: "tool/call", callId: "pending", name: "probe", args: {} })
  append(session, { type: "assistant/message", text: "calling" })
  append(session, { type: "model/exchange-accepted", version: 1, exchangeId: "accepted", actionId: "a", attemptId: "attempt-a", stepStartSeq: 1, assistantSeq: 3, callSeqs: [2] })
  const before = readContextCoordinates(session, { ownerSessionId: "owner" })
  append(session, { type: "tool/dispatch", callId: "pending", eventSeq: 2 })
  const after = readContextCoordinates(session, { ownerSessionId: "owner" })
  if (before.kind !== "available" || after.kind !== "available") throw Error("coordinates required")
  expect(after.coordinates.semanticRevision).toBe(before.coordinates.semanticRevision)
  expect(after.coordinates.protectionRevision).not.toBe(before.coordinates.protectionRevision)
})
