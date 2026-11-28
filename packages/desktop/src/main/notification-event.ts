import { randomUUID } from "node:crypto"
import type { DesktopEvent } from "../shared/bridge.ts"
import type { NotificationKind } from "../shared/notification-preferences.ts"

export interface NotificationTarget { id: string; workspaceId: string; sessionId?: string; kind: NotificationKind }
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined

export function notificationTarget(frame: DesktopEvent, executionBusy?: (workspaceId: string, sessionId: string) => boolean): NotificationTarget | undefined {
  if (frame.kind !== "sdk/notification") return
  const { workspaceId, method } = frame
  const params = object(frame.params)
  if (!params) return
  const sessionId = typeof params.sessionId === "string" && params.sessionId ? params.sessionId : undefined
  if (method === "desktop/interaction/request" && typeof params.requestId === "string") {
    if (params.kind !== undefined && params.kind !== "question" && params.kind !== "approval") return
    // Retain the existing interaction ID so a restored card retains its read state.
    return { id: `${workspaceId}:${params.requestId}`, kind: params.kind === "question" ? "question" : "approval", workspaceId, sessionId }
  }
  if (!sessionId) return
  if (method === "session/status") {
    let kind: NotificationKind
    if (params.status === "completed") {
      // A legacy completion may arrive while a newer submission is executing.
      if (executionBusy?.(workspaceId, sessionId)) return
      kind = "completed"
    }
    else if (object(params.modelFailure)?.code === "ABORTED") return
    else if (params.status === "error" || params.status === "failed") kind = params.errorCode === "FACT_RECOVERY_REQUIRED" ? "attention" : "error"
    else return
    return { id: randomUUID(), workspaceId, sessionId, kind }
  }
  if (method !== "session/event") return
  const fact = object(params.event)
  if (fact?.type !== "subagent/end" || typeof fact.taskId !== "string") return
  let kind: NotificationKind
  if (fact.outcome === "completed") kind = "completed"
  else if (fact.outcome === "recovery-required") kind = "attention"
  else if (fact.outcome === "error") kind = "error"
  else return
  return { id: JSON.stringify([workspaceId, sessionId, fact.taskId, kind]), workspaceId, sessionId, kind }
}

export function notificationSummary(kind: NotificationKind, locale: "zh-TW" | "en"): string {
  switch (kind) {
    case "completed": return locale === "en" ? "Work has finished in a conversation." : "會話中的工作已完成。"
    case "attention": return locale === "en" ? "A conversation needs your attention." : "有會話需要處理。"
    case "error": return locale === "en" ? "Work in a conversation failed." : "會話中的工作執行失敗。"
    default: return locale === "en" ? "A conversation needs your attention." : "有會話等待你的確認或回答。"
  }
}
