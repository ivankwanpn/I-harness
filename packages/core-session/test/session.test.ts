import { describe, expect, it } from "vitest"
import { createSession, append, deriveMessages, toJSONL, fromJSONL, assertVersion } from "../src/index.ts"
import { deriveSearchText } from "../src/index.ts"
import type { SessionEvent } from "../src/index.ts"

describe("session log", () => {
  it("appends events in order with seq", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hi" })
    append(s, { type: "assistant/message", text: "hello" })
    expect(s.events.length).toBe(2)
    expect(s.events[0]!.seq).toBe(0)
    expect(s.events[1]!.seq).toBe(1)
  })

  it("derives model messages from the log only", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hi" })
    append(s, { type: "tool/call", callId: "call_1", name: "read", args: {} })
    append(s, { type: "assistant/chunk", text: "hel" })
    append(s, { type: "assistant/chunk", text: "lo" })
    append(s, { type: "assistant/message", text: "done" })
    const msgs = deriveMessages(s)
    // orphaned tool/call (no tool/result) folds into an assistant toolCalls message
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "assistant"])
    expect(msgs[0]).toEqual({ role: "user", content: "hi" })
    expect(msgs[1]).toEqual({ role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read", args: {} }] })
    expect(msgs[2]).toEqual({ role: "assistant", content: "done" })
  })

  it("folds tool/call + tool/result into model messages by callId", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "task" })
    append(s, { type: "tool/call", callId: "call_1", name: "read", args: { path: "a.txt" } })
    append(s, { type: "tool/result", callId: "call_1", name: "read", output: { content: "data" } })
    append(s, { type: "assistant/message", text: "done" })
    const msgs = deriveMessages(s)
    expect(msgs).toEqual([
      { role: "user", content: "task" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read", args: { path: "a.txt" } }] },
      { role: "tool", toolCallId: "call_1", content: '{"content":"data"}' },
      { role: "assistant", content: "done" },
    ])
  })

  it("keeps assistant toolCalls in order across multiple calls", () => {
    const s = createSession()
    append(s, { type: "tool/call", callId: "call_1", name: "read", args: {} })
    append(s, { type: "tool/result", callId: "call_1", name: "read", output: { content: "a" } })
    append(s, { type: "tool/call", callId: "call_2", name: "write", args: {} })
    append(s, { type: "tool/result", callId: "call_2", name: "write", output: { ok: true } })
    const msgs = deriveMessages(s)
    expect(msgs[0]).toEqual({
      role: "assistant", content: "",
      toolCalls: [
        { id: "call_1", name: "read", args: {} },
        { id: "call_2", name: "write", args: {} },
      ],
    })
    expect(msgs[1]).toEqual({ role: "tool", toolCallId: "call_1", content: '{"content":"a"}' })
    expect(msgs[2]).toEqual({ role: "tool", toolCallId: "call_2", content: '{"ok":true}' })
  })

  it("ignores assistant/chunk events without buffering (chunkBuffer removed)", () => {
    const s = createSession()
    append(s, { type: "assistant/chunk", text: "hel" })
    append(s, { type: "assistant/chunk", text: "lo" })
    append(s, { type: "assistant/message", text: "done" })
    expect(deriveMessages(s)).toEqual([{ role: "assistant", content: "done" }])
  })

  it("subagent/inbox events are model-hidden (ignored by deriveMessages)", () => {
    const s = createSession()
    append(s, { type: "turn/start" })
    append(s, { type: "user/message", text: "hi" })
    append(s, { type: "subagent/inbox", messageId: "m1", message: "ping" })
    append(s, { type: "assistant/message", text: "yo" })
    append(s, { type: "turn/end" })
    expect(deriveMessages(s)).toMatchObject([
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ])
  })

  it("stores user/message.source and derives its text (content unaffected)", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "reminder", source: { kind: "plugin", plugin: "guard-repeat-tool" } })
    expect(s.events[0]).toMatchObject({
      type: "user/message",
      text: "reminder",
      source: { kind: "plugin", plugin: "guard-repeat-tool" },
    })
    const msgs = deriveMessages(s)
    expect(msgs[0]).toEqual({ role: "user", content: "reminder" })
  })

  it("round-trips user/message.source through JSONL", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "reminder", source: { kind: "plugin", plugin: "guard-repeat-tool" } })
    const restored = fromJSONL(toJSONL(s))
    expect(restored.events[0]).toMatchObject({
      text: "reminder",
      source: { kind: "plugin", plugin: "guard-repeat-tool" },
    })
    expect(deriveMessages(restored)).toEqual([{ role: "user", content: "reminder" }])
  })

  it("parses a legacy user/message without source and derives normally", () => {
    const oldLog =
      JSON.stringify({ formatVersion: 1 }) + "\n" + JSON.stringify({ type: "user/message", text: "hi" }) + "\n"
    const s = fromJSONL(oldLog)
    expect(s.events[0]).toMatchObject({ type: "user/message", text: "hi" })
    expect(s.events[0]).not.toHaveProperty("source")
    expect(deriveMessages(s)).toEqual([{ role: "user", content: "hi" }])
  })

  it("round-trips JSONL with formatVersion", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "x" })
    const text = toJSONL(s)
    const s2 = fromJSONL(text)
    expect(s2.formatVersion).toBe(1)
    expect(s2.events.length).toBe(1)
  })

  it("refuses unknown format version before decode", () => {
    const bad = JSON.stringify({ formatVersion: 99, events: [] })
    expect(() => fromJSONL(bad)).toThrow(/version/i)
  })

  it("rejects empty or whitespace-only log input with a clear error", () => {
    expect(() => fromJSONL("")).toThrow(/session log is empty/)
    expect(() => fromJSONL("   \n\t  ")).toThrow(/session log is empty/)
  })

  it("migrate-on-continue upgrades v1 (no-op in M1) and refuses higher", () => {
    const s = createSession()
    expect(assertVersion(s, 1)).toBe(1)
    expect(() => assertVersion(s, 2)).toThrow(/version/i)
  })

  it("keeps tool blocks separate across steps (per-turn folding)", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "task" })
    append(s, { type: "step/start" })
    append(s, { type: "tool/call", callId: "call_1", name: "read", args: { path: "a.txt" } })
    append(s, { type: "tool/result", callId: "call_1", name: "read", output: { content: "a" } })
    append(s, { type: "step/end" })
    append(s, { type: "step/start" })
    append(s, { type: "tool/call", callId: "call_2", name: "write", args: { path: "a.txt", text: "b" } })
    append(s, { type: "tool/result", callId: "call_2", name: "write", output: { ok: true } })
    append(s, { type: "step/end" })
    append(s, { type: "assistant/message", text: "done" })
    const msgs = deriveMessages(s)
    expect(msgs).toEqual([
      { role: "user", content: "task" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read", args: { path: "a.txt" } }] },
      { role: "tool", toolCallId: "call_1", content: '{"content":"a"}' },
      { role: "assistant", content: "", toolCalls: [{ id: "call_2", name: "write", args: { path: "a.txt", text: "b" } }] },
      { role: "tool", toolCallId: "call_2", content: '{"ok":true}' },
      { role: "assistant", content: "done" },
    ])
  })
})

describe("deriveSearchText", () => {
  it("returns the text for user/message and assistant/message", () => {
    expect(deriveSearchText({ type: "user/message", text: "hello world" })).toBe("hello world")
    expect(deriveSearchText({ type: "assistant/message", text: "reply text" })).toBe("reply text")
  })
  it("returns JSON for tool/call args and tool/result output", () => {
    expect(deriveSearchText({ type: "tool/call", callId: "c", name: "bash", args: { command: "echo hi" } })).toBe(JSON.stringify({ command: "echo hi" }))
    expect(deriveSearchText({ type: "tool/result", callId: "c", name: "bash", output: { stdout: "hi" } })).toBe(JSON.stringify({ stdout: "hi" }))
  })
  it("returns empty text for undefined tool/call args and tool/result output", () => {
    expect(deriveSearchText({ type: "tool/call", callId: "c", name: "n", args: undefined })).toBe("")
    expect(deriveSearchText({ type: "tool/result", callId: "c", name: "n", output: undefined })).toBe("")
  })
  it("returns the message for subagent/inbox", () => {
    expect(deriveSearchText({ type: "subagent/inbox", messageId: "m", message: "ping" })).toBe("ping")
  })
  it("returns empty string for control and chunk events", () => {
    expect(deriveSearchText({ type: "turn/start" })).toBe("")
    expect(deriveSearchText({ type: "step/end" })).toBe("")
    expect(deriveSearchText({ type: "assistant/chunk", text: "partial" })).toBe("")
    expect(deriveSearchText({ type: "assistant/message", text: "x", seq: 1 })).toBe("x") // seq is irrelevant
  })
})

describe("append validation", () => {
  it("rejects a non-log-source message at the seam (audit F01-3)", () => {
    const s = createSession()
    // model-visible ⟺ logged: every model message must come from the log
    expect(() => append(s, { type: "assistant/message", text: "external", source: "non-log" } as SessionEvent)).toThrow(/log/i)
  })
})

describe("session ignorable marker", () => {
  it("carries an ignorable marker through JSONL round-trip", () => {
    const session = createSession()
    // "future/thing" is not a known event type; the ignorable marker is how a
    // future writer tags events that readers may safely drop. Cast through
    // unknown because the type is intentionally outside the current union.
    const futureEvent = { type: "future/thing", payload: "x", ignorable: true } as unknown as SessionEvent
    append(session, futureEvent)
    const text = toJSONL(session)
    const restored = fromJSONL(text)
    expect(restored.events[0]!).toMatchObject({ type: "future/thing", payload: "x", ignorable: true })
  })
})

describe("session onAppend observer", () => {
  it("invokes the observer for each appended event with seq assigned", () => {
    const seen: string[] = []
    const session = createSession((ev) => { seen.push(`${ev.type}#${ev.seq}`) })
    append(session, { type: "turn/start" })
    append(session, { type: "user/message", text: "hi" })
    expect(seen).toEqual(["turn/start#0", "user/message#1"])
  })

  it("does not invoke the observer when none was provided", () => {
    const session = createSession()
    append(session, { type: "turn/start" })
    expect(session.events).toHaveLength(1)
  })
})

describe("compaction events", () => {
  it("new event types round-trip through JSONL", () => {
    const s = createSession()
    append(s, { type: "compaction/start" })
    append(s, { type: "compaction/summary", text: "summary text", shadowedSeqs: [0, 1, 2] })
    append(s, { type: "compaction/end" })
    const restored = fromJSONL(toJSONL(s))
    expect(restored.events.map((e) => e.type)).toEqual(["compaction/start", "compaction/summary", "compaction/end"])
    const summary = restored.events.find((e) => e.type === "compaction/summary") as { text: string; shadowedSeqs: number[] }
    expect(summary.text).toBe("summary text")
    expect(summary.shadowedSeqs).toEqual([0, 1, 2])
  })

  it("deriveMessages shadows the replaced seqs and renders the summary as a user message", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "old turn one" })
    append(s, { type: "assistant/message", text: "old reply" })
    append(s, { type: "user/message", text: "old turn two" })
    append(s, { type: "compaction/start" })
    append(s, { type: "compaction/summary", text: "COMPACTED HISTORY", shadowedSeqs: [0, 1, 2] })
    append(s, { type: "compaction/end" })
    append(s, { type: "user/message", text: "new work" })
    const msgs = deriveMessages(s)
    expect(msgs).toEqual([
      { role: "user", content: "COMPACTED HISTORY" },
      { role: "user", content: "new work" },
    ])
  })

  it("deriveMessages without compaction events derives identically to today", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "a" })
    append(s, { type: "assistant/message", text: "b" })
    expect(deriveMessages(s)).toEqual([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ])
  })

  it("a compaction summary never shadows a later compaction marker (disjoint sets compose)", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "turn a" })
    append(s, { type: "compaction/start" })
    append(s, { type: "compaction/summary", text: "S1", shadowedSeqs: [0] })
    append(s, { type: "compaction/end" })
    append(s, { type: "user/message", text: "turn b" })
    append(s, { type: "compaction/start" })
    append(s, { type: "compaction/summary", text: "S2", shadowedSeqs: [4] })
    append(s, { type: "compaction/end" })
    const msgs = deriveMessages(s)
    expect(msgs).toEqual([
      { role: "user", content: "S1" },
      { role: "user", content: "S2" },
    ])
  })

  it("deriveSearchText: summary → text, start/end → empty", () => {
    expect(deriveSearchText({ type: "compaction/summary", text: "s", shadowedSeqs: [] })).toBe("s")
    expect(deriveSearchText({ type: "compaction/start" })).toBe("")
    expect(deriveSearchText({ type: "compaction/end" })).toBe("")
  })
})
