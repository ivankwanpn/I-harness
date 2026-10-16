import { validBudgetSnapshot, type BudgetRead, type RequestBudgetSnapshot } from "./events/context.ts"

/** Additive v1 wire contract. A snapshot may be known while admission is unavailable. */
export type SessionContextState =
  | { kind: "ready"; estimatedTokens: number; contextWindow: number; roleTokens?: RequestBudgetSnapshot["roleTokens"]; snapshot?: RequestBudgetSnapshot }
  | { kind: "unavailable"; reason: string; snapshot?: RequestBudgetSnapshot }

export function contextStateFromBudget(read: BudgetRead): SessionContextState {
  if (read.kind === "unavailable") return { kind: "unavailable", reason: read.reason }
  if (!validBudgetSnapshot(read.snapshot)) return { kind: "unavailable", reason: "Prepared context facts are invalid" }
  const snapshot = structuredClone(read.snapshot)
  if (snapshot.capSupport !== "supported" && snapshot.effectiveOutputCap !== undefined) return { kind: "unavailable", reason: "Prepared output cap facts are inconsistent" }
  if (snapshot.admission === "unavailable" || snapshot.coverage === "incomplete" || snapshot.recoveryRequired || snapshot.fullByProvider || !snapshot.contextWindow)
    return { kind: "unavailable", reason: snapshot.reason ?? (snapshot.fullByProvider ? "Provider context recovery remains required" : "Prepared context is unavailable"), snapshot }
  return { kind: "ready", estimatedTokens: snapshot.estimatedInputTokens, contextWindow: snapshot.contextWindow, roleTokens: { ...snapshot.roleTokens }, snapshot }
}

/** Shared boundary decoder; legacy v1 readings stay readable, new facts fail closed. */
export function readSessionContextState(value: unknown, ownerSessionId?: string): SessionContextState {
  const invalid = (): SessionContextState => ({ kind: "unavailable", reason: "Context reading is unavailable or invalid" })
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid()
  const candidate = value as Record<string, unknown>
  if (candidate.kind !== "ready" && candidate.kind !== "unavailable") return invalid()
  if (candidate.snapshot !== undefined) {
    if (!validBudgetSnapshot(candidate.snapshot) || ownerSessionId !== undefined && candidate.snapshot.ownerSessionId !== ownerSessionId) return invalid()
    const state = contextStateFromBudget({ kind: "ready", snapshot: candidate.snapshot })
    if (!state.snapshot) return invalid()
    // A transport may carry stale/blocked known facts, never upgrade unavailable.
    if (candidate.kind === "unavailable") return { kind: "unavailable", reason: typeof candidate.reason === "string" ? candidate.reason.slice(0, 256) : "Prepared context is unavailable", snapshot: state.snapshot }
    if (state.kind !== "ready" || candidate.estimatedTokens !== state.estimatedTokens || candidate.contextWindow !== state.contextWindow) return invalid()
    return state
  }
  if (candidate.kind === "unavailable") return { kind: "unavailable", reason: typeof candidate.reason === "string" ? candidate.reason.slice(0, 256) : "" }
  const used = candidate.estimatedTokens, window = candidate.contextWindow
  // Preserve old gateway fractional estimates; new snapshots use safe integers.
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || typeof window !== "number" || !Number.isFinite(window) || window <= 0 || !Number.isFinite(used / window * 100)) return invalid()
  const roles = candidate.roleTokens as RequestBudgetSnapshot["roleTokens"] | undefined
  return { kind: "ready", estimatedTokens: used, contextWindow: window,
    ...(roles && [roles.user, roles.assistant, roles.tool].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0) ? { roleTokens: { user: roles.user, assistant: roles.assistant, tool: roles.tool } } : {}) }
}
