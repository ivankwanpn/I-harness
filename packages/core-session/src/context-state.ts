import { validBudgetSnapshot, type BudgetRead, type RequestBudgetSnapshot } from "./events/context.ts"
import { validAdmissionObservation, type RequestBudgetSnapshotV2 } from './events/admission.ts'

/** Additive v1 wire contract. A snapshot may be known while admission is unavailable. */
export type SessionContextState =
  | { kind: "ready"; estimatedTokens: number; contextWindow: number; roleTokens?: RequestBudgetSnapshot["roleTokens"]; snapshot?: RequestBudgetSnapshot; observation?: RequestBudgetSnapshotV2 }
  | { kind: "unavailable"; reason: string; snapshot?: RequestBudgetSnapshot; observation?: RequestBudgetSnapshotV2 }

export function contextStateFromObservation(value: unknown): SessionContextState {
  if (!validAdmissionObservation(value)) return { kind: 'unavailable', reason: 'Prepared admission facts are invalid' }
  const observation = structuredClone(value), pressure = observation.pressure
  if (observation.freshness !== 'current' || observation.disposition !== 'admit' || observation.recoveryRequired || observation.fullByProvider || pressure.kind !== 'known' || !pressure.hardFits || pressure.inputBudget <= 0)
    return { kind: 'unavailable', reason: observation.freshness !== 'current' ? 'Prepared admission is historical' : observation.reason ?? 'Capacity is unchecked or requires reduction', observation }
  return { kind: 'ready', estimatedTokens: pressure.input, contextWindow: pressure.inputBudget,
    roleTokens: { user: observation.components.user, assistant: observation.components.assistant, tool: observation.components.tool }, observation }
}

export function contextStateFromBudget(read: BudgetRead): SessionContextState {
  if (read.kind === "unavailable") return { kind: "unavailable", reason: read.reason }
  if (read.observation !== undefined) return contextStateFromObservation(read.observation)
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
  if (candidate.observation !== undefined) {
    if (!validAdmissionObservation(candidate.observation) || ownerSessionId !== undefined && candidate.observation.ownerSessionId !== ownerSessionId) return invalid()
    const state = contextStateFromObservation(candidate.observation)
    if (candidate.kind === 'unavailable') return { kind: 'unavailable', reason: typeof candidate.reason === 'string' ? candidate.reason.slice(0, 256) : 'Prepared admission is unavailable', observation: state.observation }
    if (state.kind !== 'ready' || candidate.estimatedTokens !== state.estimatedTokens || candidate.contextWindow !== state.contextWindow) return invalid()
    return state
  }
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
