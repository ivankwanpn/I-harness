import { fields, object, integer, string, digest, one, enumOf, validBudgetSnapshot, validContextCheckpoint, type ContextUsageCheckpoint, type RequestBudgetSnapshot, type ContextRecoveryFacts } from './context-scalars.ts'
export { validBudgetSnapshot, validContextCheckpoint } from './context-scalars.ts'
export type { ContextBindingMetadata, ContextUsageCheckpoint, RequestBudgetSnapshot, BudgetRead, ContextRecoveryFacts } from './context-scalars.ts'
import { validContextUsageV2, scalarFields, type ContextUsageEventV2 } from "./attribution.ts"
import { isGenerationEventType, validGenerationEvent } from './generation.ts'
import { validSoftReductionEvent, type SoftReductionEvent } from './soft-reduction.ts'
import { validAdmissionObservation, type RequestBudgetSnapshotV2 } from './admission.ts'
export type ContextEvent = ContextUsageEventV2 | SoftReductionEvent
  | { type: "context/budget"; version: 1; snapshot: RequestBudgetSnapshot; seq?: number }
  | { type: 'context/budget'; version: 2; snapshot: RequestBudgetSnapshotV2; seq?: number }
  | { type: "context/usage"; version: 1; checkpoint: ContextUsageCheckpoint; seq?: number }
  | ({ type: "context/recovery"; seq?: number } & ContextRecoveryFacts)

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
