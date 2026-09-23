import { describe, expect, it } from "vitest"
import { createSession, append, deriveMessages, deriveMessagesUpTo, type LLMMessage } from "../src/index.ts"

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

  // M78: a prune marker is CONTENT-ADDRESSED — its map is keyed by tool call id
  // and the substitute is a property of that old output, so `deriveMessagesUpTo`
  // applies it even when the marker's seq sits PAST the cut. That is what keeps
  // the summarizer's prefix fold showing the substitute the main fold shows (a
  // pass appends its marker at the end of the log, always past the region's last
  // shadowed seq). The exception is deliberately narrow, and both halves below
  // are the same fixture: a `compaction/summary` marker is TIME-SCOPED — its
  // `shadowedSeqs` name a region of the log — so it keeps obeying the cut and a
  // fold as of an earlier prefix is not rewritten by a later compaction.
  //
  // Measured (M78): widening the filter to every `compaction/*` marker leaves the
  // whole compaction and core-session suites green — THIS case is what reddens
  // (no summary text in the fold, and seq 0 still visible).
  it("M78: the content-addressed prune directive crosses the cut; the time-scoped markers do not", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "a" }) // seq 0
    append(s, { type: "tool/call", callId: "c1", name: "shell", args: {} }) // seq 1
    const text = JSON.stringify({ out: "x".repeat(9000) })
    append(s, { type: "tool/result", callId: "c1", name: "shell", output: { out: "x".repeat(9000) } }) // seq 2 — the cut
    append(s, { type: "compaction/prune", version: 1, pruned: [{ callId: "c1", head: text.slice(0, 4096), tail: text.slice(-1024), removedBytes: text.length - 4096 - 1024 }] }) // seq 3 — past it
    append(s, { type: "compaction/summary", text: "SUM", shadowedSeqs: [0] }) // seq 4 — past it too

    const fold = deriveMessagesUpTo(s, 2)
    // (1) the prune directive applies: the substitute, byte for byte
    const tool = fold.find((m) => m.role === "tool")
    expect(tool).toBeDefined()
    expect(tool!.content).toBe(`${text.slice(0, 4096)}\n…(pruned ${text.length - 4096 - 1024} bytes)…\n${text.slice(-1024)}`)
    // (2) the summary marker does NOT: its text is absent and its shadowed seq
    // is still on the surface
    expect(fold.map((m) => m.content)).not.toContain("SUM")
    expect(fold[0]).toEqual({ role: "user", content: "a" })
  })
})
