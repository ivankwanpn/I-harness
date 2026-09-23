import { describe, expect, it } from "vitest"
import { append, createSession, deriveMessagesUpTo, type Session } from "@i-harness/core-session"
import { estimateContent } from "@i-harness/token-meter"
import { sliceRegion } from "../src/slices.ts"

/** One turn: a user message, a read call with its result, an answer. */
function appendTurn(s: Session, t: number): void {
  append(s, { type: "turn/start" })
  append(s, { type: "user/message", text: `question ${t} ` + "filler ".repeat(120) })
  append(s, { type: "tool/call", callId: `call_${t}`, name: "read", args: { path: `f${t}.txt` } })
  append(s, { type: "tool/result", callId: `call_${t}`, name: "read", output: { content: "body ".repeat(200) } })
  append(s, { type: "assistant/message", text: `answer ${t} ` + "filler ".repeat(120) })
  append(s, { type: "turn/end" })
}

/** A session of `turns` turns, each with one user message and one read call. */
function toolSession(turns: number): Session {
  const s = createSession()
  for (let t = 0; t < turns; t++) appendTurn(s, t)
  return s
}

/** The SECOND-compaction shape: a `compaction/summary` sits INSIDE the region's
 * span, hiding the head it summarised — so the fold SHRINKS part-way across the
 * walk. */
function secondCompactionSession(): Session {
  const s = toolSession(3)
  append(s, { type: "compaction/start" })
  append(s, { type: "compaction/summary", text: "SUMMARY-OF-HEAD", shadowedSeqs: allSeqs(s) })
  append(s, { type: "compaction/end" })
  for (let t = 3; t < 6; t++) appendTurn(s, t)
  return s
}

const allSeqs = (s: Session): number[] => s.events.map((e) => e.seq!).filter((n) => n !== undefined)

const textOf = (slice: { content: unknown }[]): string =>
  slice.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n")

describe("sliceRegion", () => {
  it("M75: a budget that fits everything returns ONE slice, equal to the whole fold", () => {
    const s = toolSession(3)
    const slices = sliceRegion(s, allSeqs(s), 1_000_000)
    expect(slices).toHaveLength(1)
    expect(slices[0]).toEqual(deriveMessagesUpTo(s, s.events.at(-1)!.seq!))
  })

  it("M75: a small budget splits, and the slices together are exactly the region", () => {
    const s = toolSession(6)
    const whole = deriveMessagesUpTo(s, s.events.at(-1)!.seq!)
    const slices = sliceRegion(s, allSeqs(s), 400)
    expect(slices.length).toBeGreaterThan(1)
    // nothing dropped, nothing duplicated, order preserved
    expect(slices.flat()).toEqual(whole)
  })

  it("M75: every slice is cut at a block boundary — no slice starts with an orphan tool result", () => {
    const s = toolSession(6)
    for (const slice of sliceRegion(s, allSeqs(s), 400)) {
      const first = slice[0]
      // a `tool` message whose call is not in the same slice would be an orphan
      const calls = new Set(slice.flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []).map((c) => c.id) : [])))
      const orphans = slice.filter((m) => m.role === "tool" && !calls.has(m.toolCallId ?? ""))
      expect(orphans).toEqual([])
      expect(first).toBeDefined()
    }
  })

  // M75 fix round (R4): a budget at which EVERY slice is under it, so the
  // assertion always executes — no "single block" exemption to hide behind.
  it("M75: the budget is a real bound — every slice fits it", () => {
    const s = toolSession(6)
    const budget = 2_000
    const slices = sliceRegion(s, allSeqs(s), budget)
    for (const slice of slices) {
      expect(estimateContent(slice)).toBeLessThanOrEqual(budget)
    }
    expect(slices.length).toBeGreaterThan(1)
  })

  // M75 fix round (I2): a piece must read on its own. The fixture's block unit
  // is a turn, so every piece opens on the turn's user message; a 489-token
  // `assistant(toolCalls) + tool` piece with no user message is what this pins
  // away.
  it("M75: every slice is whole turns — each carries its own user message", () => {
    const s = toolSession(6)
    for (const slice of sliceRegion(s, allSeqs(s), 400)) {
      expect(slice.filter((m) => m.role === "user")).toHaveLength(1)
      expect(slice[0]!.role).toBe("user")
    }
  })

  // M75 fix round (R4): the exemption's real content — a block that alone
  // exceeds the budget is emitted whole, over budget, and nothing is cut to
  // force it under.
  it("M75: a single block that cannot fit is emitted whole and over budget", () => {
    const s = toolSession(6)
    const budget = 400
    const slices = sliceRegion(s, allSeqs(s), budget)
    expect(slices).toHaveLength(6) // one turn per piece, 6 turns
    for (const slice of slices) {
      expect(estimateContent(slice)).toBeGreaterThan(budget)
      expect(slice.filter((m) => m.role === "user")).toHaveLength(1)
    }
    expect(slices.flat()).toEqual(deriveMessagesUpTo(s, s.events.at(-1)!.seq!))
  })

  // M75 fix round (R3): a rewrite marker inside the region — the normal
  // second-compaction shape — makes the fold SHRINK part-way across the walk.
  // The pieces must still tile the fold the single-call path replays, and none
  // of them may carry a message that fold no longer shows.
  it("M75: a rewrite marker inside the region restarts the walk — nothing hidden comes back", () => {
    const s = secondCompactionSession()
    const whole = deriveMessagesUpTo(s, s.events.at(-1)!.seq!)
    const slices = sliceRegion(s, allSeqs(s), 400)
    expect(slices.flat()).toEqual(whole)
    expect(slices).toHaveLength(4) // the summary + the three turns after it
    const texts = textOf(slices.flat())
    for (const t of [0, 1, 2]) {
      expect(texts).not.toContain(`question ${t} `)
      expect(texts).not.toContain(`answer ${t} `)
    }
    expect(texts).toContain("SUMMARY-OF-HEAD")
  })
})
