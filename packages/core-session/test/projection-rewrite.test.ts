import { describe, expect, it } from "vitest"
import { append, createSession, deriveProjectionRewrite } from "../src/index.ts"

// M5 / D3. The one cell all four references leave empty: none of them treats
// "the prefix was rewritten" as a fact it can see for itself. codex, grok and
// opencode say nothing; cc-custom can only be TOLD via notifyCompaction().
//
// IH can DERIVE it, because the log is append-only and a rewrite happens only
// through a shadow marker. deriveMessages already collects the shadowed seqs —
// this only has to say WHICH marker did it.
//
// It reports the MARKER COUNT, not a boolean, and that is the whole design:
// after one compaction the answer to "has this projection been rewritten?" is
// permanently yes, which is useless. What breaks a prefix is a marker that
// arrived since the previous request.

describe("deriveProjectionRewrite (M5/D3)", () => {
  it("a session nobody rewrote reports no markers and no cause", () => {
    const s = createSession()
    append(s, { type: "turn/start" })
    append(s, { type: "user/message", text: "hello" })
    expect(deriveProjectionRewrite(s)).toEqual({ markers: 0, hiddenSeqs: 0 })
  })

  it("names the cause for each of the three markers that share the shadow mechanism", () => {
    const s = createSession()
    append(s, { type: "turn/start" })
    append(s, { type: "user/message", text: "one" })
    append(s, { type: "assistant/message", text: "two" })

    // 1. compaction with a summary
    append(s, { type: "compaction/summary", text: "summary", shadowedSeqs: [1, 2] })
    expect(deriveProjectionRewrite(s)).toMatchObject({ markers: 1, lastCause: "compaction/summary", hiddenSeqs: 2 })

    // 2. a pure reset window (no summary) — same shadow mechanism, different cause
    append(s, { type: "compaction/reset", removedSeqs: [3] })
    expect(deriveProjectionRewrite(s)).toMatchObject({ markers: 2, lastCause: "compaction/reset", hiddenSeqs: 3 })

    // 3. a rewind cut
    append(s, { type: "rewind/point", version: 1, targetTurn: 1, anchorSeq: 4, mode: "conversation", fileOps: [], seq: 6 })
    expect(deriveProjectionRewrite(s)).toMatchObject({ markers: 3, lastCause: "rewind" })
  })

  it("counts markers, so a steady state after a compaction is not mistaken for a new break", () => {
    // The failure this pins: a boolean "was this rewritten?" would report true
    // forever after the first compaction, and every later request would look
    // like a break. The consumer compares counts; equal counts mean no NEW break.
    const s = createSession()
    append(s, { type: "turn/start" })
    append(s, { type: "user/message", text: "one" })
    append(s, { type: "compaction/summary", text: "s", shadowedSeqs: [1, 2] })
    const after = deriveProjectionRewrite(s).markers
    append(s, { type: "assistant/message", text: "three" })
    expect(deriveProjectionRewrite(s).markers).toBe(after)
  })
})
