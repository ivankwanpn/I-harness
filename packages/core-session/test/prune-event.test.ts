import { describe, expect, it } from "vitest"
import { createSession, append, deriveMessages, type LLMMessage } from "../src/index.ts"

// M33: model-free prune pass — `compaction/prune` shadow projection. The raw
// log is NEVER rewritten; deriveMessages substitutes the pruned tool/result
// payload on the MODEL surface only (append-only iron rule).
describe("compaction/prune shadow projection", () => {
  it("deriveMessages substitutes head/…(pruned N bytes)…/tail for a pruned callId", () => {
    const s = createSession()
    const text = JSON.stringify({ out: "x".repeat(9000) })
    append(s, { type: "tool/call", callId: "c1", name: "shell", args: {} })
    append(s, { type: "tool/result", callId: "c1", name: "shell", output: { out: "x".repeat(9000) } })
    append(s, { type: "compaction/prune", version: 1, pruned: [{ callId: "c1", head: text.slice(0, 4096), tail: text.slice(-1024), removedBytes: text.length - 4096 - 1024 }] })
    const tool = deriveMessages(s).find((m) => m.role === "tool")
    expect(tool).toBeDefined()
    expect(tool!.content).toBe(`${text.slice(0, 4096)}\n…(pruned ${text.length - 4096 - 1024} bytes)…\n${text.slice(-1024)}`)
  })

  it("un-pruned results keep the exact pre-M33 stringified projection", () => {
    const s = createSession()
    append(s, { type: "tool/call", callId: "c1", name: "shell", args: { a: 1 } })
    append(s, { type: "tool/result", callId: "c1", name: "shell", output: { out: "small" } })
    append(s, { type: "compaction/prune", version: 1, pruned: [{ callId: "c2", head: "h", tail: "t", removedBytes: 1 }] })
    const msgs = deriveMessages(s)
    expect(msgs).toEqual([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", args: { a: 1 } }] },
      { role: "tool", toolCallId: "c1", content: '{"out":"small"}' },
    ])
  })

  it("latest prune event wins per callId (later prune overrides earlier)", () => {
    const s = createSession()
    append(s, { type: "tool/call", callId: "c1", name: "shell", args: {} })
    append(s, { type: "tool/result", callId: "c1", name: "shell", output: { out: "x".repeat(9000) } })
    append(s, { type: "compaction/prune", version: 1, pruned: [{ callId: "c1", head: "OLD", tail: "OLD2", removedBytes: 10 }] })
    append(s, { type: "compaction/prune", version: 1, pruned: [{ callId: "c1", head: "NEW", tail: "NEW2", removedBytes: 20 }] })
    expect(deriveMessages(s).find((m) => m.role === "tool")).toEqual({
      role: "tool",
      toolCallId: "c1",
      content: "NEW\n…(pruned 20 bytes)…\nNEW2",
    })
  })

  it("prune never shadows an event: the full log stays, only the projection shrinks", () => {
    const s = createSession()
    append(s, { type: "tool/call", callId: "c1", name: "shell", args: {} })
    append(s, { type: "tool/result", callId: "c1", name: "shell", output: { out: "x".repeat(9000) } })
    append(s, { type: "compaction/prune", version: 1, pruned: [{ callId: "c1", head: "h", tail: "t", removedBytes: 9000 }] })
    // append-only invariant: every raw event is still in the log
    expect(s.events.map((e) => e.type)).toEqual(["tool/call", "tool/result", "compaction/prune"])
    expect(s.events[1]!.type === "tool/result").toBe(true)
  })

  it("a pruned result that an old compaction/summary already shadowed stays hidden (shadow wins)", () => {
    const s = createSession()
    append(s, { type: "tool/call", callId: "c1", name: "shell", args: {} })
    append(s, { type: "tool/result", callId: "c1", name: "shell", output: { out: "x".repeat(9000) } })
    append(s, { type: "compaction/summary", text: "S", shadowedSeqs: [0, 1] })
    append(s, { type: "compaction/prune", version: 1, pruned: [{ callId: "c1", head: "h", tail: "t", removedBytes: 9000 }] })
    const roleMsg = deriveMessages(s).find((m) => m.role === "tool")
    expect(roleMsg).toBeUndefined() // shadowed region is not on the surface at all
    const contentMsgs = deriveMessages(s)
    expect(contentMsgs.map((m) => (m as LLMMessage).content)).toContain("S")
  })

  it("prune marker is never model-visible itself (default projection branch)", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hi" })
    append(s, { type: "compaction/prune", version: 1, pruned: [] })
    const msgs = deriveMessages(s)
    expect(msgs).toEqual([{ role: "user", content: "hi" }])
  })
})
