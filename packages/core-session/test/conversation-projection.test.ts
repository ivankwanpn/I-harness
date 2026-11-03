import { deriveMessagesUpTo } from '../src/projection/messages.ts'
import { describe, expect, it } from "vitest"
import {
  append, createSession, deriveMessages, fromJSONL, toJSONL,
  projectConversation, renderConversation,
  type Session, type SessionEvent, type ProviderContinuation,
} from "../src/index.ts"

function log(...events: SessionEvent[]): Session {
  const session = createSession()
  for (const event of events) append(session, event)
  return session
}

const call = (callId = "a"): SessionEvent => ({ type: "tool/call", callId, name: "read", args: { path: callId } })
const result = (callId = "a"): SessionEvent => ({ type: "tool/result", callId, name: "read", output: callId.toUpperCase() })
const continuation: ProviderContinuation = {
  kind: "openai-responses", model: "fixture", reasoningItems: [{ type: "reasoning", encrypted_content: "opaque" }],
  outputOrder: [{ kind: "tool", index: 0 }, { kind: "text", text: "Checking." }, { kind: "tool", index: 1 }],
}

describe("semantic conversation projection", () => {
  it('exposes only physical unit DTOs through the actual owner source factory', () => {
    const session = log({ type: 'turn/start' }, { type: 'step/start' }, { type: 'user/message', text: 'H' },
      { type: 'assistant/message', text: 'E' }, { type: 'step/end' }, { type: 'turn/end' })
    const raw = JSON.stringify(session)
    for (const owner of ['owner-A', 'owner-B']) {
      const projection = projectConversation(session, { ownerSessionId: owner })
      expect(projection.items.map(item => item.unit)).toEqual([
        { source: { id: JSON.stringify([owner, 1, 'step']), eventIndex: 1, seq: 1, part: 'step', addressable: true }, state: 'closed' },
        { source: { id: JSON.stringify([owner, 1, 'step']), eventIndex: 1, seq: 1, part: 'step', addressable: true }, state: 'closed' },
      ])
      for (const item of projection.items) expect(Object.isFrozen(item.unit)).toBe(true)
      expect(projectConversation(session, { ownerSessionId: owner, throughSeq: 3 }).items.map(item => item.unit?.state)).toEqual(['open', 'open'])
    }
    expect(JSON.stringify(session)).toBe(raw)
    expect(projectConversation(log({ type: 'user/message', text: 'H' }, { type: 'assistant/message', text: 'E' })).items.every(item => item.unit === undefined)).toBe(true)
  })
  it('keeps a distinct image admission alongside the promoted input admission', () => {
    const image = { mediaType: 'image/png' as const, dataBase64: 'aW1hZ2U=' }
    const session = log(
      { type: 'agent/input/admitted', version: 1, inputId: 'text', text: 'H', delivery: 'queue', intent: 'user' },
      { type: 'agent/input/admitted', version: 1, inputId: 'picture', text: 'image source', delivery: 'queue', intent: 'user', images: [image] },
      { type: 'user/message', text: 'H', input: { inputId: 'text', intent: 'user' }, imageInputId: 'picture' },
    )
    expect(deriveMessages(session)).toEqual([{ role: 'user', content: [{ type: 'text', text: 'H' }, { type: 'image', image }] }])
    expect(projectConversation(session).items[0]!.sources.map(source => [source.seq, source.part])).toEqual(expect.arrayContaining([[1, 'admission'], [2, 'message']]))
  })
  it('renders a result body once when the same descriptor also supplies an image companion', () => {
    let serializations = 0
    const value = { toJSON() { serializations++; return 'lowered' } }
    const session = log(call(), { type: 'tool/result', callId: 'a', name: 'read', output: { value, images: [{ mediaType: 'image/png', dataBase64: 'aW1hZ2U=' }] } })
    const messages = deriveMessages(session)
    expect(messages.map(message => message.role)).toEqual(['assistant', 'tool', 'user'])
    expect(serializations).toBe(1)
  })
  // Removing the projector or flattening source metadata must fail these independent expectations.
  it("groups the concrete assistant, reverse results, dispatch and image sources while attributing a deferred reminder", () => {
    const image = { mediaType: "image/png" as const, dataBase64: "aW1hZ2U=" }
    const session = log(
      { type: "step/start" }, call("a"), call("b"),
      { type: "assistant/message", text: "Checking.", providerContinuation: continuation },
      { type: "tool/dispatch", callId: "a", eventSeq: 1 },
      result("b"), { type: "user/message", text: "Reminder", source: { kind: "plugin", plugin: "guard" } },
      { type: "tool/result", callId: "a", name: "read", output: { text: "A", images: [image] } },
      { type: "step/end" },
    )
    const projection = projectConversation(session, { ownerSessionId: "owner" })
    expect(projectConversation(fromJSONL(toJSONL(session)), { ownerSessionId: "owner" })).toEqual(projection)
    expect(projection.version).toBe(1)
    expect(projection.archiveEventCount).toBe(9)
    expect(projection.items.map(item => item.kind)).toEqual(["exchange", "input"])
    const exchange = projection.items[0]!
    expect(exchange.exchange).toMatchObject({ acceptance: "legacy-inferred", state: "closed", step: { eventIndex: 0, seq: 0, part: "step", addressable: true } })
    expect(exchange.exchange!.calls).toMatchObject([
      { callId: "a", name: "read", call: { eventIndex: 1, seq: 1, part: "call" }, result: { eventIndex: 7, seq: 7, part: "result" }, dispatch: { eventIndex: 4, seq: 4, part: "dispatch" }, outcome: "success" },
      { callId: "b", call: { eventIndex: 2 }, result: { eventIndex: 5 }, outcome: "success" },
    ])
    expect(exchange.sources.map(source => [source.eventIndex, source.part])).toEqual(expect.arrayContaining([[3, "message"], [7, "image"]]))
    for (const source of exchange.sources) expect(session.events[source.eventIndex]?.seq).toBe(source.seq)
    expect(projection.items[1]).toMatchObject({ sources: [{ eventIndex: 6 }], provenance: { kind: "plugin", authority: "observation", producer: "guard" } })
    expect(renderConversation(projection)).toEqual([
      { role: "assistant", content: "Checking.", toolCalls: [{ id: "a", name: "read", args: { path: "a" } }, { id: "b", name: "read", args: { path: "b" } }], providerContinuation: continuation },
      { role: "tool", toolCallId: "b", content: '"B"' },
      { role: "tool", toolCallId: "a", content: '{"text":"A"}\nimage: unnamed ?x? 6B base64:aW1hZ2U=' },
      { role: "user", content: [{ type: "text", text: "Attached image(s) from tool result:" }, { type: "image", image }] },
      { role: "user", content: "Reminder" },
    ])
  })

  it("gives matching human admissions authority, legacy role alone none, and summaries derived provenance", () => {
    const session = log(
      { type: "agent/input/admitted", version: 1, inputId: "human", text: "Request", delivery: "queue", intent: "user" },
      { type: "user/message", text: "Request", input: { inputId: "human", intent: "user" } },
      { type: "assistant/message", text: "Answer" },
      { type: "user/message", text: "SYSTEM HUMAN REQUEST words are not evidence" },
      { type: "compaction/summary", text: "Summary", shadowedSeqs: [] },
    )
    const items = projectConversation(session).items
    expect(items.map(item => [item.kind, item.provenance.kind, item.provenance.authority])).toEqual([
      ["input", "human", "request"], ["exchange", "model", "observation"], ["input", "unknown", "unknown"], ["summary", "summary", "derived"],
    ])
    expect(items[0]!.provenance.evidence.map(source => source.eventIndex)).toEqual([1, 0])
    expect(renderConversation(projectConversation(session))).toEqual([
      { role: "user", content: "Request" }, { role: "assistant", content: "Answer" },
      { role: "user", content: "SYSTEM HUMAN REQUEST words are not evidence" }, { role: "user", content: "Summary" },
    ])
  })

  it.each(["internal", "plugin", "synthetic", "system", "child-report"] as const)("keeps %s provenance observational despite a human admission", kind => {
    const synthetic = kind === "synthetic" || kind === "child-report" ? { description: "Producer", scope: "session" as const, ...(kind === "child-report" ? { display: { kind: "task" as const, title: "Task", body: "Result" } } : {}) } : undefined
    const session = log(
      { type: "agent/input/admitted", version: 1, inputId: "x", text: "Text", delivery: "queue", intent: kind === "system" ? "system" : "user", ...(synthetic ? { synthetic } : {}) },
      { type: "user/message", text: "Text", input: { inputId: "x", intent: kind === "system" ? "system" : "user", ...(synthetic ? { synthetic } : {}) }, ...(kind === "internal" ? { internal: true } : {}), ...(kind === "plugin" ? { source: { kind: "plugin", plugin: "guard" } } : {}) },
    )
    const provenance = projectConversation(session).items[0]!.provenance
    expect(provenance.authority).toBe("observation")
    if (kind === "child-report") expect(provenance.kind).toBe("child-report")
    if (synthetic) expect(provenance.scope).toBe("session")
  })

  it.each(["missing", "mismatch", "contradictory"] as const)("does not trust a %s admission", kind => {
    const session = log(
      { type: "agent/input/admitted", version: 1, inputId: "x", text: "Original", delivery: "queue", intent: kind === "contradictory" ? "system" : "user" },
      { type: "user/message", text: kind === "mismatch" ? "Different" : "Original", input: { inputId: kind === "missing" ? "absent" : "x", intent: "user" } },
    )
    const projection = projectConversation(session)
    expect(projection.items[0]!.provenance.authority).not.toBe("request")
    expect(projection.diagnostics).toContainEqual({ code: "missing-admission", sourceIds: [projection.items[0]!.sources[0]!.id] })
  })

  it("marks child seed sources inherited with owner-local coordinates without parent authority", () => {
    const session = log(
      { type: "agent/input/admitted", version: 1, inputId: "x", text: "Request", delivery: "queue", intent: "user" },
      { type: "user/message", text: "Request", input: { inputId: "x", intent: "user" } },
      { type: "user/message", text: "Local legacy" },
    )
    session.header = { parentSession: "parent", seedLength: 2 }
    const projection = projectConversation(session, { ownerSessionId: "child" })
    expect(projection.items[0]!.provenance).toMatchObject({ kind: "inherited", authority: "observation", originSessionId: "parent" })
    expect(projection.items[0]!.sources[0]).toMatchObject({ eventIndex: 1, seq: 1 })
    expect(projection.items[1]!.provenance.kind).toBe("unknown")
    expect(projection.items[0]!.id).not.toBe(projectConversation(session, { ownerSessionId: "other" }).items[0]!.id)
    // JSONL helpers encode events only; storage restores lineage separately.
    const restored = fromJSONL(toJSONL(session))
    restored.header = { ...session.header }
    expect(projectConversation(restored, { ownerSessionId: "child" })).toEqual(projection)
  })

  it("keeps an inferred stepless exchange and explicit error disposition", () => {
    const projection = projectConversation(log(call(), { type: "tool/result", callId: "a", name: "read", output: { error: "No file" }, isError: true }))
    expect(projection.items).toHaveLength(1)
    expect(projection.items[0]!.exchange).toMatchObject({ acceptance: "legacy-inferred", state: "closed", calls: [{ callId: "a", outcome: "error" }] })
    expect(projection.items[0]!.exchange!.step).toBeUndefined()
    expect(renderConversation(projection)).toEqual([
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "read", args: { path: "a" } }] },
      { role: "tool", toolCallId: "a", content: '{"error":"No file"}', isError: true },
    ])
  })

  it.each([false, true])("owns the complete stepless call/assistant/result bundle when selected (image=%s)", withImage => {
    const image = { mediaType: "image/png" as const, dataBase64: "aW1hZ2U=" }
    const session = log(call(), { type: "assistant/message", text: "Checking", providerContinuation: continuation },
      { type: "tool/result", callId: "a", name: "read", output: withImage ? { text: "A", images: [image] } : "A" })
    const projection = projectConversation(session)
    const exchange = projection.items[0]!
    const expected = [
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "read", args: { path: "a" } }] },
      { role: "assistant", content: "Checking", providerContinuation: continuation },
      { role: "tool", toolCallId: "a", content: withImage ? '{"text":"A"}\nimage: unnamed ?x? 6B base64:aW1hZ2U=' : '"A"' },
      ...(withImage ? [{ role: "user", content: [{ type: "text", text: "Attached image(s) from tool result:" }, { type: "image", image }] }] : []),
    ]
    expect(renderConversation(projection)).toEqual(expected)
    expect(exchange.exchange).toMatchObject({ state: "closed", calls: [{ callId: "a", call: { eventIndex: 0 }, result: { eventIndex: 2 }, outcome: "success" }] })
    expect(exchange.sources.map(source => [source.eventIndex, source.part])).toEqual(expect.arrayContaining([[0, "call"], [1, "message"], [2, "result"], ...(withImage ? [[2, "image"]] : [])]))
    expect(renderConversation({ ...projection, items: [exchange] })).toEqual(expected)
    expect(projection.items).toHaveLength(1)
  })

  it("keeps an interleaved stepless input in position and reports its separated call bundle unresolved", () => {
    const image = { mediaType: "image/png" as const, dataBase64: "aW1hZ2U=" }
    const projection = projectConversation(log(call(), { type: "assistant/message", text: "Checking" },
      { type: "user/message", text: "Interleaved", source: { kind: "plugin", plugin: "fixture" } },
      { type: "tool/result", callId: "a", name: "read", output: { images: [image] } }))
    expect(renderConversation(projection)).toEqual([
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "read", args: { path: "a" } }] },
      { role: "assistant", content: "Checking" },
      { role: "user", content: "Interleaved" },
      { role: "tool", toolCallId: "a", content: "image: unnamed ?x? 6B base64:aW1hZ2U=" },
      { role: "user", content: [{ type: "text", text: "Attached image(s) from tool result:" }, { type: "image", image }] },
    ])
    expect(projection.items[0]!.exchange).toMatchObject({ state: "unresolved", calls: [{ result: { eventIndex: 3 } }] })
    const input = projection.items.find(item => item.kind === "input")!
    expect(input).toMatchObject({ sources: [{ eventIndex: 2 }], provenance: { kind: "plugin", authority: "observation", producer: "fixture" } })
    expect(renderConversation({ ...projection, items: [input] })).toEqual([{ role: "user", content: "Interleaved" }])
    expect(projection.items.at(-1)!.kind).toBe("legacy-fragment")
  })

  it("does not turn an inherited admission into a fresh local human request", () => {
    const session = log(
      { type: "agent/input/admitted", version: 1, inputId: "parent-input", text: "Parent request", delivery: "queue", intent: "user" },
      { type: "user/message", text: "Parent request", input: { inputId: "parent-input", intent: "user" } },
    )
    session.header = { parentSession: "parent", seedLength: 1 }
    expect(projectConversation(session).items[0]!.provenance.authority).toBe("unknown")
  })

  it.each([
    { output: { code: "TOOL_OUTCOME_UNKNOWN", replay: false, error: "Recovery cannot know" }, isError: true, dispatched: false, want: "unknown" },
    { output: { code: "TOOL_OUTCOME_UNKNOWN", error: "User data" }, isError: true, dispatched: false, want: "error" },
    { output: { code: "TOOL_OUTCOME_UNKNOWN", replay: false }, isError: false, dispatched: false, want: "success" },
    { output: { code: "TOOL_ABORTED_BEFORE_DISPATCH", error: "Abort" }, isError: true, dispatched: false, want: "error" },
    { output: { code: "TOOL_ABORTED_BEFORE_DISPATCH", error: "Abort" }, isError: true, dispatched: true, want: "unknown" },
  ])("classifies only recorded error/recovery evidence: $want $output.code dispatched=$dispatched", ({ output, isError, dispatched, want }) => {
    const projection = projectConversation(log(call(), ...(dispatched ? [{ type: "tool/dispatch", callId: "a", eventSeq: 0 } as const] : []), { type: "tool/result", callId: "a", name: "read", output, ...(isError ? { isError: true } : {}) }))
    expect(projection.items[0]!.exchange!.calls[0]!.outcome).toBe(want)
    expect(renderConversation(projection).at(-1)).toEqual({ role: "tool", toolCallId: "a", content: JSON.stringify(output), ...(isError ? { isError: true } : {}) })
  })

  it("reports a closed attempt without results as unknown, retaining an empty audit bundle", () => {
    const projection = projectConversation(log({ type: "step/start" }, call(), { type: "assistant/message", text: "Unaccepted" }, { type: "step/end" }))
    expect(projection.items[0]!.exchange).toMatchObject({ state: "unresolved", calls: [{ outcome: "unknown" }] })
    expect(renderConversation(projection)).toEqual([])
  })

  it("diagnoses a shadowed call without inventing a source address on its orphan result", () => {
    const projection = projectConversation(log({ type: "step/start" }, call(), result(), { type: "step/end" }, { type: "compaction/reset", removedSeqs: [1] }))
    expect(projection.diagnostics.map(diagnostic => diagnostic.code)).toContain("partial-exchange-shadow")
    expect(projection.diagnostics.map(diagnostic => diagnostic.code)).toContain("orphan-result")
    expect(projection.items[0]).toMatchObject({ kind: "legacy-fragment", sources: [{ eventIndex: 2, part: "result" }] })
    expect(renderConversation(projection)).toEqual([{ role: "tool", toolCallId: "a", content: '"A"' }])
  })

  it("emits distinct missing/invalid/duplicate coordinate diagnostics with collision-free IDs", () => {
    const session: Session = { formatVersion: 2, events: [
      { type: "user/message", text: "Missing" }, { type: "user/message", text: "Negative", seq: -1 },
      { type: "user/message", text: "Fraction", seq: 1.5 }, { type: "user/message", text: "Duplicate A", seq: 2 },
      { type: "user/message", text: "Duplicate B", seq: 2 },
    ] }
    const projection = projectConversation(session)
    expect(projection.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["missing-source-seq", "invalid-source-seq", "invalid-source-seq", "duplicate-source-seq", "duplicate-source-seq"])
    expect(new Set(projection.items.map(item => item.id)).size).toBe(5)
    expect(projection.items.every(item => !item.sources[0]!.addressable && item.sources[0]!.seq === undefined)).toBe(true)
  })

  it("renders a selected full exchange with images, while reminders retain their own bundle", () => {
    const image = { mediaType: "image/png" as const, dataBase64: "aW1hZ2U=" }
    const projection = projectConversation(log({ type: "step/start" }, call(), { type: "assistant/message", text: "Checking" }, { type: "tool/result", callId: "a", name: "read", output: { images: [image] } }, { type: "user/message", text: "Reminder" }, { type: "step/end" }))
    const selected = { ...projection, items: [projection.items[0]!] }
    expect(renderConversation(selected).map(message => message.role)).toEqual(["assistant", "tool", "user"])
    expect(renderConversation(selected).at(-1)!.content).toEqual([{ type: "text", text: "Attached image(s) from tool result:" }, { type: "image", image }])
    expect(projection.items[1]!.sources[0]).toMatchObject({ eventIndex: 4, part: "message" })
    expect(renderConversation({ ...projection, items: [projection.items[1]!] })).toEqual([{ role: "user", content: "Reminder" }])
  })

  it.each([false, true])("retains unresolved evidence with no invented messages (dispatched=%s)", dispatched => {
    const session = log({ type: "step/start" }, call(), ...(dispatched ? [{ type: "tool/dispatch", callId: "a", eventSeq: 1 } as const] : []), { type: "assistant/message", text: "Unfinished" })
    const projection = projectConversation(session)
    expect(renderConversation(projection)).toEqual([])
    expect(projection.items[0]!.exchange).toMatchObject({ state: "open", calls: [{ outcome: dispatched ? "unknown" : "pending" }] })
    expect(projection.items[0]!.exchange!.calls[0]!.result).toBeUndefined()
  })

  it("keeps failed step evidence audit-only even with a later error repair and shadowed lifecycle", () => {
    const session = log({ type: "step/start" }, call(), { type: "assistant/message", text: "Rejected" }, { type: "step/failed" }, { type: "tool/result", callId: "a", name: "read", output: { code: "TOOL_ABORTED_BEFORE_DISPATCH", error: "not dispatched" }, isError: true }, { type: "compaction/reset", removedSeqs: [0, 3] })
    const projection = projectConversation(session)
    expect(renderConversation(projection)).toEqual([])
    expect(projection.items[0]!.exchange).toMatchObject({ state: "unresolved", calls: [{ outcome: "not-dispatched", result: { eventIndex: 4 } }] })
    expect(projection.items[0]!.messages).toEqual([])
  })

  it("does not treat an arbitrary code field as a synthetic producer", () => {
    const projection = projectConversation(log(call(), { type: "tool/result", callId: "a", name: "read", output: { code: "TOOL_ABORTED_BEFORE_DISPATCH" } }))
    expect(projection.items[0]!.exchange!.calls[0]!.outcome).toBe("success")
  })

  it("reports orphan results, duplicate call identities, and unaccepted dispatch with scalar source IDs", () => {
    const projection = projectConversation(log(result("orphan"), call("dup"), call("dup"), result("dup"), { type: "tool/dispatch", callId: "absent", eventSeq: 999 }))
    expect(projection.diagnostics.map(diagnostic => diagnostic.code)).toEqual(expect.arrayContaining(["orphan-result", "duplicate-call-id", "unaccepted-dispatch"]))
    for (const diagnostic of projection.diagnostics) expect(diagnostic.sourceIds.every(id => typeof id === "string")).toBe(true)
    expect(projection.items.flatMap(item => item.exchange?.calls ?? []).filter(c => c.callId === "dup").every(c => c.outcome === "unknown")).toBe(true)
  })

  it("renders duplicate or missing seq compatibly but never exposes an unsafe durable address", () => {
    const session: Session = { formatVersion: 2, events: [{ type: "user/message", text: "one", seq: 2 }, { type: "user/message", text: "two", seq: 2 }, { type: "user/message", text: "three" }] }
    const projection = projectConversation(session)
    expect(projection.items.map(item => item.sources[0]!.addressable)).toEqual([false, false, false])
    expect(projection.items.map(item => item.sources[0]!.seq)).toEqual([undefined, undefined, undefined])
    expect(new Set(projection.items.map(item => item.id)).size).toBe(3)
    expect(projection.diagnostics.some(diagnostic => diagnostic.code === "duplicate-source-seq")).toBe(true)
    expect(renderConversation(projection).map(message => message.content)).toEqual(["one", "two", "three"])
  })

  it("keeps the compacted step source boundary and emits partial-shadow diagnostics", () => {
    const session = log({ type: "step/start" }, { type: "compaction/summary", text: "Summary", shadowedSeqs: [0] }, call(), { type: "assistant/message", text: "Checking." }, result(), { type: "step/end" })
    const projection = projectConversation(session)
    expect(projection.items.map(item => item.kind)).toEqual(["summary", "exchange"])
    expect(projection.items[1]!.exchange!.step).toMatchObject({ eventIndex: 0 })
    expect(projection.diagnostics.map(diagnostic => diagnostic.code)).toContain("partial-exchange-shadow")
    expect(renderConversation(projection)).toEqual([{ role: "user", content: "Summary" }, { role: "assistant", content: "Checking.", toolCalls: [{ id: "a", name: "read", args: { path: "a" } }] }, { role: "tool", toolCallId: "a", content: '"A"' }])
  })

  it("excludes rewound lifecycle sources and never unshadows reset content", () => {
    const session = log({ type: "user/message", text: "Hidden" }, { type: "compaction/reset", removedSeqs: [0] }, call(), result(), { type: "step/start" }, { type: "rewind/point", version: 1, anchorSeq: 4, targetTurn: 1, mode: "conversation", fileOps: [] }, { type: "assistant/message", text: "Separate" })
    const projection = projectConversation(session)
    expect(renderConversation(projection)).toEqual([{ role: "assistant", content: "", toolCalls: [{ id: "a", name: "read", args: { path: "a" } }] }, { role: "tool", toolCallId: "a", content: '"A"' }, { role: "assistant", content: "Separate" }])
    expect(projection.items.every(item => item.exchange?.step === undefined)).toBe(true)
    expect(projection.items.flatMap(item => item.sources).some(source => source.eventIndex === 4)).toBe(false)
  })

  it("retains content-addressed prune markers across a prefix but time scopes later summaries", () => {
    const session = log(call(), result(), { type: "compaction/prune", version: 1, pruned: [{ callId: "a", head: "head", tail: "tail", removedBytes: 100 }] }, { type: "compaction/summary", text: "Later", shadowedSeqs: [0, 1] })
    const projection = projectConversation(session, { throughSeq: 1 })
    expect(projection.archiveEventCount).toBe(4)
    expect(projection.throughSeq).toBe(1)
    expect(renderConversation(projection)).toEqual([{ role: "assistant", content: "", toolCalls: [{ id: "a", name: "read", args: { path: "a" } }] }, { role: "tool", toolCallId: "a", content: "head\n…(pruned 100 bytes)…\ntail" }])
    expect(deriveMessagesUpTo(session, 1)).toEqual(renderConversation(projection))
  })

  it("owns frozen metadata and fresh render containers without mutating source archives", () => {
    const session = log(call(), { type: "assistant/message", text: "Checking", providerContinuation: continuation }, result())
    session.header = { origin: "fixture" }
    const original = toJSONL(session)
    const originalWithHeader = JSON.stringify(session)
    const projection = projectConversation(session)
    const first = renderConversation(projection)
    const second = renderConversation(projection)
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    expect(first[0]).not.toBe(second[0])
    expect(Object.isFrozen(projection)).toBe(true)
    expect(Object.isFrozen(projection.items[0]!.exchange!.calls)).toBe(true)
    expect(Object.isFrozen(projection.items[0]!.sources[0])).toBe(true)
    if (first[0]!.role !== "assistant" || second[0]!.role !== "assistant") throw new Error("assistant missing")
    first[0]!.toolCalls!.push({ id: "fake", name: "fake", args: {} })
    ;(first[0]!.toolCalls![0]!.args as { path: string }).path = "mutated"
    if (first[1]!.role !== "assistant") throw new Error("assistant missing")
    first[1]!.providerContinuation!.model = "mutated"
    expect(second[0]!.toolCalls).toHaveLength(1)
    expect(toJSONL(session)).toBe(original)
    expect(JSON.stringify(session)).toBe(originalWithHeader)
    expect(deriveMessages(session)).toEqual(renderConversation(projection))
  })
})
