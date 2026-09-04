import { describe, expect, it } from "vitest"
import { createSession, append, deriveMessages, rewindCuts, deriveSearchText, toJSONL, fromJSONL, type RewindCut } from "../src/index.ts"

// M42 (G2): conversation rewind shadow projection — `rewind/point` events hide
// the [anchorSeq, markerSeq) window on the MODEL surface only. Append-only
// iron rule: the raw log is NEVER rewritten; recovery replays full history +
// the marker, and deriveMessages narrows the projection.
describe("rewind/point shadow projection", () => {
  it("baseline: a session without rewind/point events derives exactly as pre-M42", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "task" })
    append(s, { type: "tool/call", callId: "call_1", name: "read", args: { path: "a.txt" } })
    append(s, { type: "tool/result", callId: "call_1", name: "read", output: { content: "data" } })
    append(s, { type: "assistant/message", text: "done" })
    expect(rewindCuts(s)).toEqual([])
    expect(deriveMessages(s)).toEqual([
      { role: "user", content: "task" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read", args: { path: "a.txt" } }] },
      { role: "tool", toolCallId: "call_1", content: '{"content":"data"}' },
      { role: "assistant", content: "done" },
    ])
  })

  it("baseline: compaction shadowing without rewind points is untouched by the new mechanism", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "old" })
    append(s, { type: "compaction/summary", text: "COMPACTED", shadowedSeqs: [0] })
    append(s, { type: "user/message", text: "new" })
    expect(rewindCuts(s)).toEqual([])
    expect(deriveMessages(s)).toEqual([
      { role: "user", content: "COMPACTED" },
      { role: "user", content: "new" },
    ])
  })

  it("single cut hides [anchorSeq, markerSeq); post-rewind turns are visible again", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "pre-a" })
    append(s, { type: "assistant/message", text: "pre-b" })
    append(s, { type: "user/message", text: "rewound-a" })
    append(s, { type: "assistant/message", text: "rewound-b" })
    append(s, { type: "user/message", text: "rewound-c" })
    append(s, { type: "assistant/message", text: "rewound-d" })
    append(s, { type: "rewind/point", version: 1, targetTurn: 1, anchorSeq: 2, mode: "conversation", fileOps: [] })
    append(s, { type: "user/message", text: "new-a" })
    append(s, { type: "assistant/message", text: "new-b" })
    expect(rewindCuts(s)).toEqual<RewindCut[]>([{ cutFrom: 2, markerSeq: 6 }])
    const msgs = deriveMessages(s)
    expect(msgs).toEqual([
      { role: "user", content: "pre-a" },
      { role: "assistant", content: "pre-b" },
      { role: "user", content: "new-a" },
      { role: "assistant", content: "new-b" },
    ])
    // append-only invariant: the raw log keeps every event, including the hidden era
    expect(s.events).toHaveLength(9)
    expect(s.events[7]!.type).toBe("user/message")
    // the marker itself is log-only: never a model-visible message, unindexed
    expect(deriveSearchText(s.events[6]!)).toBe("")
    expect(deriveMessages(s).find((m) => m.role === "user" && m.content === "rewound-a")).toBeUndefined()
  })

  it("two cuts compose in order (non-overlapping windows both apply; ORDER rule holds)", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "a" })
    append(s, { type: "assistant/message", text: "b" })
    append(s, { type: "user/message", text: "c1" })
    append(s, { type: "assistant/message", text: "c2" })
    append(s, { type: "user/message", text: "c3" })
    append(s, { type: "assistant/message", text: "c4" })
    append(s, { type: "rewind/point", version: 1, targetTurn: 1, anchorSeq: 2, mode: "all", fileOps: [] })
    append(s, { type: "user/message", text: "post1" })          // >= marker 6 → visible
    append(s, { type: "assistant/message", text: "post1-reply" })
    append(s, { type: "rewind/point", version: 1, targetTurn: 2, anchorSeq: 8, mode: "files", fileOps: [{ path: "a.md", op: "delete" }] })
    append(s, { type: "user/message", text: "post2" })          // >= marker 9 → visible (later cut ended at 9)
    append(s, { type: "assistant/message", text: "post2-reply" })
    expect(rewindCuts(s)).toEqual<RewindCut[]>([
      { cutFrom: 2, markerSeq: 6 },
      { cutFrom: 8, markerSeq: 9 },
    ])
    const msgs = deriveMessages(s)
    expect(msgs).toEqual([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "post1" },
      { role: "user", content: "post2" },
      { role: "assistant", content: "post2-reply" },
    ])
    // ORDER rule: post1 (seq 7 >= marker 6, outside the later cut) is included;
    // post1-reply (seq 8) IS in the later cut [8,9) → hidden. The second rewind
    // reaches back exactly one event past the first marker.
  })

  it("overlapping windows meld into one union cut (later rewind reaches into an earlier hidden era)", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "a" })      // seq 0 — before everything
    append(s, { type: "user/message", text: "b" })      // seq 1
    append(s, { type: "assistant/message", text: "b-reply" }) // seq 2
    append(s, { type: "rewind/point", version: 1, targetTurn: 1, anchorSeq: 1, mode: "conversation", fileOps: [] }) // seq 3
    append(s, { type: "user/message", text: "post1" })  // seq 4 — visible after cut 1
    append(s, { type: "assistant/message", text: "post1-reply" }) // seq 5
    append(s, { type: "rewind/point", version: 1, targetTurn: 2, anchorSeq: 2, mode: "conversation", fileOps: [] }) // seq 6 — anchor 2 < marker 3 → overlap
    append(s, { type: "user/message", text: "new" })    // seq 7
    expect(rewindCuts(s)).toEqual<RewindCut[]>([{ cutFrom: 1, markerSeq: 6 }])
    const msgs = deriveMessages(s)
    expect(msgs).toEqual([
      { role: "user", content: "a" },
      { role: "user", content: "new" },
    ])
  })

  it("a tool block entirely inside a cut window is hidden like any event", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "go" })
    append(s, { type: "tool/call", callId: "c1", name: "shell", args: { echo: "x" } })
    append(s, { type: "tool/result", callId: "c1", name: "shell", output: { out: "y" } })
    append(s, { type: "rewind/point", version: 1, targetTurn: 1, anchorSeq: 1, mode: "conversation", fileOps: [] })
    const msgs = deriveMessages(s)
    expect(msgs).toEqual([{ role: "user", content: "go" }])
  })

  it("rewind after compaction: artifact hidden by the cut, shadowedSeqs still applied, post-rewind turn visible", () => {
    const s = createSession()
    // seqs 0-29: 15 turns — visible (below the rewind anchor 30)
    for (let i = 0; i < 30; i += 2) {
      append(s, { type: "user/message", text: `u${i}` })
      append(s, { type: "assistant/message", text: `a${i}` })
    }
    // seqs 30-48: 19 continuation events — shadowed by the compaction summary
    for (let i = 30; i <= 48; i++) {
      append(s, i % 2 === 0 ? { type: "user/message", text: `u${i}` } : { type: "assistant/message", text: `a${i}` })
    }
    append(s, { type: "compaction/start" }) // seq 49
    append(s, { type: "compaction/summary", text: "COMPACTED HISTORY", shadowedSeqs: Array.from({ length: 19 }, (_, k) => 30 + k) }) // seq 50
    append(s, { type: "compaction/end" }) // seq 51
    for (let i = 52; i < 60; i++) append(s, { type: "assistant/chunk", text: `filler-${i}` }) // model-invisible filler
    append(s, { type: "rewind/point", version: 1, targetTurn: 15, anchorSeq: 30, mode: "all", fileOps: [{ path: "src/app.ts", op: "restore" }] }) // marker seq 60
    for (let i = 61; i < 70; i++) append(s, { type: "assistant/chunk", text: `post-${i}` }) // filler
    append(s, { type: "user/message", text: "post-rewind-new" }) // seq 70
    append(s, { type: "assistant/message", text: "post-rewind-reply" }) // seq 71
    expect(rewindCuts(s)).toEqual<RewindCut[]>([{ cutFrom: 30, markerSeq: 60 }])
    const msgs = deriveMessages(s)
    // events < 30 (15 turns) + post-70 turn; the compaction artifact is hidden
    expect(msgs).toHaveLength(32)
    for (let i = 0; i < 15; i++) {
      expect(msgs[i * 2]).toEqual({ role: "user", content: `u${i * 2}` })
      expect(msgs[i * 2 + 1]).toEqual({ role: "assistant", content: `a${i * 2}` })
    }
    expect(msgs[30]).toEqual({ role: "user", content: "post-rewind-new" })
    expect(msgs[31]).toEqual({ role: "assistant", content: "post-rewind-reply" })
    expect(msgs.some((m) => m.role === "user" && m.content === "COMPACTED HISTORY")).toBe(false)
    expect(msgs.some((m) => m.role === "user" && m.content === "u30")).toBe(false)
  })

  it("shadowedSeqs below a cut's anchor stay hidden (union — a rewind never un-shadows compaction)", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "a" })       // seq 0 — shadowed by compaction
    append(s, { type: "assistant/message", text: "b" })  // seq 1 — shadowed by compaction
    append(s, { type: "user/message", text: "c" })       // seq 2 — cut [2,5) hides
    append(s, { type: "assistant/message", text: "d" })  // seq 3 — cut hides
    append(s, { type: "compaction/summary", text: "S", shadowedSeqs: [0, 1] }) // seq 4 — cut hides
    append(s, { type: "rewind/point", version: 1, targetTurn: 1, anchorSeq: 2, mode: "conversation", fileOps: [] }) // seq 5
    append(s, { type: "user/message", text: "new-u" })
    append(s, { type: "assistant/message", text: "new-a" })
    const msgs = deriveMessages(s)
    expect(msgs).toEqual([
      { role: "user", content: "new-u" },
      { role: "assistant", content: "new-a" },
    ])
  })

  it("defensive: malformed rewind/point events (missing seq / empty window) contribute no cut and never throw", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "keep" })
    // malformed persisted marker without seq (fromJSONL does not validate)
    s.events.push({ type: "rewind/point", version: 1, targetTurn: 1, anchorSeq: 0, mode: "conversation", fileOps: [] } as never)
    expect(rewindCuts(s)).toEqual([])
    expect(deriveMessages(s)).toEqual([{ role: "user", content: "keep" }])
    // empty window (anchorSeq >= seq) — nothing to hide
    const s2 = createSession()
    s2.events.push({ type: "rewind/point", version: 1, targetTurn: 1, anchorSeq: 5, mode: "files", fileOps: [], seq: 2 } as never)
    expect(rewindCuts(s2)).toEqual([])
    expect(deriveMessages(s2)).toEqual([])
  })

  it("round-trips through JSONL with the payload intact and keeps format version 1", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "pre-rewind" })
    append(s, { type: "rewind/point", version: 1, targetTurn: 3, anchorSeq: 0, mode: "all", fileOps: [{ path: "a/b.txt", op: "delete" }, { path: "c.ts", op: "restore" }] })
    append(s, { type: "user/message", text: "post-rewind" })
    expect(s.formatVersion).toBe(1) // additive event type: no format bump
    const restored = fromJSONL(toJSONL(s))
    expect(restored.events[1]).toMatchObject({
      type: "rewind/point",
      version: 1,
      targetTurn: 3,
      anchorSeq: 0,
      mode: "all",
      fileOps: [
        { path: "a/b.txt", op: "delete" },
        { path: "c.ts", op: "restore" },
      ],
    })
    // every event carries its seq through the round-trip, so the cut rebuilds:
    // window [0, 1) hides the pre-rewind user/message; the post-rewind turn shows
    expect(rewindCuts(restored)).toEqual<RewindCut[]>([{ cutFrom: 0, markerSeq: 1 }])
    expect(deriveMessages(restored)).toEqual([{ role: "user", content: "post-rewind" }])
  })
})
