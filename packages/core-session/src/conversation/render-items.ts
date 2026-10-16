import type { SessionView as Session } from "../managed/types.ts"
import { derivePruneSubstitutes } from "../projection/pruning.ts"
import type { LLMMessage, ProviderContinuation, ProviderThinkingBlock } from "../projection/types.ts"
import type { ConversationDiagnostic, ConversationProjection } from "./types.ts"
import { conversationSources } from "./sources.ts"
import { conversationVisibility } from "./visibility.ts"
import { inferLegacy, type LegacyStep } from "./legacy.ts"
import { addItemSource, awaitingItemResults, finishItem, projectedItem, type ItemBuilder } from "./exchange.ts"
import { readConversationPayload, projectToolResult, type ConversationPayloadCapture } from "./payload.ts"
import { copyConversationData } from './render.ts'

/** Sole payload renderer: source metadata is attached before message flattening. */
export function renderConversationItems(session: Session, options: { ownerSessionId?: string; throughSeq?: number; capturePayload?: ConversationPayloadCapture } = {}): ConversationProjection {
  const diagnostics: ConversationDiagnostic[] = []
  const sources = conversationSources(session, options.ownerSessionId, diagnostics)
  const payload = <T, K extends keyof T>(event: T, key: K, index: number, part: string) => copyConversationData(readConversationPayload(event, key, sources.ref(index, part), options.capturePayload))
  const visibility = conversationVisibility(session, options.throughSeq)
  const legacy = inferLegacy(session, visibility, sources, diagnostics)
  // Prune is content-addressed; all markers remain applicable even past a prefix.
  const pruned = derivePruneSubstitutes(session)
  const items: ItemBuilder[] = []
  const admissions = new Map<string, number>()
  let pendingCalls: { id: string; name: string; args: unknown }[] | undefined
  const pendingResults: LLMMessage[] = []
  // Images belong to their exchange even if an interrupted fold changes block.
  const pendingToolImages = new Map<ItemBuilder, LLMMessage[]>()
  const deferredUser: ItemBuilder[] = []
  let stepOpen = false
  let toolResultsPending = false
  let block: ItemBuilder | undefined
  const auditSteps = new Map<LegacyStep, ItemBuilder>()
  const explicitCalls = new Map<string, ItemBuilder>()

  const makeItem = (kind: ItemBuilder["kind"], index: number, part: string, admissionIndex?: number) => projectedItem(kind, index, part, sources, kind === "exchange" ? legacy.stepByEvent.get(index) : undefined, legacy.fenceIndex, admissionIndex)
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
  const flushToolBlock = (content = "", thinkingBlocks?: ProviderThinkingBlock[], providerContinuation?: ProviderContinuation, assistantIndex?: number, boundary = false) => {
    if (pendingCalls) {
      if (assistantIndex !== undefined) addItemSource(block!, sources.ref(assistantIndex, "message"))
      block!.messages.push({ role: "assistant", content, toolCalls: pendingCalls, ...(thinkingBlocks?.length ? { thinkingBlocks } : {}), ...(providerContinuation ? { providerContinuation } : {}) })
      pendingCalls = undefined
    }
    if (pendingResults.length) { block!.messages.push(...pendingResults); pendingResults.length = 0 }
    const awaiting = block && awaitingItemResults(block)
    if (block && !awaiting) {
      block.messages.push(...pendingToolImages.get(block) ?? [])
      pendingToolImages.delete(block)
    }
    if ((!awaiting || boundary) && deferredUser.length) { items.push(...deferredUser); deferredUser.length = 0 }
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
      const images = event.imageInputId === undefined ? payload(event, "images", index, "image") : imageAdmission?.type === "agent/input/admitted" ? payload(imageAdmission, "images", admissions.get(event.imageInputId)!, "admission") : undefined
      if (event.imageInputId !== undefined && !images?.length) throw new Error(`image admission not found for user/message: ${event.imageInputId}`)
      const item = makeItem("input", index, "message", admissionIndex)
      item.messages.push(images && images.length > 0 ? { role: "user", content: [{ type: "text", text: event.text }, ...images.map(image => ({ type: "image" as const, image }))] } : { role: "user", content: event.text })
      if (stepOpen && (pendingCalls || toolResultsPending)) deferredUser.push(item)
      // A stepless input keeps its historical position. A call bundle split by
      // this independent input is unresolved, even if a later result is known.
      else { flushToolBlock('', undefined, undefined, undefined, true); block = undefined; items.push(item) }
    } else if (event.type === "assistant/message") {
      if (legacy.suppressedAssistants.has(index)) { auditItem(index, "message"); continue }
      const thinkingBlocks = payload(event, "thinkingBlocks", index, "message")
      const providerContinuation = payload(event, "providerContinuation", index, "message")
      if (stepOpen && pendingCalls) {
        toolResultsPending = true
        flushToolBlock(event.text, thinkingBlocks, providerContinuation, index)
      } else {
        flushToolBlock()
        const item = block && awaitingItemResults(block) ? block : makeItem("exchange", index, "message")
        addItemSource(item, sources.ref(index, "message"))
        item.messages.push({ role: "assistant", content: event.text, ...(thinkingBlocks?.length ? { thinkingBlocks } : {}), ...(providerContinuation ? { providerContinuation } : {}) })
        if (item !== block) { items.push(item); block = undefined }
      }
    } else if (event.type === "step/start") stepOpen = true
    else if (event.type === "turn/start") { stepOpen = false; toolResultsPending = false }
    else if (event.type === "compaction/summary") {
      flushToolBlock('', undefined, undefined, undefined, true)
      block = undefined
      const item = makeItem("summary", index, "message")
      item.messages.push({ role: "user", content: event.text })
      items.push(item)
    } else if (event.type === "tool/call") {
      if (!legacy.results.has(event.callId) || legacy.suppressedCalls.has(event.callId)) { addCall(auditItem(index, "call"), index); continue }
      if (!block) { block = makeItem("exchange", index, "call"); items.push(block) }
      addCall(block, index)
      if (block.step?.acceptance) explicitCalls.set(event.callId, block)
      pendingCalls ??= []
      pendingCalls.push({ id: event.callId, name: event.name, args: payload(event, "args", index, "call") })
    } else if (event.type === "tool/result") {
      if (legacy.suppressedCalls.has(event.callId) || legacy.unacceptedResults.has(index)) continue
      const acceptedOwner = explicitCalls.get(event.callId)
      if (acceptedOwner && acceptedOwner !== block) { flushToolBlock('', undefined, undefined, undefined, true); block = acceptedOwner }
      if (!block) { block = makeItem("legacy-fragment", index, "result"); items.push(block) }
      const resultSource = sources.ref(index, "result")
      addItemSource(block, resultSource)
      block.receivedResults.add(resultSource.id)
      const { content, images } = projectToolResult(event, pruned.get(event.callId), resultSource, sources.ref(index, "image"), options.capturePayload)
      pendingResults.push({ role: "tool", toolCallId: event.callId, content, ...(event.isError === true ? { isError: true } : {}) })
      if (Array.isArray(images) && images.length > 0) {
        addItemSource(block, sources.ref(index, "image"))
        const companions = pendingToolImages.get(block) ?? []
        companions.push({ role: "user", content: [{ type: "text", text: "Attached image(s) from tool result:" }, ...images.map(image => ({ type: "image" as const, image }))] })
        pendingToolImages.set(block, companions)
      }
    } else if (event.type === "step/end" || event.type === "step/failed") {
      stepOpen = false
      toolResultsPending = false
      flushToolBlock('', undefined, undefined, undefined, true)
      block = undefined
    }
  }
  flushToolBlock('', undefined, undefined, undefined, true)
  // An incomplete/interrupted source is still observable and protected. Keep
  // its companions on the original exchange; validation must not invent results.
  for (const [owner, images] of pendingToolImages) owner.messages.push(...images)
  return Object.freeze({ version: 1, ...(options.ownerSessionId === undefined ? {} : { ownerSessionId: options.ownerSessionId }), archiveEventCount: session.events.length, ...(options.throughSeq === undefined ? {} : { throughSeq: options.throughSeq }), items: Object.freeze(items.map(finishItem)), diagnostics: Object.freeze(diagnostics.map(diagnostic => Object.freeze({ ...diagnostic, sourceIds: Object.freeze(diagnostic.sourceIds) }))) })
}
