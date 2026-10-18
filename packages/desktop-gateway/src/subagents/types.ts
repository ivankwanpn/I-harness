import type { SessionAssembly } from "@i-harness/session-executor"
import { validRetainedResultRevision, type RetainedResultRevision, type ManagedArtifactRef } from '@i-harness/core-session'
export type DesktopSubagentStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "unavailable"
export interface DesktopSubagentRow {
  sessionId: string
  parentSessionId: string
  path?: string
  roleName?: string
  label: string
  status: DesktopSubagentStatus
  live: boolean
  modelLabel?: string
  jobId?: string
  finalText?: string
  error?: string
  result?: RetainedResultRevision
  fullResult?: { method: 'desktop/session/subagents/result'; sessionId: string; childSessionId: string; resultRevision: string; refId?: string; refRevision?: string }
  controlReason?: string
  canFollowup: boolean
  canMessage: boolean
  canInterrupt: boolean
  canClose: boolean
}
export interface DesktopSubagentCatalog {
  parentSessionId: string
  agents: DesktopSubagentRow[]
  errors?: { sessionId?: string; message: string }[]
}
export type DesktopSubagentControl = { action: "followup" | "message" | "interrupt" | "close"; text?: string }
export interface DesktopSubagentControlResult { parentSessionId: string; childSessionId: string; action: DesktopSubagentControl["action"]; result: unknown }
export type AgentRecord = { sessionId: string; path: string; status: string; roleName?: string; modelLabel?: string; jobId?: string; taskId?: string; finalText?: string; error?: string; result?: RetainedResultRevision }
export interface SubagentResultArgs { offset?: number; maxBytes?: number; resultRevision?: string; refId?: string; refRevision?: string }
export interface SubagentReadOptions {
  readResult?(access: { sessionId: string; ownerSessionId: string }, ref: ManagedArtifactRef, args: { offset?: number; maxBytes?: number }): Promise<{ ref: ManagedArtifactRef; offset: number; nextOffset: number | null; eof: boolean; data: { kind: 'text'; text: string } | { kind: 'bytes'; base64: string } }>
}
export type Authority = { ownerId: string; assembly: SessionAssembly; entry: AgentRecord }
export const MAX_LINEAGE = 64
export const CONTROL_REASON = "This subagent is not active in the current process. Its saved history remains available."
export const PLAN_REASON = "Leave Plan Mode before following up with or messaging a subagent."
export const actions = new Set(["followup", "message", "interrupt", "close"])
export function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
export function id(value: string): void { if (typeof value !== "string" || !value || value.length > 256 || value.includes("\0")) throw new Error("Invalid session id") }
export function errorText(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 2000) }
export function records(value: unknown): AgentRecord[] {
  if (!Array.isArray(value)) throw new Error("Subagent registry is unavailable")
  return value.flatMap((raw) => {
    const row = object(raw)
    if (typeof row?.sessionId !== "string" || typeof row.path !== "string" || typeof row.status !== "string") return []
    if (row.result !== undefined && !validRetainedResultRevision(row.result)) throw new Error('Subagent retained result metadata is invalid')
    return [{ sessionId: row.sessionId, path: row.path, status: row.status, ...(row.result ? { result: row.result as RetainedResultRevision } : {}), ...Object.fromEntries(["roleName", "modelLabel", "jobId", "taskId", "finalText", "error"].flatMap((key) => typeof row[key] === "string" ? [[key, row[key]]] : [])) }]
  })
}
export function jobRecords(value: unknown): AgentRecord[] {
  if (!Array.isArray(value)) return []
  return records(value.flatMap(raw => {
    const row = object(raw)
    if (!row || row.kind !== 'subagent' || typeof row.agentPath !== 'string' || typeof row.sessionId !== 'string') return []
    return [{ ...row, path: row.agentPath, jobId: row.id, ...(row.status === 'error' || row.status === 'killed' ? { error: row.output } : { finalText: row.output }) }]
  }))
}
export function status(raw?: string): DesktopSubagentStatus {
  return raw === "running" || raw === "waiting" || raw === "completed" ? raw : raw === "accepted" ? "queued" : raw === "error" || raw === "recovery-required" ? "failed" : raw === "killed" || raw === "cancelled" ? "cancelled" : "unavailable"
}

