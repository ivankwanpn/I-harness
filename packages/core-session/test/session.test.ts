import { describe, expect, it } from "vitest"
import { createSession, append, deriveMessages, toJSONL, fromJSONL, assertVersion } from "../src/index.ts"
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
})

describe("append validation", () => {
  it("rejects a non-log-source message at the seam (audit F01-3)", () => {
    const s = createSession()
    // model-visible ⟺ logged: every model message must come from the log
    expect(() => append(s, { type: "assistant/message", text: "external", source: "non-log" } as SessionEvent)).toThrow(/log/i)
  })
})
