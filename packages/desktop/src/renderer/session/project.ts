import type { HistoryRange } from "@i-harness/sdk"
import type { Message } from "../design/i18n.ts"

export type WireEvent = HistoryRange["events"][number]

export type TimelineRow =
  | { id: string; kind: "message"; role: "user" | "assistant"; text: string; transient?: true }
  | { id: string; kind: "tool"; name: string; output?: unknown }
  | { id: string; kind: "outcome"; flags: { refused?: true; truncated?: true; empty?: true } }
  | { id: string; kind: "other"; label: string }

/** Pure fold: durable rows only, with stable ids for every rendered row. */
export function projectTimeline(events: readonly WireEvent[]): TimelineRow[] {
  const rows: TimelineRow[] = []
  const toolIndex = new Map<string, number>()
  let pendingChunks = ""
  const flushChunks = (): void => {
    if (pendingChunks === "") return
    rows.push({ id: "chunk:stream", kind: "message", role: "assistant", text: pendingChunks, transient: true })
    pendingChunks = ""
  }
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
      // The durable message replaces whatever the stream had shown.
      pendingChunks = ""
      rows.push({
        id: `message:${event.seq ?? index}`,
        kind: "message",
        role: event.type === "user/message" ? "user" : "assistant",
        text: event.text,
      })
    } else if (event.type === "assistant/chunk") {
      pendingChunks += event.text
    } else if (event.type === "turn/start" || event.type === "turn/end"
      || event.type === "step/start" || event.type === "step/end") {
      // Structural markers carry no readable content.
    } else {
      flushChunks()
      rows.push({ id: `event:${event.seq ?? index}`, kind: "other", label: event.type })
    }
  }
  flushChunks()
  return rows
}

export function outcomeLabel(flags: { refused?: true; truncated?: true; empty?: true }, t: (message: Message) => string = (message) => message): string {
  const parts: string[] = []
  if (flags.refused === true) parts.push(t("模型拒絕產生內容"))
  if (flags.truncated === true) parts.push(t("輸出達到上限被截斷"))
  if (flags.empty === true) parts.push(t("模型回覆為空"))
  return parts.join("；")
}
