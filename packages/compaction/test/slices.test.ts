import { describe, expect, it } from "vitest"
import { append, createSession, deriveMessagesUpTo, type Session } from "@i-harness/core-session"
import { estimateContent } from "@i-harness/token-meter"
import { sliceRegion } from "../src/slices.ts"

/** A session of `turns` turns, each with one user message and one read call. */
function toolSession(turns: number): Session {
  const s = createSession()
  for (let t = 0; t < turns; t++) {
    append(s, { type: "turn/start" })
    append(s, { type: "user/message", text: `question ${t} ` + "filler ".repeat(120) })
    append(s, { type: "tool/call", callId: `call_${t}`, name: "read", args: { path: `f${t}.txt` } })
    append(s, { type: "tool/result", callId: `call_${t}`, name: "read", output: { content: "body ".repeat(200) } })
    append(s, { type: "assistant/message", text: `answer ${t} ` + "filler ".repeat(120) })
    append(s, { type: "turn/end" })
  }
  return s
}

const allSeqs = (s: Session): number[] => s.events.map((e) => e.seq!).filter((n) => n !== undefined)

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

  it("M75: the budget is a real bound — every slice fits it (unless a single block cannot)", () => {
    const s = toolSession(6)
    const budget = 400
    for (const slice of sliceRegion(s, allSeqs(s), budget)) {
      // a slice may exceed the budget only when it is a single block (one turn)
      const oneTurn = slice.filter((m) => m.role === "user").length <= 1
      if (!oneTurn) expect(estimateContent(slice)).toBeLessThanOrEqual(budget)
    }
  })
})
