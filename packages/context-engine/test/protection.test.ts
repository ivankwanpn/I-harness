import { expect, it } from "vitest"
import { append, createSession, fromJSONL, toJSONL } from "@i-harness/core-session"
import { captureContextSnapshot, readContextCoordinates } from "../src/index.ts"

it("protects active inputs and the open bundle while 50 closed exchanges stay eligible", () => {
  const session = createSession()
  append(session, { type: "turn/start" }); append(session, { type: "user/message", text: "exact anchor" })
  for (let i = 0; i < 50; i++) {
    append(session, { type: "step/start" }); append(session, { type: "tool/call", callId: `c${i}`, name: "probe", args: {} })
    append(session, { type: "assistant/message", text: "accepted" }); append(session, { type: "tool/result", callId: `c${i}`, name: "probe", output: "ok" }); append(session, { type: "step/end" })
  }
  append(session, { type: "step/start" }); append(session, { type: "assistant/message", text: "open" })
  append(session, { type: "user/message", text: "plugin steering", source: { kind: "plugin", plugin: "test" } })
  const result = captureContextSnapshot(session, { ownerSessionId: "owner", surface: { systemPrompt: "system", tools: [] } })
  expect(result.kind).toBe("captured")
  if (result.kind !== "captured") throw Error("capture required")
  expect(result.snapshot.protection.itemIds).toHaveLength(3)
  expect(result.snapshot.protection.itemIds).toContain('["owner",1,"message"]:input')
  expect(result.snapshot.protection.itemIds).not.toContain('["owner",3,"call"]:exchange')
  expect(readContextCoordinates(fromJSONL(toJSONL(session)), { ownerSessionId: "owner" })).toMatchObject({ kind: "available", coordinates: result.snapshot.coordinates })
})

it("pending-only changes and turn closure change protection without changing semantic text", () => {
  const session = createSession()
  append(session, { type: "turn/start" }); append(session, { type: "user/message", text: "anchor" })
  const before = readContextCoordinates(session, { ownerSessionId: "owner" })
  append(session, { type: "agent/input/admitted", version: 1, inputId: "pending", text: "next", delivery: "steer", intent: "user" })
  const pending = readContextCoordinates(session, { ownerSessionId: "owner" })
  append(session, { type: "agent/input/promoted", version: 1, inputId: "pending" })
  const promoted = captureContextSnapshot(session, { ownerSessionId: "owner", surface: { systemPrompt: "system", tools: [] } })
  expect(promoted.kind === "captured" && promoted.snapshot.protection.pendingInputIds).toEqual(["pending"])
  append(session, { type: "turn/end" })
  const ended = readContextCoordinates(session, { ownerSessionId: "owner" })
  for (const result of [before, pending, ended]) expect(result.kind).toBe("available")
  if (before.kind !== "available" || pending.kind !== "available" || ended.kind !== "available") throw Error("coordinates required")
  expect(pending.coordinates.semanticRevision).toBe(before.coordinates.semanticRevision)
  expect(pending.coordinates.protectionRevision).not.toBe(before.coordinates.protectionRevision)
  expect(ended.coordinates.semanticRevision).toBe(before.coordinates.semanticRevision)
  expect(ended.coordinates.protectionRevision).not.toBe(pending.coordinates.protectionRevision)
})

it("does not reopen compacted closed turns or inherit a parent's open lifecycle", () => {
  const session = createSession()
  append(session, { type: "turn/start" }); append(session, { type: "user/message", text: "parent" }); append(session, { type: "turn/end" })
  append(session, { type: "compaction/reset", removedSeqs: [0, 2] })
  const idle = captureContextSnapshot(session, { ownerSessionId: "owner", surface: { systemPrompt: "s", tools: [] } })
  expect(idle.kind === "captured" && idle.snapshot.protection.itemIds).toEqual([])
  const child = createSession(); child.header = { parentSession: "owner", seedLength: 2 }; child.events = session.events.slice(0, 2)
  const result = captureContextSnapshot(child, { ownerSessionId: "child", surface: { systemPrompt: "s", tools: [] } })
  expect(result.kind === "captured" && result.snapshot.protection.itemIds).toEqual([])
  expect(result.kind === "captured" && idle.kind === "captured" && result.snapshot.coordinates.semanticRevision).not.toBe(idle.kind === "captured" && idle.snapshot.coordinates.semanticRevision)
})

it("reports ambiguous lifecycle and tracks rewind/prune lineage", () => {
  const session = createSession()
  append(session, { type: "turn/start" }); append(session, { type: "turn/start" })
  expect(readContextCoordinates(session, { ownerSessionId: "owner" })).toMatchObject({ kind: "unsupported", component: "protection", code: "CONTEXT_STATE_AMBIGUOUS" })
  const clean = createSession(); append(clean, { type: "user/message", text: "old" })
  const before = readContextCoordinates(clean, { ownerSessionId: "owner" })
  append(clean, { type: "rewind/point", version: 1, targetTurn: 0, anchorSeq: 0, mode: "conversation", fileOps: [] })
  const after = readContextCoordinates(clean, { ownerSessionId: "owner" })
  expect(before.kind === "available" && after.kind === "available" && after.coordinates.branchId).not.toBe(before.kind === "available" && before.coordinates.branchId)
  expect(before.kind === "available" && after.kind === "available" && after.coordinates.contextEpoch).not.toBe(before.kind === "available" && before.coordinates.contextEpoch)
})

it("keeps unaccepted dispatch evidence in protection without promoting its audit payload", () => {
  const session = createSession()
  append(session, { type: "step/start" }); append(session, { type: "tool/call", callId: "uncertain", name: "probe", args: {} })
  const before = readContextCoordinates(session, { ownerSessionId: "owner" })
  append(session, { type: "tool/dispatch", callId: "uncertain", eventSeq: 1 })
  const result = captureContextSnapshot(session, { ownerSessionId: "owner", surface: { systemPrompt: "s", tools: [] } })
  expect(result.kind).toBe("captured")
  if (result.kind !== "captured" || before.kind !== "available") throw Error("capture required")
  expect(result.snapshot.coordinates.semanticRevision).toBe(before.coordinates.semanticRevision)
  expect(result.snapshot.coordinates.protectionRevision).not.toBe(before.coordinates.protectionRevision)
  expect(result.snapshot.protection.sourceIds).toContain('["owner",2,"dispatch"]')
  expect(result.snapshot.conversation.items.flatMap(item => item.messages)).toEqual([])
})
