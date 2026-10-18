import { validContextUsageV2, scalarFields, type ContextUsageEventV2 } from "./attribution.ts"
import { isGenerationEventType, validGenerationEvent } from './generation.ts'
import { validSoftReductionEvent, type SoftReductionEvent } from './soft-reduction.ts'
import { validAdmissionObservation, type RequestBudgetSnapshotV2 } from './admission.ts'
/** Owned scalar facts only. Protocol payloads and prefix unit vectors are ephemeral. */
export interface ContextBindingMetadata {
  version: 1; providerId?: string; modelId: string; protocol: string
  contextWindow?: number; maxOutputTokens?: number; reasoningEffort?: string
  bindingConfigFingerprint?: string; identityCoverage: "complete" | "partial"
}
export interface ContextUsageCheckpoint {
  version: 1; ownerSessionId: string; bindingFingerprint: string; shapeFingerprint: string
  bindingConfigFingerprint?: string; identityCoverage: "complete" | "partial"
  inputPrefixFingerprint: string; inputUnitCount: number; heuristicPrefixTokens: number
  reportedInputTokens: number; reportedOutputTokens?: number; projectionRevision: number
}
export interface RequestBudgetSnapshot {
  version: 1; ownerSessionId: string; providerId?: string; modelId: string; protocol: string
  bindingFingerprint: string; bindingRevision: number; projectionRevision: number; neutralFingerprint: string
  bindingConfigFingerprint?: string; identityCoverage: "complete" | "partial"
  estimatedInputTokens: number; admissionInputTokens: number; contextWindow?: number
  estimateSource: "projected-heuristic" | "provider-anchor-plus-projection" | "neutral-only"
  coverage: "complete" | "neutral-only" | "incomplete"
  confidence: "estimated" | "calibrated-mixed" | "unknown-components"
  roleTokens: { user: number; assistant: number; tool: number }
  systemTokens: number; schemaTokens: number; reasoningTokens: number
  outputReserve: number; effectiveOutputCap?: number; capSupport: "supported" | "unsupported" | "unknown"
  safetyMargin: number; remainingInputBudget?: number; admission: "fit" | "compact" | "unavailable"
  recoveryRequired: boolean; fullByProvider: boolean; reason?: string
  requestContext?: { version: 1; semanticRevision: string; protectionRevision: string; branchId: string; contextEpoch: string; surfaceRevision: string }
  postResponseContextRevision?: string
}
export type BudgetRead = { kind: "ready"; snapshot: RequestBudgetSnapshot; observation?: RequestBudgetSnapshotV2 } | { kind: "unavailable"; reason: string }
export interface ContextRecoveryFacts {
  version: 1; ownerSessionId: string; recoveryId: string; logicalStepSeq: number
  bindingFingerprint: string; rejectedInputFingerprint: string
  state: "required" | "retry-started" | "resolved" | "blocked"
  inputTokens?: number; contextLimit?: number; reason?: string
  providerId?: string; modelId?: string; protocol?: string
  shapeFingerprint?: string; bindingConfigFingerprint?: string
  identityCoverage?: "complete" | "partial"
  inputCost?: number; inputBytes?: number; retryConsumed?: boolean
  retryInputFingerprint?: string
}
export type ContextEvent = ContextUsageEventV2 | SoftReductionEvent
  | { type: "context/budget"; version: 1; snapshot: RequestBudgetSnapshot; seq?: number }
  | { type: 'context/budget'; version: 2; snapshot: RequestBudgetSnapshotV2; seq?: number }
  | { type: "context/usage"; version: 1; checkpoint: ContextUsageCheckpoint; seq?: number }
  | ({ type: "context/recovery"; seq?: number } & ContextRecoveryFacts)

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const integer = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0
const string = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 256
const digest = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v)
function fields(value: unknown, required: Record<string, (v: unknown) => boolean>, optional: Record<string, (v: unknown) => boolean> = {}): boolean {
  if (!object(value) || Object.keys(value).some(key => !(key in required) && !(key in optional))) return false
  return Object.entries(required).every(([key, valid]) => valid(value[key]))
    && Object.entries(optional).every(([key, valid]) => value[key] === undefined || valid(value[key]))
}
const one = (v: unknown) => v === 1
const enumOf = (...values: unknown[]) => (v: unknown) => values.includes(v)
const identity = { version: one, ownerSessionId: string, bindingFingerprint: digest, identityCoverage: enumOf("complete", "partial"), projectionRevision: integer }
export function validContextCheckpoint(value: unknown): value is ContextUsageCheckpoint {
  return fields(value, { ...identity, shapeFingerprint: digest, inputPrefixFingerprint: digest, inputUnitCount: integer, heuristicPrefixTokens: integer, reportedInputTokens: integer }, { bindingConfigFingerprint: digest, reportedOutputTokens: integer })
}
export function validBudgetSnapshot(value: unknown): value is RequestBudgetSnapshot {
  if (object(value) && value.postResponseContextRevision !== undefined && value.requestContext === undefined) return false
  return fields(value, { ...identity, modelId: string, protocol: string, bindingRevision: integer, neutralFingerprint: digest,
    estimatedInputTokens: integer, admissionInputTokens: integer, estimateSource: enumOf("projected-heuristic", "provider-anchor-plus-projection", "neutral-only"),
    coverage: enumOf("complete", "neutral-only", "incomplete"), confidence: enumOf("estimated", "calibrated-mixed", "unknown-components"),
    roleTokens: v => fields(v, { user: integer, assistant: integer, tool: integer }), systemTokens: integer, schemaTokens: integer, reasoningTokens: integer,
    outputReserve: integer, capSupport: enumOf("supported", "unsupported", "unknown"), safetyMargin: integer, admission: enumOf("fit", "compact", "unavailable"),
    recoveryRequired: v => typeof v === "boolean", fullByProvider: v => typeof v === "boolean" },
  { providerId: string, bindingConfigFingerprint: digest, contextWindow: integer, effectiveOutputCap: integer, remainingInputBudget: integer, reason: string,
    requestContext: v => fields(v, { version: one, semanticRevision: digest, protectionRevision: digest, branchId: digest, contextEpoch: digest, surfaceRevision: digest }), postResponseContextRevision: digest })
}
export function isContextEventType(type: string): boolean { return isGenerationEventType(type) || ["context/budget", "context/usage", "context/recovery", 'context/soft-reduction'].includes(type) }
export function validContextEvent(value: unknown): value is ContextEvent {
  if (value && typeof value === 'object' && Object.getOwnPropertyDescriptor(value, 'type')?.value === 'context/budget' && Object.getOwnPropertyDescriptor(value, 'version')?.value === 2)
    return scalarFields(value, { type: v => v === 'context/budget', version: v => v === 2, snapshot: validAdmissionObservation }, { seq: v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 })
  if (value && typeof value === 'object' && Object.getOwnPropertyDescriptor(value, 'type')?.value === 'context/soft-reduction') return validSoftReductionEvent(value)
  if (value && typeof value === 'object' && isGenerationEventType(Object.getOwnPropertyDescriptor(value, 'type')?.value)) return validGenerationEvent(value)
  if (!object(value) || new TextEncoder().encode(JSON.stringify(value)).byteLength > 4096) return false
  if (value.type === "context/usage" && value.version === 2) return validContextUsageV2(value)
  const envelope = { version: one, seq: integer }
  if (value.type === "context/budget") return fields(value, { type: enumOf("context/budget"), version: one, snapshot: validBudgetSnapshot }, { seq: integer })
  if (value.type === "context/usage") return fields(value, { type: enumOf("context/usage"), version: one, checkpoint: validContextCheckpoint }, { seq: integer })
  return fields(value, { type: enumOf("context/recovery"), version: one, ownerSessionId: string, recoveryId: string, logicalStepSeq: integer, bindingFingerprint: digest, rejectedInputFingerprint: digest, state: enumOf("required", "retry-started", "resolved", "blocked") }, { seq: envelope.seq, inputTokens: integer, contextLimit: integer, reason: string,
    providerId: string, modelId: string, protocol: string, shapeFingerprint: digest, bindingConfigFingerprint: digest,
    identityCoverage: enumOf("complete", "partial"), inputCost: integer, inputBytes: integer, retryConsumed: v => typeof v === "boolean", retryInputFingerprint: digest })
}
