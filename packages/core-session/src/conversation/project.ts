import type { Session } from "../events/types.ts"
import type { ImageInput } from "../images.ts"
import { imageDescriptor } from "../images.ts"
import { derivePruneSubstitutes, renderPruneSubstitute } from "../projection/pruning.ts"
import type { LLMMessage, ProviderContinuation, ProviderThinkingBlock } from "../projection/types.ts"
import type { ConversationDiagnostic, ConversationProjection } from "./types.ts"
import { conversationSources } from "./sources.ts"
import { conversationVisibility } from "./visibility.ts"
import { inferLegacy, type LegacyStep } from "./legacy.ts"
import { addItemSource, awaitingItemResults, finishItem, itemBuilder, type ItemBuilder } from "./exchange.ts"

/** Sole conversation fold: source metadata is attached before message flattening. */
export function projectConversation(session: Session, options: { ownerSessionId?: string; throughSeq?: number } = {}): ConversationProjection {
  const diagnostics: ConversationDiagnostic[] = []
  const sources = conversationSources(session, options.ownerSessionId, diagnostics)
  const visibility = conversationVisibility(session, options.throughSeq)
  const legacy = inferLegacy(session, visibility, sources, diagnostics)
  // Prune is content-addressed; all markers remain applicable even past a prefix.
  const pruned = derivePruneSubstitutes(session)
  const items: ItemBuilder[] = []
  const admissions = new Map<string, number>()
  let pendingCalls: { id: string; name: string; args: unknown }[] | undefined
  const pendingResults: LLMMessage[] = []
  const pendingToolImages: LLMMessage[] = []
  const deferredUser: ItemBuilder[] = []
  let stepOpen = false
  let toolResultsPending = false
  let block: ItemBuilder | undefined
  const auditSteps = new Map<LegacyStep, ItemBuilder>()

  const makeItem = (kind: ItemBuilder["kind"], index: number, part: string, admissionIndex?: number) => {
    const step = kind === "exchange" ? legacy.stepByEvent.get(index) : undefined
    return itemBuilder(kind, sources.ref(index, part), sources.provenance(index, part, admissionIndex), step, step ? sources.ref(step.start, "step") : undefined)
  }
  const addCall = (item: ItemBuilder, index: number) => {
    const call = legacy.callMetadata(index)
    item.calls.push(call)
    for (const source of [call.call, call.dispatch, call.result]) if (source) addItemSource(item, source)
  }
  const auditItem = (index: number, part: string) => {
    const step = legacy.stepByEvent.get(index)
    let item = step ? auditSteps.get(step) : undefined
    if (!item) { item = makeItem("exchange", index, part); items.push(item); if (step) auditSteps.set(step, item) }
    addItemSource(item, sources.ref(index, part))
    return item
  }

  // Preserve calls, results, images, then separately attributed reminders.
  // Early assistant flushes keep the owner open for later parallel results.
  const flushToolBlock = (content = "", thinkingBlocks?: ProviderThinkingBlock[], providerContinuation?: ProviderContinuation, assistantIndex?: number) => {
    if (pendingCalls) {
      if (assistantIndex !== undefined) addItemSource(block!, sources.ref(assistantIndex, "message"))
      block!.messages.push({ role: "assistant", content, toolCalls: pendingCalls, ...(thinkingBlocks?.length ? { thinkingBlocks } : {}), ...(providerContinuation ? { providerContinuation } : {}) })
      pendingCalls = undefined
    }
    if (pendingResults.length) { block!.messages.push(...pendingResults); pendingResults.length = 0 }
    if (pendingToolImages.length) { block!.messages.push(...pendingToolImages); pendingToolImages.length = 0 }
    if (deferredUser.length) { items.push(...deferredUser); deferredUser.length = 0 }
    if ((!stepOpen || !toolResultsPending) && !(block && awaitingItemResults(block))) block = undefined
  }

  for (const [index, event] of session.events.entries()) {
    if (!visibility.selected(event)) continue
    // Admissions remain readable even when their model-visible range is hidden.
    if (event.type === "agent/input/admitted") admissions.set(event.inputId, index)
    if (!visibility.lifecycle(event)) continue
    if (event.type === "user/message") {
      const admissionIndex = admissions.get(event.input?.inputId ?? event.imageInputId ?? "")
      const imageAdmission = event.imageInputId === undefined ? undefined : session.events[admissions.get(event.imageInputId) ?? -1]
      const images = event.imageInputId === undefined ? event.images : imageAdmission?.type === "agent/input/admitted" ? imageAdmission.images : undefined
      if (event.imageInputId !== undefined && !images?.length) throw new Error(`image admission not found for user/message: ${event.imageInputId}`)
      const item = makeItem("input", index, "message", admissionIndex)
      item.messages.push(images && images.length > 0 ? { role: "user", content: [{ type: "text", text: event.text }, ...images.map(image => ({ type: "image" as const, image }))] } : { role: "user", content: event.text })
      if (stepOpen && (pendingCalls || toolResultsPending)) deferredUser.push(item)
      // A stepless input keeps its historical position. A call bundle split by
      // this independent input is unresolved, even if a later result is known.
      else { flushToolBlock(); block = undefined; items.push(item) }
    } else if (event.type === "assistant/message") {
      if (legacy.suppressedAssistants.has(index)) { auditItem(index, "message"); continue }
      if (stepOpen && pendingCalls) {
        toolResultsPending = true
        flushToolBlock(event.text, event.thinkingBlocks, event.providerContinuation, index)
      } else {
        flushToolBlock()
        const item = block && awaitingItemResults(block) ? block : makeItem("exchange", index, "message")
        addItemSource(item, sources.ref(index, "message"))
        item.messages.push({ role: "assistant", content: event.text, ...(event.thinkingBlocks?.length ? { thinkingBlocks: event.thinkingBlocks } : {}), ...(event.providerContinuation ? { providerContinuation: event.providerContinuation } : {}) })
        if (item !== block) { items.push(item); block = undefined }
      }
    } else if (event.type === "step/start") stepOpen = true
    else if (event.type === "turn/start") { stepOpen = false; toolResultsPending = false }
    else if (event.type === "compaction/summary") {
      flushToolBlock()
      block = undefined
      const item = makeItem("summary", index, "message")
      item.messages.push({ role: "user", content: event.text })
      items.push(item)
    } else if (event.type === "tool/call") {
      if (!legacy.results.has(event.callId) || legacy.suppressedCalls.has(event.callId)) { addCall(auditItem(index, "call"), index); continue }
      if (!block) { block = makeItem("exchange", index, "call"); items.push(block) }
      addCall(block, index)
      pendingCalls ??= []
      pendingCalls.push({ id: event.callId, name: event.name, args: event.args })
    } else if (event.type === "tool/result") {
      if (legacy.suppressedCalls.has(event.callId)) continue
      if (!block) { block = makeItem("legacy-fragment", index, "result"); items.push(block) }
      const resultSource = sources.ref(index, "result")
      addItemSource(block, resultSource)
      block.receivedResults.add(resultSource.id)
      const out = event.output as { images?: ImageInput[] } | null | undefined
      const images = out?.images
      const record = pruned.get(event.callId)
      pendingResults.push({ role: "tool", toolCallId: event.callId, content: record !== undefined ? renderPruneSubstitute(record) : toolResultText(event.output), ...(event.isError === true ? { isError: true } : {}) })
      if (Array.isArray(images) && images.length > 0) {
        addItemSource(block, sources.ref(index, "image"))
        pendingToolImages.push({ role: "user", content: [{ type: "text", text: "Attached image(s) from tool result:" }, ...images.map(image => ({ type: "image" as const, image }))] })
      }
    } else if (event.type === "step/end" || event.type === "step/failed") {
      stepOpen = false
      toolResultsPending = false
      flushToolBlock()
      block = undefined
    }
  }
  flushToolBlock()
  return Object.freeze({ version: 1, ...(options.ownerSessionId === undefined ? {} : { ownerSessionId: options.ownerSessionId }), archiveEventCount: session.events.length, ...(options.throughSeq === undefined ? {} : { throughSeq: options.throughSeq }), items: Object.freeze(items.map(finishItem)), diagnostics: Object.freeze(diagnostics.map(diagnostic => Object.freeze({ ...diagnostic, sourceIds: Object.freeze(diagnostic.sourceIds) }))) })
}

/** Images travel in a companion message, never as base64 in result text. */
function toolResultText(output: unknown): string {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return JSON.stringify(output) ?? String(output)
  const record = output as Record<string, unknown>
  const images = record["images"]
  if (!Array.isArray(images) || images.length === 0) return JSON.stringify(output) ?? String(output)
  const { images: _images, ...rest } = record
  const hasRest = Object.keys(rest).length > 0
  const restText = hasRest ? (JSON.stringify(rest) ?? String(rest)) : ""
  const descriptor = imageDescriptor(images as ImageInput[])
  return hasRest ? restText + descriptor : descriptor.trimStart()
}
