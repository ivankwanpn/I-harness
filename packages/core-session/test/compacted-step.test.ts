import { expect, it } from "vitest"
import { append, createSession, deriveMessages, fromJSONL, toJSONL, type ProviderContinuation } from "../src/index.ts"

const thinkingBlocks = [{ type: "thinking" as const, thinking: "Inspect both sources first.", signature: "provider-issued-signature" }]
const providerContinuation: ProviderContinuation = {
  kind: "anthropic", providerId: "route", model: "model", prefixFingerprint: "a".repeat(64),
  toolBindings: [{ id: "first", name: "read", inputJson: '{"path":"a"}' }, { id: "second", name: "read", inputJson: '{"path":"b"}' }],
}

it.each([false, true])("keeps a tool response together when compaction shadows its open step (reload=%s)", reload => {
  const session = createSession()
  append(session, { type: "user/message", text: "original task" })
  append(session, { type: "step/start" })
  append(session, { type: "compaction/summary", text: "Preserved objective.", shadowedSeqs: [0, 1] })
  append(session, { type: "tool/call", callId: "first", name: "read", args: { path: "a" } })
  append(session, { type: "tool/call", callId: "second", name: "read", args: { path: "b" } })
  append(session, { type: "assistant/message", text: "Checking.", thinkingBlocks, providerContinuation })
  append(session, { type: "tool/result", callId: "first", name: "read", output: "A" })
  append(session, { type: "user/message", text: "tool reminder" })
  append(session, { type: "tool/result", callId: "second", name: "read", output: "B" })
  append(session, { type: "step/end" })
  expect(deriveMessages(reload ? fromJSONL(toJSONL(session)) : session)).toEqual([
    { role: "user", content: "Preserved objective." },
    { role: "assistant", content: "Checking.", toolCalls: [{ id: "first", name: "read", args: { path: "a" } }, { id: "second", name: "read", args: { path: "b" } }], thinkingBlocks, providerContinuation },
    { role: "tool", toolCallId: "first", content: '"A"' },
    { role: "tool", toolCallId: "second", content: '"B"' },
    { role: "user", content: "tool reminder" },
  ])
})

it("suppresses failed tool output even when compaction shadows the step start and cold repair adds a result", () => {
  const session = createSession()
  append(session, { type: "step/start" })
  append(session, { type: "compaction/summary", text: "Preserved objective.", shadowedSeqs: [0] })
  append(session, { type: "tool/call", callId: "failed", name: "read", args: {} })
  append(session, { type: "assistant/message", text: "Incomplete provider response.", thinkingBlocks })
  append(session, { type: "step/failed" })
  append(session, { type: "step/end" })
  append(session, { type: "tool/result", callId: "failed", name: "read", output: "synthetic cold repair", isError: true })
  expect(deriveMessages(fromJSONL(toJSONL(session)))).toEqual([{ role: "user", content: "Preserved objective." }])
})

it("keeps a shadowed step end authoritative for assistant messages outside its tool block", () => {
  const session = createSession()
  append(session, { type: "step/start" })
  append(session, { type: "tool/call", callId: "first", name: "read", args: {} })
  append(session, { type: "tool/result", callId: "first", name: "read", output: "A" })
  append(session, { type: "step/end" })
  append(session, { type: "compaction/reset", removedSeqs: [3] })
  append(session, { type: "assistant/message", text: "Separate final answer." })
  expect(deriveMessages(session)).toEqual([
    { role: "assistant", content: "", toolCalls: [{ id: "first", name: "read", args: {} }] },
    { role: "tool", toolCallId: "first", content: '"A"' },
    { role: "assistant", content: "Separate final answer." },
  ])
})

it("does not restore step state from an abandoned rewind branch", () => {
  const session = createSession()
  append(session, { type: "user/message", text: "legacy task" })
  append(session, { type: "tool/call", callId: "first", name: "read", args: {} })
  append(session, { type: "tool/result", callId: "first", name: "read", output: "A" })
  append(session, { type: "step/start" })
  append(session, { type: "rewind/point", version: 1, targetTurn: 1, anchorSeq: 3, mode: "conversation", fileOps: [] })
  append(session, { type: "assistant/message", text: "Separate final answer." })
  expect(deriveMessages(session)).toEqual([
    { role: "user", content: "legacy task" },
    { role: "assistant", content: "", toolCalls: [{ id: "first", name: "read", args: {} }] },
    { role: "tool", toolCallId: "first", content: '"A"' },
    { role: "assistant", content: "Separate final answer." },
  ])
})
