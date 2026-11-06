/**
 * Recovery-gated failures cross the RPC boundary with their message only (the
 * SDK error frame carries no machine code), so the desktop recognises them by
 * their stable sentences. In that state the session's in-memory execution is
 * poisoned while its durable journal is intact: closing the session rebuilds it
 * on the next request. Doing that here makes every entry point — submit, work
 * state, history, execution polling — recover instead of showing an opaque
 * RpcError that the user cannot act on.
 */
const RECOVERY_MESSAGES = [
  "Original writer dependency cleanup unresolved",
  "Managed facts require reconciliation",
  "Original issued write needs reconciliation",
  "Original admission requires explicit recovery",
  "FACT_RECOVERY_REQUIRED",
] as const

/** Session-scoped reads that may transiently refuse while a turn prepares its
 *  writer. They are safe to retry: retrying avoids a reload, and a reload
 *  drains the live turn. Writes and prompts are never retried here. */
export const TRANSIENT_READ_METHODS: ReadonlySet<string> = new Set([
  "session/history",
  "session/context",
  "session/dashboard",
  "session/tasks",
  "desktop/session/work-state",
  "desktop/session/input/state",
  "desktop/session/project/state",
  "desktop/interaction/pending",
  "session/model/state",
  "desktop/session/navigation/state",
])

export function isTransientReadRetry(error: unknown, request: unknown): boolean {
  if (!isRecoveryFailure(error) || !isSessionScopedRequest(request)) return false
  const kind = (request as { kind?: unknown }).kind
  return typeof kind === "string" && TRANSIENT_READ_METHODS.has(kind)
}

export function isRecoveryFailure(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return RECOVERY_MESSAGES.some(needle => message.includes(needle.toLowerCase()))
}

export function isSessionScopedRequest(value: unknown): value is { workspaceId: string; sessionId: string } {
  if (value === null || typeof value !== "object") return false
  const record = value as { workspaceId?: unknown; sessionId?: unknown }
  return typeof record.workspaceId === "string" && record.workspaceId !== ""
    && typeof record.sessionId === "string" && record.sessionId !== ""
}
