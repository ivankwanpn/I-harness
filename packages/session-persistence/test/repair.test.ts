// M27 R-A3: log-semantic repair (packages/session-persistence/src/repair.ts).
// repairTurnTail is a PURE function: it never mutates its input (the raw log
// must stay byte-preservable) and appends synthetic closers ONLY to the LAST
// turn's tail — an earlier closed turn is never touched (spec §1 boundary:
// "只修最後一個打開序列；已閉檔不碰").
import { describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeFileSync } from "node:fs"
import { deriveMessages } from "@i-harness/core-session"
import type { SessionEvent } from "@i-harness/core-session"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createSessionCoordinator } from "../src/index.ts"
import { repairTurnTail, TOOL_ABORTED_RECOVERY_RESULT } from "../src/repair.ts"

function events(...types: Array<Partial<SessionEvent> & { type: SessionEvent["type"] }>): SessionEvent[] {
  return types as SessionEvent[]
}

describe("repairTurnTail", () => {
  it("closes an interrupted turn (synthetic step/end + turn/end)", () => {
    const evs = events({ type: "turn/start", seq: 0 }, { type: "assistant/message", text: "x", seq: 1 })
    const out = repairTurnTail(evs)
    expect(out.at(-1)?.type).toBe("turn/end")
    expect(out.filter((e) => e.type === "step/end")).toHaveLength(1)
    // the synthetic closers come after every original event
    expect(out[0]?.type).toBe("turn/start")
    expect(out[1]?.type).toBe("assistant/message")
  })

  it("fills a missing tool/result with the M10a aborted-dispatch vocabulary", () => {
    const evs = events({ type: "turn/start", seq: 0 }, { type: "tool/call", callId: "c1", name: "bash", args: {}, seq: 1 })
    const out = repairTurnTail(evs)
    const tr = out.find((e) => e.type === "tool/result")
    expect(tr).toBeDefined()
    expect(tr).toMatchObject({
      type: "tool/result",
      callId: "c1",
      name: "bash",
      output: TOOL_ABORTED_RECOVERY_RESULT,
    })
    // order: result before the closers
    expect(out.map((e) => e.type)).toEqual(["turn/start", "tool/call", "tool/result", "step/end", "turn/end"])
  })

  it("only repairs the LAST turn — an earlier closed turn stays untouched", () => {
    const evs = events(
      { type: "turn/start", seq: 0 },
      { type: "step/start", seq: 1 },
      // unmatched call in the CLOSED first turn: never synthesized (tail-only)
      { type: "tool/call", callId: "old-call", name: "bash", args: {}, seq: 2 },
      { type: "step/end", seq: 3 },
      { type: "turn/end", seq: 4 },
      { type: "turn/start", seq: 5 },
      { type: "tool/call", callId: "tail-call", name: "bash", args: {}, seq: 6 },
    )
    const out = repairTurnTail(evs)
    expect(out.filter((e) => e.type === "tool/result")).toHaveLength(1)
    expect((out.find((e) => e.type === "tool/result") as { callId: string }).callId).toBe("tail-call")
    expect(out.at(-1)?.type).toBe("turn/end")
  })

  it("leaves an already-closed ending untouched (no synthetic events)", () => {
    const evs = events(
      { type: "turn/start", seq: 0 },
      { type: "step/start", seq: 1 },
      { type: "tool/call", callId: "c1", name: "bash", args: {}, seq: 2 },
      { type: "tool/result", callId: "c1", name: "bash", output: {}, seq: 3 },
      { type: "step/end", seq: 4 },
      { type: "turn/end", seq: 5 },
    )
    const out = repairTurnTail(evs)
    expect(out.map((e) => e.type)).toEqual(evs.map((e) => e.type))
  })

  it("synthesizes every unmatched call of the tail in order", () => {
    const evs = events(
      { type: "turn/start", seq: 0 },
      { type: "tool/call", callId: "a", name: "read", args: {}, seq: 1 },
      { type: "tool/call", callId: "b", name: "write", args: {}, seq: 2 },
      { type: "step/end", seq: 3 },
      { type: "tool/call", callId: "c", name: "bash", args: {}, seq: 4 },
    )
    const out = repairTurnTail(evs)
    const results = out.filter((e) => e.type === "tool/result").map((e) => (e as { callId: string }).callId)
    // the repair region is the LAST TURN: every call of that turn without a
    // matching result (batch boundaries can lose a result while step/end from
    // an earlier flush survives) gets a synthetic aborted result, in call order
    expect(results).toEqual(["a", "b", "c"])
    expect(out.at(-1)?.type).toBe("turn/end")
  })

  it("does not mutate the input array in place", () => {
    const evs = events({ type: "turn/start", seq: 0 }, { type: "assistant/message", text: "x", seq: 1 })
    const snapshot = evs.map((e) => ({ ...e }))
    repairTurnTail(evs)
    expect(evs.map((e) => ({ ...e }))).toEqual(snapshot)
  })

  it("empty input / content without a turn → nothing synthesized", () => {
    expect(repairTurnTail([])).toEqual([])
    const preTurn = events({ type: "user/message", text: "y", seq: 0 })
    expect(repairTurnTail(preTurn)).toEqual(preTurn)
  })
})

describe("repairTurnTail through coordinator.load()", () => {
  it("resumes a crashed mid-tool session with a synthetic result + closers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ih-repair-load-"))
    try {
      const sessionId = "sess-repair-test"
      // Simulate a crash-mid-tool log: turn/start, step/start, tool/call
      // WITHOUT tool/result, step/end or turn/end (the backend repair appends
      // the closers; the semantic layer fills the missing result).
      const header = `{"formatVersion":1,"sessionId":"${sessionId}","createdAt":"2026-08-31T00:00:00.000Z"}`
      const lines = [
        header,
        JSON.stringify({ type: "turn/start", seq: 0 }),
        JSON.stringify({ type: "step/start", seq: 1 }),
        JSON.stringify({ type: "tool/call", callId: "c1", name: "bash", args: { cmd: "echo hi" }, seq: 2 }),
      ]
      writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join("\n") + "\n", "utf8")

      const coordinator = createSessionCoordinator(createJsonlBackend(dir))
      const { session } = await coordinator.load(sessionId)
      const events = session.events
      // semantic layer: the missing result synthesized (M10a vocabulary)
      const result = events.find((e) => e.type === "tool/result") as {
        callId: string
        output: unknown
      }
      expect(result).toBeDefined()
      expect(result.callId).toBe("c1")
      expect(result.output).toEqual(TOOL_ABORTED_RECOVERY_RESULT)
      // structural closers present last
      expect(events.at(-1)?.type).toBe("turn/end")
      expect(events.filter((e) => e.type === "step/end")).toHaveLength(1)
      // the synthetic result sits INSIDE the step — before the backend's closers
      expect(events.map((e) => e.type)).toEqual([
        "turn/start", "step/start", "tool/call", "tool/result", "step/end", "turn/end",
      ])
      // projection reconstructs a valid message stream (tool block has a result)
      const messages = deriveMessages(session)
      const toolMessages = messages.filter((m) => m.role === "tool")
      expect(toolMessages).toHaveLength(1)
      expect(JSON.stringify(toolMessages[0]?.content)).toContain("TOOL_ABORTED_BEFORE_DISPATCH")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
