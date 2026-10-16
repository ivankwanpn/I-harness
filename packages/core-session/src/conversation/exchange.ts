import type { ConversationCall, ConversationItem, ConversationProvenance, ConversationSourceRef } from "./types.ts"
import type { LLMMessage } from "../projection/types.ts"
import type { LegacyStep } from "./legacy.ts"
import { copyConversationMessage } from "./render.ts"
import type { ConversationSources } from "./sources.ts"

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

/** A looked-up result reference is evidence, not proof this bundle consumed it. */
export function awaitingItemResults(item: Pick<ItemBuilder, 'calls' | 'receivedResults'>): boolean {
  return item.calls.some(call => call.result !== undefined && !item.receivedResults.has(call.result.id))
}

export function finishItem(item: ItemBuilder): ConversationItem {
  const state = item.step?.failed || item.step?.suppressed && item.step.ended ? "unresolved"
    : item.step && !item.step.ended ? "open"
    : item.calls.some(call => call.result === undefined) || awaitingItemResults(item) ? "unresolved" : "closed"
  return Object.freeze({
    id: item.id, kind: item.kind, sources: Object.freeze(item.sources), provenance: item.provenance,
    ...(item.kind !== 'legacy-fragment' && item.establishment.addressable && [...item.sources, ...item.provenance.evidence].every(source => source.addressable)
      ? { ref: Object.freeze({ kind: item.kind, at: Object.freeze({ seq: item.establishment.seq!, part: item.establishment.part }) }) } : {}),
    messages: Object.freeze(item.messages.map(copyConversationMessage)),
    ...(item.kind === "exchange" ? { exchange: Object.freeze({ id: item.step?.acceptance?.exchangeId ?? `${item.id}:exchange`, ...(item.stepSource ? { step: item.stepSource } : {}), acceptance: item.step?.acceptance ? "explicit" as const : "legacy-inferred" as const, state, calls: Object.freeze(item.calls.map(call => Object.freeze(call))) }) } : {}),
  })
}
