import { describe, expect, it } from "vitest"
import type { HistoryRange } from "@i-harness/sdk"
import { outcomeLabel, projectTimeline, type TimelineRow } from "../src/renderer/session/project.ts"

type WireEvent = HistoryRange["events"][number]
type OutcomeRow = Extract<TimelineRow, { kind: "outcome" }>

describe("projectTimeline", () => {
  it("shows a live reasoning block and replaces it with its canonical record using a stable row id", () => {
    const chunks: WireEvent[] = [
      { type: "reasoning/chunk", streamId: "step-3:0", blockId: "0", text: "Inspect ", offset: 0, atSeq: 3 },
      { type: "reasoning/chunk", streamId: "step-3:0", blockId: "0", text: "files", offset: 8, atSeq: 3 },
    ]
    const live = projectTimeline(chunks)
    expect(live).toEqual([{ id: "reasoning:step-3:0", kind: "other", label: "reasoning", detail: "Inspect files", transient: true }])
    const complete = projectTimeline([...chunks, { type: "reasoning", streamId: "step-3:0", blockId: "0", text: "Inspect files", seq: 3 }])
    expect(complete).toEqual([{ id: "reasoning:step-3:0", kind: "other", label: "reasoning", detail: "Inspect files" }])
    expect(projectTimeline([{ type: "reasoning", streamId: "step-3:0", blockId: "0", text: "Inspect files", seq: 3 }])).toEqual(complete)
  })

  it("keeps distinct reasoning blocks in provider order around tools and later rounds", () => {
    const rows = projectTimeline([
      { type: "reasoning/chunk", streamId: "a", blockId: "0", text: "first", offset: 0, atSeq: 0 },
      { type: "reasoning", streamId: "a", blockId: "0", text: "first", seq: 0 },
      { type: "reasoning/chunk", streamId: "b", blockId: "1", text: "second", offset: 0, atSeq: 1 },
      { type: "reasoning", streamId: "b", blockId: "1", text: "second", seq: 1 },
      { type: "tool/call", callId: "r", name: "read", args: {}, seq: 2 },
      { type: "reasoning/chunk", streamId: "c", blockId: "0", text: "next round", offset: 0, atSeq: 3 },
    ])
    expect(rows.map((row) => row.id)).toEqual(["reasoning:a", "reasoning:b", "tool:r", "reasoning:c"])
    expect(rows.filter((row) => row.kind === "other").map((row) => row.detail)).toEqual(["first", "second", "next round"])
  })

  it("keeps queue and sandbox bookkeeping out of the readable conversation", () => {
    const rows = projectTimeline([
      { type: "sandbox/mode", mode: "workspace-write", seq: 0 },
      { type: "agent/input/admitted", version: 1, inputId: "q1", text: "task", delivery: "queue", intent: "user", seq: 1 },
      { type: "agent/input/promoted", version: 1, inputId: "q1", seq: 2 },
      { type: "user/message", text: "task", seq: 3 },
    ])
    expect(rows.map((row) => row.id)).toEqual(["message:3"])
  })
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

    expect(rows).toEqual([{ id: "tool:c1", kind: "tool", name: "read", args: { path: "a" }, output: "contents", resultReceived: true }])
  })

  it("keeps the durable error flag on the visible tool row", () => {
    const rows = projectTimeline([
      { type: "tool/call", callId: "c1", name: "read", args: { path: "missing" }, seq: 0 },
      { type: "tool/result", callId: "c1", name: "read", output: { error: "missing" }, isError: true, seq: 1 },
    ])
    expect(rows[0]).toMatchObject({ kind: "tool", name: "read", isError: true })
  })
  it("marks a tool result as received even if the body returned no value", () => {
    const rows = projectTimeline([
      { type: "tool/call", callId: "c1", name: "plugin_noop", args: {}, seq: 0 },
      { type: "tool/result", callId: "c1", name: "plugin_noop", output: undefined, isError: true, seq: 1 },
    ])
    expect(rows[0]).toMatchObject({ kind: "tool", resultReceived: true, isError: true })
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

  it("keeps durable user image attachments on the visible message row", () => {
    const image = { mediaType: "image/png" as const, dataBase64: "iVBORw0KGgo=", name: "probe.png" }
    const rows = projectTimeline([
      { type: "user/message", text: "What color?", images: [image], seq: 4 },
    ])
    expect(rows).toEqual([{ id: "message:4", kind: "message", role: "user", text: "What color?", images: [image] }])
    expect(rows[0]?.kind === "message" && rows[0].images?.[0]).toBe(image)
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
