import type { HistoryRange, ImageInput } from "@i-harness/sdk"
import type { Message } from "../design/i18n.ts"
import { mergeReasoningChunks, type ReasoningChunk } from "./reasoning-progress.ts"

export type WireEvent = HistoryRange["events"][number]

export type TimelineRow = (
  | { id: string; kind: "message"; role: "user" | "assistant"; text: string; images?: ImageInput[]; transient?: true }
  | { id: string; kind: "tool"; name: string; args?: unknown; output?: unknown; resultReceived?: true; isError?: true; groupScope?: string }
  | { id: string; kind: "outcome"; flags: { refused?: true; truncated?: true; empty?: true } }
  | { id: string; kind: "other"; label: string; title?: string; detail?: string; transient?: true }
) & { turn?: { id: string; complete: boolean }; seqs?: number[] }

/** Pure fold of durable records and live chunks, with stable rendered ids. */
export function projectTimeline(events: readonly WireEvent[]): TimelineRow[] {
  const rows: TimelineRow[] = []
  const toolIndex = new Map<string, number>()
  const reasoningIndex = new Map<string, number>()
  const reasoningChunks = new Map<string, ReasoningChunk[]>()
  const completedReasoning = new Set<string>()
  const admittedInputs = new Map<string, Extract<WireEvent, { type: "agent/input/admitted" }>>()
  let promotedInput: Extract<WireEvent, { type: "agent/input/admitted" }> | undefined
  let streamIndex: number | undefined
  let groupScope: string | undefined
  let turn: TimelineRow["turn"]
  const appendRow = (row: TimelineRow) => rows.push(turn ? { ...row, turn } : row)
  for (const [index, event] of events.entries()) {
    if (event.type === "turn/start") { groupScope = `turn:${event.seq ?? index}`; turn = { id: groupScope, complete: false } }
    if (event.type === "turn/end") { if (turn) turn.complete = true; turn = undefined; groupScope = undefined; promotedInput = undefined }
    if (event.type === "user/message" && event.internal) continue
    if (event.type === "agent/input/admitted") { admittedInputs.set(event.inputId, event); continue }
    if (event.type === "agent/input/promoted") { promotedInput = admittedInputs.get(event.inputId); continue }
    if (event.type === "agent/input/cancelled") { admittedInputs.delete(event.inputId); if (promotedInput?.inputId === event.inputId) promotedInput = undefined; continue }
    if (event.type === "tool/dispatch" || event.type === "session/title" || event.type === "context/result-ref"
      || event.type === "sandbox/mode") continue
    if (event.type === "reasoning" || event.type === "reasoning/chunk") {
      const streamId = event.streamId
      if (event.type === "reasoning/chunk" && completedReasoning.has(event.streamId)) continue
      const rowIndex = streamId === undefined ? undefined : reasoningIndex.get(streamId)
      let detail = event.text
      if (event.type === "reasoning/chunk") {
        // Retain separated pieces until the missing range arrives. Replacing a
        // non-adjacent chunk would discard its already displayed prefix.
        let chunk = event
        const fragments: ReasoningChunk[] = []
        for (const previous of reasoningChunks.get(event.streamId) ?? []) {
          const merged = mergeReasoningChunks(chunk, previous)
          if (merged) chunk = merged
          else fragments.push(previous)
        }
        fragments.push(chunk)
        fragments.sort((a, b) => a.offset - b.offset)
        reasoningChunks.set(event.streamId, fragments)
        detail = fragments[0]!.text
      } else if (streamId !== undefined) {
        completedReasoning.add(streamId)
        reasoningChunks.delete(streamId)
      }
      if (!detail.trim()) continue
      const row: TimelineRow = { id: streamId === undefined ? `event:${event.seq ?? index}` : `reasoning:${streamId}`, kind: "other", label: "reasoning", ...(detail ? { detail } : {}), ...(event.type === "reasoning/chunk" ? { transient: true as const } : {}), ...(turn ? { turn } : {}) }
      if (rowIndex === undefined) {
        if (streamId !== undefined) reasoningIndex.set(streamId, rows.length)
        appendRow(row)
      } else rows[rowIndex] = row
    } else if (event.type === "tool/call") {
      toolIndex.set(event.callId, rows.length)
      appendRow({ id: `tool:${event.callId}`, kind: "tool", name: event.name, args: event.args, output: undefined, ...(groupScope ? { groupScope } : {}) })
    } else if (event.type === "tool/result" && toolIndex.has(event.callId)) {
      const rowIndex = toolIndex.get(event.callId)!
      const previous = rows[rowIndex]
      if (previous?.kind === "tool") rows[rowIndex] = { ...previous, output: event.output, resultReceived: true, ...(event.isError ? { isError: true as const } : {}) }
    } else if (event.type === "step/end" && (event.refused === true || event.truncated === true || event.empty === true)) {
      appendRow({
        id: `step:${event.seq ?? index}`,
        kind: "outcome",
        flags: {
          ...(event.refused === true ? { refused: true as const } : {}),
          ...(event.truncated === true ? { truncated: true as const } : {}),
          ...(event.empty === true ? { empty: true as const } : {}),
        },
      })
    } else if (event.type === "user/message" || event.type === "assistant/message") {
      if (event.type === "user/message") {
        // Old records can be linked only through the trusted promotion and an
        // exact consumed payload. Literal wrappers alone never imply origin.
        const admitted = promotedInput?.text === event.text ? promotedInput : undefined
        const input = event.input ?? admitted
        promotedInput = undefined
        const system = input?.intent === "system" || (input === undefined && event.source?.plugin === "i-harness/system-input")
        if (system) {
          const display = input?.synthetic?.display
          const title = display?.title ?? input?.synthetic?.description
          appendRow({ id: `message:${event.seq ?? index}`, kind: "other", label: "agent/input/system", detail: display?.body ?? event.text, ...(title ? { title } : {}) })
          continue
        }
      } else promotedInput = undefined
      const message: TimelineRow = {
        id: `message:${event.seq ?? index}`,
        kind: "message",
        role: event.type === "user/message" ? "user" : "assistant",
        text: event.text,
        ...(event.type === "user/message" && event.images?.length ? { images: event.images } : {}),
        ...(turn ? { turn } : {}),
      }
      if (event.type === "assistant/message" && streamIndex !== undefined) rows[streamIndex] = message
      else appendRow(message)
      streamIndex = undefined
    } else if (event.type === "assistant/chunk") {
      if (streamIndex === undefined) {
        streamIndex = rows.length
        appendRow({ id: `chunk:${event.seq ?? index}`, kind: "message", role: "assistant", text: event.text, transient: true })
      } else {
        const previous = rows[streamIndex]!
        if (previous.kind === "message") rows[streamIndex] = { ...previous, text: previous.text + event.text }
      }
    } else if (event.type === "turn/start" || event.type === "turn/end"
      || event.type === "step/start" || event.type === "step/end") {
      // Structural markers carry no readable content.
      if (event.type !== "step/end") streamIndex = undefined
    } else {
      const detail = readableEventDetail(event)
      appendRow({ id: `event:${event.seq ?? index}`, kind: "other", label: event.type, ...(detail ? { detail } : {}) })
    }
  }
  // Tool-only rounds still persist an assistant/message for provider replay.
  // They carry no visible prose and must not become empty final bubbles.
  return rows.filter(row => row.kind !== "message" || row.role !== "assistant" || row.text.trim().length > 0)
}

function readableEventDetail(event: WireEvent): string | undefined {
  if (event.type === "compaction/summary") return event.text
  if (event.type === "subagent/inbox") return event.message
  if (event.type === "team/task") return `${event.task.subject}\n${event.task.description}`
  if (event.type === "team/message/queued") return event.message.content
  if (event.type === "subagent/start") return `${event.description}\n${event.agentPath}`
  if (event.type === "subagent/end") return event.resultText ?? event.error
  return undefined
}

/** Sequence references survive message/tool/reasoning folding for history jumps. */
export function projectHistoryTimeline(events: readonly WireEvent[]): TimelineRow[] {
  const rows = projectTimeline(events).map(row => ({ ...row, seqs: [] as number[] }))
  const byId = new Map(rows.map(row => [row.id, row]))
  for (const event of events) {
    if (event.seq === undefined) continue
    const groupedId = event.type === "tool/call" || event.type === "tool/result" ? `tool:${event.callId}` : event.type === "reasoning" && event.streamId ? `reasoning:${event.streamId}` : undefined
    const row = (groupedId && byId.get(groupedId)) || byId.get(`message:${event.seq}`) || byId.get(`event:${event.seq}`) || byId.get(`step:${event.seq}`) || byId.get(`chunk:${event.seq}`)
    if (!row) continue
    row.seqs.push(event.seq)
    if (row.kind === "other" && !row.detail) {
      // A bounded page can begin after a call. Keep the searchable result
      // readable even without its earlier call row; never replay the tool.
      let detail: string | undefined
      if (event.type === "tool/result") {
        const raw = event.output
        if (raw && typeof raw === "object" && !Array.isArray(raw)) { const { images: _images, ...rest } = raw as Record<string, unknown>; detail = JSON.stringify(rest) }
        else detail = JSON.stringify(raw)
      } else detail = readableEventDetail(event)
      if (detail) row.detail = detail
    }
  }
  return rows
}

export function activityLabel(type: string, t: (message: Message) => string): string {
  const labels: Record<string, Message> = {
    reasoning: "思考過程", "todo/write": "待辦清單已更新", "goal/change": "目標已更新", "job/status": "背景任務狀態已更新",
    "compaction/start": "正在壓縮上下文", "compaction/end": "上下文已整理完成。", "compaction/summary": "上下文摘要", "compaction/reset": "上下文已重設", "compaction/prune": "工具輸出已整理",
    "sandbox/mode": "執行權限已更新", "team/member": "協作成員已更新", "team/task": "協作任務已更新",
    "team/message/queued": "協作訊息已排入佇列", "team/message/delivered": "協作訊息已送達",
    "subagent/start": "子代理已啟動", "subagent/end": "子代理執行已結束", "subagent/inbox": "收到子代理訊息",
    "agent/input/admitted": "輸入已排入佇列", "agent/input/promoted": "正在處理佇列輸入", "agent/input/cancelled": "佇列輸入已取消",
    "agent/input/system": "背景訊息",
    "plan/mode": "計畫模式已更新", "command/run": "正在執行命令", "command/done": "命令執行已結束", "schedule/change": "排程已更新", "operator/run-end": "執行記錄已更新", "rewind/point": "會話已回復", "step/failed": "模型回應已中斷",
  }
  return t(labels[type] ?? "會話狀態已更新")
}

export function outcomeLabel(flags: { refused?: true; truncated?: true; empty?: true }, t: (message: Message) => string = (message) => message): string {
  const parts: string[] = []
  if (flags.refused === true) parts.push(t("模型拒絕產生內容"))
  if (flags.truncated === true) parts.push(t("輸出達到上限被截斷"))
  if (flags.empty === true) parts.push(t("模型回覆為空"))
  return parts.join("；")
}
