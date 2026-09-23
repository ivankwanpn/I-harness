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
 * span, hiding the head it summarised. */
function secondCompactionSession(): Session {
  const s = toolSession(3)
  append(s, { type: "compaction/start" })
  append(s, { type: "compaction/summary", text: "SUMMARY-OF-HEAD", shadowedSeqs: allSeqs(s) })
  append(s, { type: "compaction/end" })
  for (let t = 3; t < 6; t++) appendTurn(s, t)
  return s
}

/** The abort-tail shape (M75 fix round 2, Open 2): a turn that ends abnormally
 * appends neither `step/end` nor `turn/end` (`core-agent/src/index.ts:478`,
 * `:486` are on the clean path only), so the next `turn/start` lands directly
 * after a `tool/result` — with the `tool/dispatch` that always sits inside the
 * run (`core-agent/src/execute-tool-calls.ts:249-253`). An event-level walk stops
 * on the dispatch and can put a cut ON the result. */
function abortTailSession(): Session {
  const s = createSession()
  append(s, { type: "turn/start" })
  append(s, { type: "user/message", text: "q0 " + "filler ".repeat(120) })
  append(s, { type: "step/start" })
  append(s, { type: "tool/call", callId: "call_0", name: "read", args: { path: "f0.txt" } })
  append(s, { type: "tool/dispatch", callId: "call_0" })
  append(s, { type: "tool/result", callId: "call_0", name: "read", output: { content: "body ".repeat(200) } })
  append(s, { type: "turn/start" })
  append(s, { type: "user/message", text: "q1 " + "filler ".repeat(120) })
  append(s, { type: "step/start" })
  append(s, { type: "assistant/message", text: "a1 " + "filler ".repeat(120) })
  append(s, { type: "step/end" })
  append(s, { type: "turn/end" })
  return s
}

/** The M14 tool-result-images shape: a result carrying images projects a
 * synthetic `user` message INSIDE the tool block (core-session's
 * `deriveMessages`, the `tool/result` arm's `Array.isArray(images)` branch), so
 * the fold reads
 * `user, assistant(toolCalls[c1,c2]), tool(c1), user(synthetic), tool(c2)` and
 * the only user-message candidate sits with `c2` still open. */
function imageResultSession(): Session {
  const s = createSession()
  append(s, { type: "user/message", text: "q0 " + "filler ".repeat(120) })
  append(s, { type: "tool/call", callId: "c1", name: "read", args: { path: "a.png" } })
  append(s, { type: "tool/call", callId: "c2", name: "read", args: { path: "b.txt" } })
  append(s, {
    type: "tool/result",
    callId: "c1",
    name: "read",
    output: { content: "img", images: [{ mediaType: "image/png", dataBase64: "aGk=" }] },
  })
  append(s, { type: "tool/result", callId: "c2", name: "read", output: { content: "body ".repeat(200) } })
  return s
}

const allSeqs = (s: Session): number[] => s.events.map((e) => e.seq!).filter((n) => n !== undefined)

const textOf = (slice: { content: unknown }[]): string =>
  slice.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n")

/** A `tool` message whose call is not in the same piece would be an orphan. */
const orphans = (slice: { role: string; toolCalls?: { id: string }[]; toolCallId?: string }[]) => {
  const calls = new Set(slice.flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []).map((c) => c.id) : [])))
  return slice.filter((m) => m.role === "tool" && !calls.has(m.toolCallId ?? ""))
}

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

  it("M75: no slice contains an orphan tool result", () => {
    const s = toolSession(6)
    for (const slice of sliceRegion(s, allSeqs(s), 400)) {
      const first = slice[0]
      expect(orphans(slice)).toEqual([])
      expect(first).toBeDefined()
    }
  })

  // M75 ruling 10, verification (a): a cut may only fall on a `user` message, so
  // every piece after the first OPENS on one — a piece must be a legal
  // standalone request. (b): no piece opens on a `tool` message; on this fixture
  // the region's own fold starts with a user message, so the first piece does
  // too.
  it("M75: every piece after the first opens on a user message, and none on a tool message", () => {
    const s = toolSession(6)
    const pieces = sliceRegion(s, allSeqs(s), 400)
    expect(pieces.length).toBeGreaterThan(1)
    for (const [k, piece] of pieces.entries()) {
      expect(piece[0]).toBeDefined()
      if (k > 0) expect(piece[0]!.role).toBe("user")
      expect(piece[0]!.role).not.toBe("tool")
    }
  })

  // M75 ruling 11: the M14 tool-result-images shape. The synthetic image message
  // is a `user` message INSIDE an open tool block, so a cut there leaves the
  // second piece carrying `tool(c2)` with its call left behind — the
  // provider-rejected shape. The boundary the guard must NOT reject is the abort
  // tail just below, where the block is COMPLETE at the candidate.
  it("M75: the M14 tool-result-images shape — no piece carries an orphan tool result", () => {
    const s = imageResultSession()
    const whole = deriveMessagesUpTo(s, s.events.at(-1)!.seq!)
    const pieces = sliceRegion(s, allSeqs(s), 400) // a budget that forces cuts
    expect(pieces.flat()).toEqual(whole)
    for (const piece of pieces) expect(orphans(piece)).toEqual([])
    // the only candidate on the way sits with `c2` still open: the guard refuses
    // it, so the whole block stays one piece
    expect(pieces).toHaveLength(1)
  })

  // M75 ruling 10, Open 2: the abort-tail shape. The event-level walk stopped on
  // the `tool/dispatch` and could open a piece on the `tool/result`.
  it("M75: the abort-tail shape never opens a piece on a tool message", () => {
    const s = abortTailSession()
    const whole = deriveMessagesUpTo(s, s.events.at(-1)!.seq!)
    const pieces = sliceRegion(s, allSeqs(s), 400)
    expect(pieces.length).toBeGreaterThan(1)
    expect(pieces.flat()).toEqual(whole)
    for (const piece of pieces) {
      expect(piece[0]!.role).not.toBe("tool")
      expect(orphans(piece)).toEqual([])
    }
  })

  // M75 ruling 10: the exemption is STRUCTURAL — a piece containing no interior
  // cut candidate (a user message beyond its first) cannot be split at all, and
  // only such a piece may exceed the budget. At this budget every piece here is
  // splittable, so the bound is asserted for all of them.
  it("M75: the budget is a real bound wherever a piece could have been split", () => {
    const s = toolSession(6)
    const budget = 2_000
    const pieces = sliceRegion(s, allSeqs(s), budget)
    for (const piece of pieces) {
      const splittable = piece.slice(1).some((m) => m.role === "user")
      expect(splittable).toBe(true)
      if (splittable) expect(estimateContent(piece)).toBeLessThanOrEqual(budget)
    }
    expect(pieces.length).toBeGreaterThan(1)
  })

  // ... and the piece that cannot be split is emitted whole, over budget.
  it("M75: a piece that cannot be split is emitted whole and over budget", () => {
    const s = toolSession(6)
    const budget = 400
    const pieces = sliceRegion(s, allSeqs(s), budget)
    expect(pieces).toHaveLength(6) // one turn per piece, 6 turns
    for (const piece of pieces) {
      expect(piece.slice(1).some((m) => m.role === "user")).toBe(false) // no interior candidate
      expect(estimateContent(piece)).toBeGreaterThan(budget)
      expect(piece[0]!.role).toBe("user")
    }
    expect(pieces.flat()).toEqual(deriveMessagesUpTo(s, s.events.at(-1)!.seq!))
  })

  // M75 fix round (R3 / ruling 10): the second-compaction regression guard. A
  // rewrite marker inside the region hides the head — under ruling 10 the
  // elision is already inside the ONE fold the slicer walks, so the pieces tile
  // it TRIVIALLY (no shrink guard exists to fire); this stays as the guard for
  // that whole class.
  it("M75: a rewrite marker inside the region — the pieces still tile the fold it hides", () => {
    const s = secondCompactionSession()
    const whole = deriveMessagesUpTo(s, s.events.at(-1)!.seq!)
    const pieces = sliceRegion(s, allSeqs(s), 400)
    expect(pieces.flat()).toEqual(whole)
    expect(pieces).toHaveLength(4) // the summary + the three turns after it
    const texts = textOf(pieces.flat())
    for (const t of [0, 1, 2]) {
      expect(texts).not.toContain(`question ${t} `)
      expect(texts).not.toContain(`answer ${t} `)
    }
    expect(texts).toContain("SUMMARY-OF-HEAD")
  })
})
