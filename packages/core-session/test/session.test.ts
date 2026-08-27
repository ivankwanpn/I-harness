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
  it("M19: team/task subject+description and team/message/queued content are searchable", () => {
    expect(deriveSearchText({
      type: "team/task", version: 1, teamId: "t", seq: 1,
      task: { id: "t-1", revision: 1, subject: "Fix the thing", description: "step-by-step", status: "pending", blockedBy: [], writeScopes: [] },
    })).toBe("Fix the thing step-by-step")
    expect(deriveSearchText({
      type: "team/message/queued", version: 1, teamId: "t", seq: 2,
      message: { id: "m-1", senderId: "child-1", senderName: "helper", targetId: "t", delivery: "quiet", content: "status: done" },
    })).toBe("status: done")
  })
  it("M19: team/member and team/message/delivered stay unindexed (empty)", () => {
    expect(deriveSearchText({
      type: "team/member", version: 1, teamId: "t", seq: 3,
      member: { id: "child-1", name: "helper", description: "d", provider: "spawn", context: "fresh", phase: "active" },
    })).toBe("")
    expect(deriveSearchText({ type: "team/message/delivered", version: 1, teamId: "t", messageId: "m-1", targetId: "child-1", seq: 4 })).toBe("")
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

  it("compaction/reset (M20 pure-reset marker) round-trips and contributes no model-visible text", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hi" })
    append(s, { type: "compaction/reset", removedSeqs: [] })
    // additive event type: format version must stay 1 (no bump)
    expect(s.formatVersion).toBe(1)
    const restored = fromJSONL(toJSONL(s))
    expect(restored.events.map((e) => e.type)).toEqual(["user/message", "compaction/reset"])
    // removedSeqs survives persistence (recovery replays the log ⇒ nothing lost)
    expect((restored.events[1] as unknown as { removedSeqs?: number[] }).removedSeqs).toEqual([])
    // not a model-visible role and not FTS text
    expect(deriveMessages(restored)).toEqual([{ role: "user", content: "hi" }])
    expect(deriveSearchText(restored.events[1]!)).toBe("")
  })

  it("deriveMessages shadows compaction/reset removedSeqs (fix round 1 — Ruling 4 append-only reset)", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "old 1" })
    append(s, { type: "assistant/message", text: "old reply" })
    append(s, { type: "user/message", text: "new work" })
    append(s, { type: "compaction/reset", removedSeqs: [0, 1] })
    // raw log keeps everything (durable append-only record)
    expect(s.events).toHaveLength(4)
    // ...while the derived surface excludes exactly the removed seqs
    expect(deriveMessages(s)).toEqual([{ role: "user", content: "new work" }])
  })

  it("deriveMessages treats compaction/reset with no/unknown removedSeqs as a no-op shadow", () => {
    // defensive for malformed persisted logs (persisted events bypass append validation)
    const s = createSession()
    append(s, { type: "user/message", text: "kept" })
    s.events.push({ type: "compaction/reset" } as never) // missing removedSeqs
    expect(deriveMessages(s)).toEqual([{ role: "user", content: "kept" }])
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

describe("sandbox/mode session event (M16, log-only)", () => {
  it("is accepted, model-hidden, search-text-empty, and round-trips through JSONL", () => {
    const s = createSession()
    append(s, { type: "sandbox/mode", mode: "workspace-write" })
    append(s, { type: "sandbox/mode", mode: "read-only", source: "delegation" })
    append(s, { type: "user/message", text: "hi" })
    // log-only: never in the model transcript
    const msgs = deriveMessages(s)
    expect(msgs).toEqual([{ role: "user", content: "hi" }])
    // control event → no search text
    expect(deriveSearchText(s.events[0]!)).toBe("")
    // durable and replayable: survives the JSONL round-trip with mode + source
    const restored = fromJSONL(toJSONL(s))
    expect(restored.events[0]).toMatchObject({ type: "sandbox/mode", mode: "workspace-write" })
    expect(restored.events[1]).toMatchObject({ type: "sandbox/mode", mode: "read-only", source: "delegation" })
  })
})

describe("M14 multimodal", () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

  it("projects a user/message with images into parts (text first)", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hey", images: [{ mediaType: "image/png", dataBase64: PNG }] })
    const msgs = deriveMessages(s)
    expect(msgs[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "hey" },
        { type: "image", image: { mediaType: "image/png", dataBase64: PNG } },
      ],
    })
  })

  it("keeps user/message content a plain string when no images", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hi" })
    expect(deriveMessages(s)[0]).toEqual({ role: "user", content: "hi" })
  })

  it("flushes tool-result images into a synthetic user message after the tool result", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "go" })
    append(s, { type: "tool/call", callId: "c1", name: "shot", args: {} })
    append(s, { type: "tool/result", callId: "c1", name: "shot", output: { ok: true, images: [{ mediaType: "image/png", dataBase64: PNG }] } })
    append(s, { type: "step/end" })
    const msgs = deriveMessages(s)
    const results = msgs.filter((m) => m.role === "user" || m.role === "tool")
    expect(results.some((m) => m.role === "tool" && m.content === '{"ok":true,"images":[{"mediaType":"image/png","dataBase64":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="}]}')).toBe(true)
    const synthetic = results.find((m) => m.role === "user" && Array.isArray(m.content) && m.content.length === 2)! as { content: { type: string; text?: string; image?: unknown }[] }
    expect(synthetic.content[0]).toEqual({ type: "text", text: "Attached image(s) from tool result:" })
    expect(synthetic.content[1]).toMatchObject({ type: "image", image: { mediaType: "image/png" } })
  })

  it("deriveSearchText emits an image descriptor, never base64", () => {
    const ev = { type: "user/message", text: "look", images: [{ mediaType: "image/png", dataBase64: PNG, name: "diagram.png", width: 100, height: 50 }] }
    const txt = deriveSearchText(ev as never)
    expect(txt).toContain("look")
    expect(txt).toContain("image: diagram.png 100x50 ")
    expect(txt).not.toContain(PNG.slice(10, 30))
  })

  it("append validates images at intake (mediaType, base64, count, bytes)", () => {
    const s = createSession()
    expect(() => append(s, { type: "user/message", text: "t", images: [{ mediaType: "image/bmp" as never, dataBase64: PNG }] })).toThrow(/media type/)
    expect(() => append(s, { type: "user/message", text: "t", images: [{ mediaType: "image/png", dataBase64: "not!base64!" }] })).toThrow(/base64/)
    const many = Array.from({ length: 21 }, () => ({ mediaType: "image/png" as const, dataBase64: PNG }))
    expect(() => append(s, { type: "user/message", text: "t", images: many })).toThrow(/20 images/)
  })

  it("append applies the same image hardcaps to tool/result output.images", () => {
    const s = createSession()
    expect(() => append(s, { type: "tool/result", callId: "c1", name: "shot", output: { ok: true, images: [{ mediaType: "image/bmp" as never, dataBase64: PNG }] } })).toThrow(/media type/)
    const many = Array.from({ length: 21 }, () => ({ mediaType: "image/png" as const, dataBase64: PNG }))
    expect(() => append(s, { type: "tool/result", callId: "c2", name: "shot", output: { ok: true, images: many } })).toThrow(/20 images/)
  })

  it("deriveSearchText never emits tool/result base64, descriptor line present", () => {
    const ev = { type: "tool/result", callId: "c1", name: "shot", output: { ok: true, images: [{ mediaType: "image/png", dataBase64: PNG, name: "shot.png", width: 10, height: 10 }] } }
    const txt = deriveSearchText(ev as never)
    expect(txt).toContain('{"ok":true}')
    expect(txt).toContain("image: shot.png 10x10 ")
    expect(txt).not.toContain(PNG.slice(10, 30))
    expect(txt).not.toContain(PNG)
  })

  it("deriveSearchText stringifies array-shaped tool output as-is (I1)", () => {
    expect(deriveSearchText({ type: "tool/result", callId: "c", name: "t", output: [1, 2] })).toBe("[1,2]")
    // array items are opaque to image extraction — images inside an array
    // stay inside the stringified array, no descriptor is extracted
    expect(deriveSearchText({ type: "tool/result", callId: "c", name: "t", output: [{ mediaType: "image/png", dataBase64: PNG }] })).toBe(`[{"mediaType":"image/png","dataBase64":"${PNG}"}]`)
  })

  it("deriveMessages tolerates a truthy non-array output.images (I2, malformed persisted event)", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "go" })
    append(s, { type: "tool/call", callId: "c1", name: "shot", args: {} })
    // bypass append validation, simulating a persisted log that resume merged
    // via events.push (or fromJSONL, which does not validate)
    s.events.push({ type: "tool/result", callId: "c1", name: "shot", output: { images: "not-an-array" }, seq: 2 })
    const msgs = deriveMessages(s)
    expect(msgs).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shot", args: {} }] },
      { role: "tool", toolCallId: "c1", content: '{"images":"not-an-array"}' },
    ])
    // deriveSearchText likewise stays pure data (no throw; the images key is
    // stripped as usual and no descriptor is tacked on)
    expect(deriveSearchText(s.events[2]!)).toBe("{}")
  })
})
