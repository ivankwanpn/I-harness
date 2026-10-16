import { describe, expect, it, vi } from "vitest"
import * as session from "../src/index.ts"
import type { SessionEvent } from "../src/index.ts"

const fixture = (): SessionEvent[] => [
  { type: "conversation/semantics", version: 1, mode: "accepted-exchange-v1", seq: 0 },
  { type: "step/start", actionId: "a", attemptId: "p", seq: 1 },
  { type: "tool/call", callId: "c", name: "read", args: { path: "x" }, seq: 2 },
  { type: "assistant/message", text: "reading", seq: 3 },
  { type: "model/exchange-accepted", version: 1, exchangeId: "e", actionId: "a", attemptId: "p", stepStartSeq: 1, assistantSeq: 3, callSeqs: [2], seq: 4 },
] as SessionEvent[]

describe("durable exchange acceptance", () => {
  it("validates explicit references across staged batches atomically", () => {
    expect(typeof session.validateConversationHistory).toBe("function")
    const events = fixture()
    expect(() => session.validateConversationHistory(events, 3)).not.toThrow()
    const index = session.createConversationValidationIndex(events.slice(0, 4))
    expect(() => index.stage([{ ...events[4], assistantSeq: 2 } as SessionEvent])).toThrow()
    expect(index.eventCount).toBe(4)
    index.stage(events.slice(4)).commit()
    expect(index.eventCount).toBe(5)
    expect(() => index.stage(events.slice(4))).toThrow()
  })
  it("requires acceptance after a fence even when repair supplies results", () => {
    const events = fixture().slice(0, 4)
    events.push({ type: "tool/result", callId: "c", name: "read", output: "ok", seq: 4 }, { type: "step/end", seq: 5 })
    expect(session.deriveMessages({ formatVersion: 3, events })).toEqual([])
    const accepted = [...fixture(), { type: "tool/result", callId: "c", name: "read", output: "ok", seq: 5 }, { type: "step/end", seq: 6 }] as SessionEvent[]
    expect(session.deriveMessages({ formatVersion: 3, events: accepted })).toEqual([
      { role: "assistant", content: "reading", toolCalls: [{ id: "c", name: "read", args: { path: "x" } }] },
      { role: "tool", toolCallId: "c", content: '"ok"' },
    ])
    expect(session.projectConversation({ formatVersion: 3, events: accepted }).items[0]?.exchange?.acceptance).toBe("explicit")
  })
  it("retains accepted unresolved metadata and post-acceptance failures", () => {
    const events = [...fixture(), { type: "step/failed", seq: 5 }] as SessionEvent[]
    const projection = session.projectConversation({ formatVersion: 3, events })
    expect(projection.items[0]?.exchange).toMatchObject({ id: "e", acceptance: "explicit", state: "unresolved" })
    expect(session.renderConversation(projection)).toEqual([])
  })
  it.each([
    { assistantSeq: 2 }, { assistantSeq: 9 }, { stepStartSeq: 0 }, { callSeqs: [2, 2] },
    { callSeqs: [3] }, { actionId: "different" }, { attemptId: "different" }, { extra: true },
  ])("rejects malformed acceptance %j", patch => {
    expect(typeof session.validateConversationHistory).toBe("function")
    const events = fixture(); events[4] = { ...events[4], ...patch } as SessionEvent
    expect(() => session.validateConversationHistory(events, 3)).toThrow()
  })
  it("fences fields by format and preserves format2 context support", () => {
    expect(() => session.validateConversationHistory(fixture(), 2)).toThrow()
    expect(() => session.fromJSONL('{"formatVersion":3}\n')).not.toThrow()
    expect(() => session.fromJSONL('{"formatVersion":6}\n')).toThrow()
  })
  it("does not promote an inherited human admission into child-local authority", () => {
    const events: SessionEvent[] = [
      { type: "agent/input/admitted", version: 1, inputId: "u", text: "request", delivery: "queue", intent: "user", provenance: { kind: "human", authority: "request", scope: "turn", producer: "cli.prompt" }, seq: 0 },
      { type: "conversation/semantics", version: 1, mode: "accepted-exchange-v1", seq: 1 },
      { type: "user/message", text: "request", input: { inputId: "u", intent: "user" }, seq: 2 },
    ]
    expect(session.projectConversation({ formatVersion: 3, events, header: { parentSession: "parent", seedLength: 1 } }).items[0]?.provenance).toMatchObject({ kind: "inherited", authority: "observation", originSessionId: "parent" })
  })
  it("keeps fenced observations hidden when rewind or reset hides the fence", () => {
    const events: SessionEvent[] = [...fixture().slice(0, 4), { type: "compaction/reset", removedSeqs: [0], seq: 4 }, { type: "tool/result", callId: "c", name: "read", output: "repair", seq: 5 }, { type: "step/end", seq: 6 }]
    expect(session.deriveMessages({ formatVersion: 3, events })).toEqual([])
  })
  it("refuses failure before acceptance and preserves staged atomicity", () => {
    const events = fixture(); events.splice(4, 0, { type: "step/failed", seq: 4 }); events[5] = { ...events[5], seq: 5 } as SessionEvent
    expect(() => session.validateConversationHistory(events, 3)).toThrow()
    const index = session.createConversationValidationIndex()
    expect(() => index.stage(events)).toThrow()
    expect(index.eventCount).toBe(0)
  })
  it("commits appended metadata before an observer throws and rechecks actual reference kinds", () => {
    let throwing = false
    const live = session.createSession(() => { if (throwing) throw new Error("observer") })
    for (const event of fixture().slice(0, 4)) session.append(live, event)
    throwing = true
    expect(() => session.append(live, fixture()[4]!)).toThrow("observer")
    throwing = false
    session.append(live, { type: "tool/dispatch", callId: "c", eventSeq: 2 })
    expect(live.events).toHaveLength(6)
    const changed = session.createSession()
    for (const event of fixture().slice(0, 4)) session.append(changed, event)
    changed.events[3] = { type: "assistant/chunk", text: "mutated", seq: 3 }
    expect(() => session.append(changed, fixture()[4]!)).toThrow()
  })
  it("does not infer a stepless exchange after the fence", () => {
    const events: SessionEvent[] = [fixture()[0]!, { type: "assistant/message", text: "unaccepted", seq: 1 }]
    expect(session.deriveMessages({ formatVersion: 3, events })).toEqual([])
    expect(session.projectConversation({ formatVersion: 3, events }).items.every(item => !item.exchange)).toBe(true)
  })
  it("retains exact signed native sidecars and reverse result completion", () => {
    const events: SessionEvent[] = [fixture()[0]!, fixture()[1]!, fixture()[2]!,
      { type: "tool/call", callId: "d", name: "list", args: {}, seq: 3 },
      { type: "assistant/message", text: "", thinkingBlocks: [{ type: "thinking", thinking: "opaque", signature: "signed" }], seq: 4 },
      { ...fixture()[4], assistantSeq: 4, callSeqs: [2, 3], seq: 5 } as SessionEvent,
      { type: "tool/result", callId: "d", name: "list", output: "D", seq: 6 },
      { type: "tool/result", callId: "c", name: "read", output: "C", seq: 7 }, { type: "step/end", seq: 8 },
    ]
    expect(session.deriveMessages({ formatVersion: 3, events })).toEqual([
      { role: "assistant", content: "", toolCalls: [{ id: "c", name: "read", args: { path: "x" } }, { id: "d", name: "list", args: {} }], thinkingBlocks: [{ type: "thinking", thinking: "opaque", signature: "signed" }] },
      { role: "tool", toolCallId: "d", content: '"D"' }, { role: "tool", toolCallId: "c", content: '"C"' },
    ])
  })
  it("indexes a large prefix once and visits only each proposed suffix", () => {
    let visits = 0
    function observed(events: SessionEvent[]): SessionEvent[] {
      return new Proxy(events, { get(target, key, receiver) {
        if (key === "entries") return function* () { for (let index = 0; index < target.length; index++) { visits++; yield [index, target[index]] as const } }
        return Reflect.get(target, key, receiver)
      } })
    }
    const prefix = Array.from({ length: 20000 }, (_, seq): SessionEvent => ({ type: "assistant/chunk", text: "large opaque prompt payload", seq }))
    const index = session.createConversationValidationIndex(observed(prefix))
    expect(visits).toBe(20000)
    for (let seq = 20000; seq < 21000; seq++) index.stage(observed([{ type: "assistant/chunk", text: "new", seq }])).commit()
    expect(visits).toBe(21000); expect(index.eventCount).toBe(21000)
  })
  it("looks up each accepted call once in the staged and committed metadata layers", () => {
    const prefix = fixture().slice(0, 3)
    for (let seq = 3; seq < 1003; seq++) prefix.push({ type: "tool/call", callId: `c${seq}`, name: "read", args: { opaque: "large" }, seq })
    prefix.push({ type: "assistant/message", text: "", seq: 1003 })
    const index = session.createConversationValidationIndex(prefix)
    const callSeqs = Array.from({ length: 1001 }, (_, index) => index + 2)
    const get = vi.spyOn(Map.prototype, "get")
    index.stage([{ ...fixture()[4], assistantSeq: 1003, callSeqs, seq: 1004 } as SessionEvent]).commit()
    const calls = get.mock.calls.map(([key]) => key)
    get.mockRestore()
    for (const seq of callSeqs) expect(calls.filter(key => key === seq)).toHaveLength(2)
  })
  it("rejects safe but numerically backward references within the same physical step", () => {
    const events = fixture()
    events[1] = { ...events[1], seq: 10 } as SessionEvent
    events[4] = { ...events[4], stepStartSeq: 10, seq: 20 } as SessionEvent
    expect(() => session.validateConversationHistory(events, 3)).toThrow()
  })
  it("separates an optional append envelope from complete-prefix address validation", () => {
    const { seq: _seq, ...event } = fixture()[0]!
    expect(() => session.validateConversationEventShape(event as SessionEvent, 3)).not.toThrow()
    expect(() => session.validateConversationHistory([event as SessionEvent], 3)).toThrow()
  })
  it("rechecks an accepted call's actual durable identity before a new dispatch", () => {
    const live = session.createSession()
    for (const event of fixture()) session.append(live, event)
    live.events[2] = { type: "tool/call", callId: "changed", name: "read", args: {}, seq: 2 }
    expect(() => session.append(live, { type: "tool/dispatch", callId: "c", eventSeq: 2 })).toThrow()
  })
  it.each([
    { kind: "human", authority: "observation", scope: "turn", producer: "bad" },
    { kind: "plugin", authority: "request", scope: "turn", producer: "bad" },
    { kind: "unknown", authority: "unknown", scope: "turn", producer: "" },
    { kind: "human", authority: "request", scope: "turn", producer: "x".repeat(257) },
    { kind: "inherited", authority: "observation", scope: "turn", producer: "seed", extra: true },
  ])("rejects unsupported provenance shapes %j", provenance => {
    expect(() => session.validateConversationEventShape({ type: "user/message", text: "unchanged", provenance } as SessionEvent, 3)).toThrow()
  })
  it.each([false, true])("uses the admission's own semantics region (fenced admission=%s)", fenced => {
    const admission: SessionEvent = { type: "agent/input/admitted", version: 1, inputId: "u", text: "request", intent: "user", delivery: "queue" }
    const events = (fenced ? [fixture()[0]!, admission] : [admission, fixture()[0]!]).map((event, seq) => ({ ...event, seq }))
    events.push({ type: "user/message", text: "request", input: { inputId: "u", intent: "user" }, seq: 2 })
    expect(session.projectConversation({ formatVersion: 3, events }).items[0]?.provenance.authority).toBe(fenced ? "unknown" : "request")
  })
})
