import { describe, expect, it } from "vitest"
import { append, createSession, deriveMessages, type Session } from "@i-harness/core-session"
import { walkOffToolEvents } from "../src/region.ts"

/** M70's shipped log order: a `tool/dispatch` sits BETWEEN the call and its result. */
function dispatchSession(turns: number): Session {
  const s = createSession()
  for (let t = 0; t < turns; t++) {
    append(s, { type: "turn/start" })
    append(s, { type: "user/message", text: `question ${t}` })
    append(s, { type: "step/start" })
    append(s, { type: "tool/call", callId: `call_${t}`, name: "read", args: { path: `f${t}.txt` } })
    append(s, { type: "tool/dispatch", callId: `call_${t}` })
    append(s, { type: "tool/result", callId: `call_${t}`, name: "read", output: { content: `body ${t}` } })
    append(s, { type: "assistant/message", text: `answer ${t}` })
    append(s, { type: "step/end" })
    append(s, { type: "turn/end" })
  }
  return s
}

/** The messages the projection shows BEFORE `cut` — the tail is what a cut retains. */
function messagesBefore(s: Session, cut: number): number {
  return deriveMessages({ ...s, events: s.events.slice(0, cut) }).length
}

/** A retained tail is orphaned iff its FIRST message is a `tool` whose call is not in the tail. */
function orphansAtCut(s: Session, cut: number): number {
  const whole = deriveMessages(s)
  const tail = whole.slice(messagesBefore(s, cut))
  const calls = new Set(tail.flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []).map((c) => c.id) : [])))
  return tail.filter((m) => m.role === "tool" && !calls.has(m.toolCallId ?? "")).length
}

describe("M76: the walk-off rule is exact, not a heuristic", () => {
  it("M76: no cut the rule accepts ever orphans a tool result (dispatch-shaped log)", () => {
    const s = dispatchSession(6)
    const bad: number[] = []
    for (let cut = 0; cut <= s.events.length; cut++) {
      const walked = walkOffToolEvents(s, cut)
      if (orphansAtCut(s, walked) > 0) bad.push(cut)
    }
    expect(bad).toEqual([])
  })

  it("M76: an unresolved call does NOT collapse the walk to 0 (an aborted turn must not disable the ladder)", () => {
    const s = createSession()
    append(s, { type: "turn/start" })
    append(s, { type: "user/message", text: "q" })
    append(s, { type: "tool/call", callId: "call_never", name: "read", args: {} }) // no result, ever
    append(s, { type: "turn/end" })
    append(s, { type: "turn/start" })
    append(s, { type: "user/message", text: "q2" })
    append(s, { type: "assistant/message", text: "a2" })
    append(s, { type: "turn/end" })
    // In-contract indices: production passes `0 <= index <= n - 1`
    // (`index.ts:352` passes n - retainLast with retainLast >= 1; `region.ts:131`
    // passes i <= n - 1), so these exercise the RULE, not the out-of-contract
    // clamp. Both cuts are safe and must stay where they were asked to be: a cut
    // keeps no `tool/result`, so the rule has nothing to relate the dangling call
    // to. The dangling call IS on the projection (the fold buffers it and always
    // flushes the buffer, so it surfaces as `assistant("", toolCalls)`), and no
    // backwards cut can repair it — a call-side predicate drags every later cut
    // back to the call's own index (2 here), which is what this case kills.
    expect(walkOffToolEvents(s, s.events.length - 1)).toBe(s.events.length - 1)
    expect(walkOffToolEvents(s, 5)).toBe(5)
  })
})
