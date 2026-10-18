import type { ContextBindingMetadata, ConversationProjection } from "@i-harness/core-session"
import type { ReasoningEffort, ToolSchema } from "@i-harness/llm-seam"

export type ContextRevision = string
export type ImmutableJson = null | boolean | number | string | readonly ImmutableJson[] | { readonly [key: string]: ImmutableJson }
export type Captured<T> = unknown extends T ? ImmutableJson : T extends readonly (infer E)[] ? readonly Captured<E>[] : T extends object ? { readonly [K in keyof T]: Captured<T[K]> } : T
export interface ContextCoordinates {
  readonly ownerSessionId: string
  readonly archive: { readonly eventCount: number; readonly lastSeq?: number }
  readonly semanticRevision: ContextRevision
  readonly protectionRevision: ContextRevision
  readonly branchId: ContextRevision
  readonly contextEpoch: ContextRevision
}
export interface ContextProtection {
  readonly itemIds: readonly string[]
  readonly sourceIds: readonly string[]
  readonly pendingInputIds: readonly string[]
  readonly unsettledDelegationIds: readonly string[]
}
export interface RequestSurfaceInput {
  systemPrompt: string
  tools: readonly ToolSchema[]
  reasoningEffort?: ReasoningEffort
  maxOutputTokens?: number
  contextWindow?: number
  binding?: ContextBindingMetadata
  budgetBinding?: import("@i-harness/llm-seam").ModelBudgetBinding
}
export type CapturedRequestSurface = Captured<RequestSurfaceInput>
export interface ContextSnapshot {
  readonly version: 1
  readonly coordinates: ContextCoordinates
  readonly conversation: Captured<ConversationProjection>
  readonly protection: ContextProtection
  readonly surface: CapturedRequestSurface
  readonly surfaceRevision: ContextRevision
}
export type UnsupportedContext = { kind: "unsupported"; code: "CONTEXT_SNAPSHOT_UNSUPPORTED" | "CONTEXT_STATE_AMBIGUOUS"; component: "conversation" | "surface" | "protection"; sourceIds: readonly string[] }
export type ContextCapture = { kind: "captured"; snapshot: ContextSnapshot } | UnsupportedContext
export type ContextCoordinateRead = { kind: "available"; coordinates: ContextCoordinates; observationRevision: ContextRevision } | UnsupportedContext
export type ContextCaptureInput = { ownerSessionId: string; surface: RequestSurfaceInput }
