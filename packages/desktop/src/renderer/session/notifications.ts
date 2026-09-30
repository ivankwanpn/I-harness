export type NotificationClass =
  | { kind: "chunk"; sessionId: string }
  | { kind: "durable"; sessionId: string }
  | { kind: "status"; sessionId: string; status?: string }
  | { kind: "ignore" }

/** One classification decides every refresh rule: chunks are cheap and
 * transient, durable rows and status transitions are refresh points. */
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
  return type === "assistant/chunk" || type === "reasoning/chunk" ? { kind: "chunk", sessionId } : { kind: "durable", sessionId }
}
