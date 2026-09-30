import type { GuardianRequest, GuardianVerdict } from "@i-harness/core-tools"
import type { SpawnOptions } from "@i-harness/subagent"
import type { ModelClient, ReasoningEffort } from "@i-harness/llm-seam"
import type { IsolatedReviewerPool } from "./reviewer-pool.ts"

export interface GuardianReviewerIdentity {
  provider?: string
  model?: string
  protocol?: string
  reasoningEffort?: string
  /** Stable, secret-free fingerprint of the effective endpoint and configuration. */
  configurationKey?: string
}
export type GuardianReviewStatus = "completed" | "timeout" | "cancelled" | "malformed" | "operational" | "breaker"
export interface GuardianReviewRecord {
  id: string
  startedAt: number
  durationMs: number
  status: GuardianReviewStatus
  request: { name: string; reason: string; args: string; argsTruncated: boolean }
  model?: Omit<GuardianReviewerIdentity, "configurationKey">
  reusedContext: boolean
  /** The decision returned to the tool registry. Absent when cancelled. */
  outcome?: GuardianVerdict["outcome"]
  rationale: string
  /** The model/runner decision before an optional human fallback. */
  reviewerOutcome?: GuardianVerdict["outcome"]
  reviewerRationale?: string
  cause?: "timeout" | "malformed" | "operational"
}
export interface GuardianIsolatedConfig {
  pool?: IsolatedReviewerPool
  /** Resolve the client and effective identity from one configuration snapshot.
   * Preferred by hosts whose parent model handle can be rebound while reviewing. */
  resolveBinding?: (selection?: Parameters<SpawnOptions["resolveModel"]>[0]) => Promise<GuardianIsolatedBinding>
  identity?: (selection?: Parameters<SpawnOptions["resolveModel"]>[0]) => GuardianReviewerIdentity | Promise<GuardianReviewerIdentity>
  permissionContext?: () => string
  onReview?: (record: GuardianReviewRecord) => void | Promise<void>
}
export interface GuardianIsolatedBinding {
  client: ModelClient
  identity: GuardianReviewerIdentity
  contextWindow?: number
  maxOutputTokens?: number
  reasoningEffort?: ReasoningEffort
}

export function captureGuardianRequest(request: GuardianRequest): GuardianReviewRecord["request"] {
  let args: string
  try { args = typeof request.args === "string" ? request.args : JSON.stringify(request.args ?? null) ?? "null" }
  catch { args = "[arguments could not be serialized]" }
  return { name: request.name.slice(0, 256), reason: request.reason.slice(0, 2000), args: args.slice(0, 16000), argsTruncated: args.length > 16000 }
}

export function publicReviewerIdentity(identity: GuardianReviewerIdentity): GuardianReviewRecord["model"] {
  return Object.fromEntries(["provider", "model", "protocol", "reasoningEffort"].flatMap((key) => {
    const value = identity[key as keyof GuardianReviewerIdentity]
    return value === undefined ? [] : [[key, value.slice(0, 256)]]
  }))
}
