import { describe, expect, it } from "vitest"
import type { HistoryRange } from "@i-harness/sdk"
import { outcomeLabel, projectTimeline, type TimelineRow } from "../src/renderer/session/project.ts"

type WireEvent = HistoryRange["events"][number]
type OutcomeRow = Extract<TimelineRow, { kind: "outcome" }>

describe("projectTimeline", () => {
  it("replaces streamed text even when another activity arrives before the final message", () => {
    const rows = projectTimeline([
      { type: "assistant/chunk", text: "Hel", seq: 0 },
      { type: "todo/write", version: 1, items: [], seq: 1 },
      { type: "assistant/chunk", text: "lo", seq: 2 },
      { type: "assistant/message", text: "Hello", seq: 3 },
    ])
    expect(rows.filter((row) => row.kind === "message")).toEqual([{ id: "message:3", kind: "message", role: "assistant", text: "Hello" }])
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length)
  })
  it("keeps interrupted streams separate across turns", () => {
    const rows = projectTimeline([
      { type: "assistant/chunk", text: "partial", seq: 0 },
      { type: "turn/end", seq: 1 },
      { type: "turn/start", seq: 2 },
      { type: "assistant/chunk", text: "next", seq: 3 },
    ])
    expect(rows.filter((row) => row.kind === "message").map((row) => row.text)).toEqual(["partial", "next"])
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length)
  })
  it("does not expose internal model-context user messages as user prompts", () => {
    expect(projectTimeline([{ type: "user/message", text: "internal state", internal: true, seq: 0 }])).toEqual([])
  })
  it("merges tool/call and tool/result with the same callId into one row", () => {
    const rows = projectTimeline([
      { type: "tool/call", callId: "c1", name: "read", args: { path: "a" }, seq: 0 },
      { type: "tool/result", callId: "c1", name: "read", output: "contents", seq: 1 },
    ])

    expect(rows).toEqual([{ id: "tool:c1", kind: "tool", name: "read", args: { path: "a" }, output: "contents" }])
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

  it("keeps unknown events readable and flushes the stream ahead of them", () => {
    const rows = projectTimeline([
      { type: "assistant/chunk", text: "hel", seq: 0 },
      { type: "todo/write", version: 1, items: [], seq: 1 },
      { type: "goal/change", version: 1, operation: "clear", cleared: { id: "goal-1", revision: 3 }, seq: 2 },
    ])

    expect(rows).toEqual([
      { id: "chunk:0", kind: "message", role: "assistant", text: "hel", transient: true },
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

  it("streams assistant chunks as one transient row and drops them once the durable message lands", () => {
    const streaming = projectTimeline([
      { type: "assistant/chunk", text: "Hel", seq: 0 },
      { type: "assistant/chunk", text: "lo", seq: 1 },
    ])
    expect(streaming).toEqual([
      { id: "chunk:0", kind: "message", role: "assistant", text: "Hello", transient: true },
    ])

    const settled = projectTimeline([
      { type: "assistant/chunk", text: "Hel", seq: 0 },
      { type: "assistant/chunk", text: "lo", seq: 1 },
      { type: "assistant/message", text: "Hello", seq: 2 },
    ])
    expect(settled).toEqual([
      { id: "message:2", kind: "message", role: "assistant", text: "Hello" },
    ])
  })

  it("drops structural markers that carry no readable content", () => {
    const rows = projectTimeline([
      { type: "turn/start", seq: 0 },
      { type: "step/start", seq: 1 },
      { type: "step/end", seq: 2 },
      { type: "turn/end", seq: 3 },
    ])

    expect(rows).toEqual([])
  })
})
