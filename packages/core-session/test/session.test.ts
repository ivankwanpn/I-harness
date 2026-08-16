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
    append(s, { type: "tool/call", name: "read", args: {} })
    append(s, { type: "assistant/chunk", text: "hel" })
    append(s, { type: "assistant/chunk", text: "lo" })
    append(s, { type: "assistant/message", text: "done" })
    const msgs = deriveMessages(s)
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(msgs[1]!.content).toBe("done")
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
