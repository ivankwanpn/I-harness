import type { HistoryRange } from "@i-harness/sdk"

export type WireEvent = HistoryRange["events"][number]

export type TimelineRow =
  | { id: string; kind: "message"; role: "user" | "assistant"; text: string }
  | { id: string; kind: "tool"; name: string; output?: unknown }
  | { id: string; kind: "outcome"; flags: { refused?: true; truncated?: true; empty?: true } }
  | { id: string; kind: "other"; label: string }

/** Pure fold: durable rows only, with stable ids for every rendered row. */
export function projectTimeline(events: readonly WireEvent[]): TimelineRow[] {
  const rows: TimelineRow[] = []
  const toolIndex = new Map<string, number>()
  for (const [index, event] of events.entries()) {
    if (event.type === "tool/call") {
      toolIndex.set(event.callId, rows.length)
      rows.push({ id: `tool:${event.callId}`, kind: "tool", name: event.name, output: undefined })
    } else if (event.type === "tool/result" && toolIndex.has(event.callId)) {
      const rowIndex = toolIndex.get(event.callId)!
      const previous = rows[rowIndex]
      if (previous?.kind === "tool") rows[rowIndex] = { ...previous, output: event.output }
    } else if (event.type === "step/end" && (event.refused === true || event.truncated === true || event.empty === true)) {
      rows.push({
        id: `step:${event.seq ?? index}`,
        kind: "outcome",
        flags: {
          ...(event.refused === true ? { refused: true as const } : {}),
          ...(event.truncated === true ? { truncated: true as const } : {}),
          ...(event.empty === true ? { empty: true as const } : {}),
        },
      })
    } else if (event.type === "user/message" || event.type === "assistant/message") {
      rows.push({
        id: `message:${event.seq ?? index}`,
        kind: "message",
        role: event.type === "user/message" ? "user" : "assistant",
        text: event.text,
      })
    } else if (event.type !== "assistant/chunk") {
      rows.push({ id: `event:${event.seq ?? index}`, kind: "other", label: event.type })
    }
  }
  return rows
}

export function outcomeLabel(flags: { refused?: true; truncated?: true; empty?: true }): string {
  const parts: string[] = []
  if (flags.refused === true) parts.push("模型拒絕產生內容")
  if (flags.truncated === true) parts.push("輸出達到上限被截斷")
  if (flags.empty === true) parts.push("模型回覆為空")
  return parts.join("；")
}
