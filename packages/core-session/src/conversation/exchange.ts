import type { ConversationCall, ConversationItem, ConversationProvenance, ConversationSourceRef, ConversationUnit } from "./types.ts"
import type { LLMMessage } from "../projection/types.ts"
import type { LegacyStep } from "./legacy.ts"
import { copyConversationMessage } from "./render.ts"
import type { ConversationSources } from "./sources.ts"
import { exchangeCompletion } from './unit-state.ts'

/** Mutable builders are local to one projection, never returned to a caller. */
export interface ItemBuilder {
  id: string
  kind: ConversationItem["kind"]
  sources: ConversationSourceRef[]
  provenance: ConversationProvenance
  messages: LLMMessage[]
  calls: ConversationCall[]
  receivedResults: Set<string>
  step?: LegacyStep
  stepSource?: ConversationSourceRef
  establishment: ConversationSourceRef
  unitInfo?: ConversationUnit
}

export function itemBuilder(kind: ConversationItem["kind"], source: ConversationSourceRef, provenance: ConversationProvenance, step?: LegacyStep, stepSource?: ConversationSourceRef): ItemBuilder {
  return { id: `${source.id}:${kind}`, kind, establishment: source, sources: stepSource ? [stepSource, source] : [source], provenance, messages: [], calls: [], receivedResults: new Set(), ...(step ? { step, stepSource } : {}) }
}

/** Attach accepted structure while keeping unaccepted observations audit-only. */
export function projectedItem(kind: ItemBuilder["kind"], index: number, part: string, sources: ConversationSources, step: LegacyStep | undefined, fenceIndex: number, admissionIndex?: number): ItemBuilder {
  const unaccepted = kind === "exchange" && fenceIndex >= 0 && index > fenceIndex && !step?.acceptance
  const item = itemBuilder(unaccepted ? "legacy-fragment" : kind, sources.ref(index, part), sources.provenance(index, part, admissionIndex), step, step ? sources.ref(step.start, "step") : undefined)
  if (step?.acceptanceIndex !== undefined) addItemSource(item, sources.ref(step.acceptanceIndex, "acceptance"))
  return item
}

export function addItemSource(item: Pick<ItemBuilder, 'sources'>, source: ConversationSourceRef): void {
  if (!item.sources.some(existing => existing.id === source.id)) item.sources.push(source)
}

export function finishItem(item: ItemBuilder): ConversationItem {
  const state = exchangeCompletion(item)
  return Object.freeze({
    id: item.id, kind: item.kind, sources: Object.freeze(item.sources), provenance: item.provenance,
    ...(item.unitInfo ? { unit: item.unitInfo } : {}),
    ...(item.kind !== 'legacy-fragment' && item.establishment.addressable && [...item.sources, ...item.provenance.evidence].every(source => source.addressable)
      ? { ref: Object.freeze({ kind: item.kind, at: Object.freeze({ seq: item.establishment.seq!, part: item.establishment.part }) }) } : {}),
    messages: Object.freeze(item.messages.map(copyConversationMessage)),
    ...(item.kind === "exchange" ? { exchange: Object.freeze({ id: item.step?.acceptance?.exchangeId ?? `${item.id}:exchange`, ...(item.stepSource ? { step: item.stepSource } : {}), acceptance: item.step?.acceptance ? "explicit" as const : "legacy-inferred" as const, state, calls: Object.freeze(item.calls.map(call => Object.freeze(call))) }) } : {}),
  })
}
