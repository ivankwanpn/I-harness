import type { HistoryRange } from "@i-harness/sdk"
import type { Message } from "../design/i18n.ts"

export type WireEvent = HistoryRange["events"][number]

export type TimelineRow =
  | { id: string; kind: "message"; role: "user" | "assistant"; text: string; transient?: true }
  | { id: string; kind: "tool"; name: string; args?: unknown; output?: unknown; groupScope?: string }
  | { id: string; kind: "outcome"; flags: { refused?: true; truncated?: true; empty?: true } }
  | { id: string; kind: "other"; label: string; detail?: string }

/** Pure fold: durable rows only, with stable ids for every rendered row. */
export function projectTimeline(events: readonly WireEvent[]): TimelineRow[] {
  const rows: TimelineRow[] = []
  const toolIndex = new Map<string, number>()
  let streamIndex: number | undefined
  let groupScope: string | undefined
  for (const [index, event] of events.entries()) {
    if (event.type === "turn/start") groupScope = `turn:${event.seq ?? index}`
    if (event.type === "user/message" && event.internal) continue
    if (event.type === "tool/dispatch" || event.type === "session/title") continue
    if (event.type === "tool/call") {
      toolIndex.set(event.callId, rows.length)
      rows.push({ id: `tool:${event.callId}`, kind: "tool", name: event.name, args: event.args, output: undefined, ...(groupScope ? { groupScope } : {}) })
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
      const message: TimelineRow = {
        id: `message:${event.seq ?? index}`,
        kind: "message",
        role: event.type === "user/message" ? "user" : "assistant",
        text: event.text,
      }
      if (event.type === "assistant/message" && streamIndex !== undefined) rows[streamIndex] = message
      else rows.push(message)
      streamIndex = undefined
    } else if (event.type === "assistant/chunk") {
      if (streamIndex === undefined) {
        streamIndex = rows.length
        rows.push({ id: `chunk:${event.seq ?? index}`, kind: "message", role: "assistant", text: event.text, transient: true })
      } else {
        const previous = rows[streamIndex]!
        if (previous.kind === "message") rows[streamIndex] = { ...previous, text: previous.text + event.text }
      }
    } else if (event.type === "turn/start" || event.type === "turn/end"
      || event.type === "step/start" || event.type === "step/end") {
      // Structural markers carry no readable content.
      if (event.type !== "step/end") streamIndex = undefined
    } else {
      const detail = event.type === "reasoning" || event.type === "compaction/summary" ? event.text : undefined
      rows.push({ id: `event:${event.seq ?? index}`, kind: "other", label: event.type, ...(detail ? { detail } : {}) })
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
    "plan/mode": "計畫模式已更新", "command/run": "正在執行命令", "command/done": "命令執行已結束", "schedule/change": "排程已更新", "operator/run-end": "執行記錄已更新", "rewind/point": "會話已回復",
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
