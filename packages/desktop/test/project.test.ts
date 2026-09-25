import { describe, expect, it } from "vitest"
import type { HistoryRange } from "@i-harness/sdk"
import { outcomeLabel, projectTimeline, type TimelineRow } from "../src/renderer/session/project.ts"

type WireEvent = HistoryRange["events"][number]
type OutcomeRow = Extract<TimelineRow, { kind: "outcome" }>

describe("projectTimeline", () => {
  it("merges tool/call and tool/result with the same callId into one row", () => {
    const rows = projectTimeline([
      { type: "tool/call", callId: "c1", name: "read", args: { path: "a" }, seq: 0 },
      { type: "tool/result", callId: "c1", name: "read", output: "contents", seq: 1 },
    ])

    expect(rows).toEqual([{ id: "tool:c1", kind: "tool", name: "read", output: "contents" }])
  })

  it("gives refused, truncated and empty step endings distinct labels", () => {
    const label = (event: WireEvent): string => {
      const rows = projectTimeline([event])
      expect(rows[0]?.kind).toBe("outcome")
      return outcomeLabel((rows[0] as OutcomeRow).flags)
    }

    const labels = [
      label({ type: "step/end", refused: true, seq: 3 }),
      label({ type: "step/end", truncated: true, seq: 4 }),
      label({ type: "step/end", empty: true, seq: 5 }),
    ]

    expect(new Set(labels).size).toBe(3)
    expect(labels[0]).toContain("拒絕")
    expect(labels[1]).toContain("截斷")
    expect(labels[2]).toContain("空")
  })

  it("keeps unknown events readable and drops transient chunks", () => {
    const rows = projectTimeline([
      { type: "assistant/chunk", text: "hel", seq: 0 },
      { type: "todo/write", version: 1, items: [], seq: 1 },
      { type: "goal/change", version: 1, operation: "clear", cleared: { id: "goal-1", revision: 3 }, seq: 2 },
    ])

    expect(rows).toEqual([
      { id: "event:1", kind: "other", label: "todo/write" },
      { id: "event:2", kind: "other", label: "goal/change" },
    ])
  })

  it("keeps user and assistant messages in order with stable ids", () => {
    const rows = projectTimeline([
      { type: "user/message", text: "hi", seq: 0 },
      { type: "assistant/message", text: "hello", seq: 1 },
    ])

    expect(rows).toEqual([
      { id: "message:0", kind: "message", role: "user", text: "hi" },
      { id: "message:1", kind: "message", role: "assistant", text: "hello" },
    ])
  })

  it("uses the array index as the id when an event carries no seq", () => {
    const rows = projectTimeline([
      { type: "user/message", text: "no seq" },
      { type: "step/end", refused: true },
    ])

    expect(rows.map((row) => row.id)).toEqual(["message:0", "step:1"])
  })
})
