export type NotificationClass =
  | { kind: "chunk"; sessionId: string }
  | { kind: "durable"; sessionId: string }
  | { kind: "status"; sessionId: string; status?: string }
  | { kind: "ignore" }

/** Classify timeline delivery separately from changes to other session views. */
export function classifyNotification(method: string, params: unknown): NotificationClass {
  const record = params !== null && typeof params === "object" && !Array.isArray(params)
    ? params as Record<string, unknown>
    : undefined
  const sessionId = record?.sessionId
  if (typeof sessionId !== "string" || sessionId === "") return { kind: "ignore" }
  if (method === "session/status") {
    return {
      kind: "status",
      sessionId,
      ...(typeof record?.status === "string" ? { status: record.status } : {}),
    }
  }
  if (method !== "session/event") return { kind: "ignore" }
  const event = record?.event
  const type = event !== null && typeof event === "object" ? (event as { type?: unknown }).type : undefined
  if (type === "model/activity") return { kind: "ignore" }
  return type === "assistant/chunk" || type === "reasoning/chunk" ? { kind: "chunk", sessionId } : { kind: "durable", sessionId }
}

const dashboardEvents = new Set(["turn/start", "turn/end", "session/title", "step/failed", "job/status", "rewind/point"])
export function affectsSessionQueue(type: string): boolean {
  return type.startsWith("agent/input/") || type === "turn/start" || type === "turn/end" || type === "rewind/point"
}

export function affectsSessionTasks(type: string): boolean {
  return type.startsWith("subagent/") || type.startsWith("workflow/") || type === "job/status"
    || type === "exec/end" || type === "rewind/point" || type === "tool/result" || type === "code/result"
}

export function affectsSessionDashboard(method: string, params: unknown): boolean {
  if (method === "session/status" || method === "session/execution-state" || method === "desktop/session/navigation/changed") return true
  if (method !== "session/event") return false
  const type = (params as { event?: { type?: unknown } } | null)?.event?.type
  return typeof type === "string" && dashboardEvents.has(type)
}
