import type { ConversationDiagnostic, ConversationUnit } from '../types.ts'
import { inferLegacy, type LegacyStep } from '../legacy.ts'
import { projectedItem, addItemSource } from '../exchange.ts'
import { awaitingItemResults, physicalUnitState } from '../unit-state.ts'
import { historySources } from './sources.ts'
import { historyVisibility } from './visibility.ts'
import { historyEntries, historyFacts, type HistoryArchive, type HistoryFact } from './facts.ts'
import type { HistoryItem, HistoryRecipe } from './types.ts'


/** Shared payload-free logical transition; each method has one grouping duty. */
class HistoryGrouping {
  readonly diagnostics: ConversationDiagnostic[] = []
  private readonly sources
  private readonly visibility
  private readonly legacy
  private readonly items: HistoryItem[] = []
  private readonly admissions = new Map<string, number>()
  private pendingCalls: number[] | undefined
  private readonly pendingResults: HistoryRecipe[] = []
  private readonly pendingToolImages = new Map<HistoryItem, HistoryRecipe[]>()
  private readonly deferredUser: HistoryItem[] = []
  private stepOpen = false
  private toolResultsPending = false
  private block: HistoryItem | undefined
  private readonly auditSteps = new Map<LegacyStep, HistoryItem>()
  private readonly explicitCalls = new Map<string, HistoryItem>()
  private readonly units = new Map<LegacyStep, ConversationUnit>()

  constructor(private readonly archive: HistoryArchive, throughSeq?: number) {
    this.sources = historySources(archive, this.diagnostics)
    this.visibility = historyVisibility(historyFacts(archive), throughSeq)
    this.legacy = inferLegacy(archive, this.visibility, this.sources, this.diagnostics)
  }

  private makeItem = (kind: HistoryItem["kind"], index: number, part: string, admissionIndex?: number, imageAdmissionIndex?: number): HistoryItem => {
    const { messages: _messages, ...item } = projectedItem(kind, index, part, this.sources, kind === 'exchange' ? this.legacy.stepByEvent.get(index) : undefined, this.legacy.fenceIndex, admissionIndex)
    const unit = kind === 'summary' ? undefined : this.legacy.stepByEvent.get(index)
    let unitInfo = unit && this.units.get(unit)
    if (unit && !unitInfo) {
      unitInfo = Object.freeze({ source: this.sources.ref(unit.start, 'step'), state: physicalUnitState(unit, unit.calls.map(this.legacy.callMetadata)) })
      this.units.set(unit, unitInfo)
    }
    return { ...item, ...(unit ? { unit, unitInfo } : {}), establishmentIndex: index, ...(admissionIndex === undefined ? {} : { admissionIndex }), ...(imageAdmissionIndex === undefined ? {} : { imageAdmissionIndex }), recipes: [] }
  }
  private addCall = (item: HistoryItem, index: number) => {
    const call = this.legacy.callMetadata(index)
    item.calls.push(call)
    for (const source of [call.call, call.dispatch, call.result]) if (source) addItemSource(item, source)
  }
  private auditItem = (index: number, part: string) => {
    const step = this.legacy.stepByEvent.get(index)
    let item = step ? this.auditSteps.get(step) : undefined
    if (!item) { item = this.makeItem("exchange", index, part); this.items.push(item); if (step) this.auditSteps.set(step, item) }
    addItemSource(item, this.sources.ref(index, part))
    return item
  }

  private flushToolBlock = (assistantIndex?: number, boundary = false) => {
    if (this.pendingCalls) {
      if (assistantIndex !== undefined) addItemSource(this.block!, this.sources.ref(assistantIndex, "message"))
      this.block!.recipes.push({ kind: "assistant", ...(assistantIndex === undefined ? {} : { index: assistantIndex }), calls: this.pendingCalls })
      this.pendingCalls = undefined
    }
    if (this.pendingResults.length) { this.block!.recipes.push(...this.pendingResults); this.pendingResults.length = 0 }
    const awaiting = this.block && awaitingItemResults(this.block)
    if (this.block && !awaiting) {
      this.block.recipes.push(...this.pendingToolImages.get(this.block) ?? [])
      this.pendingToolImages.delete(this.block)
    }
    if ((!awaiting || boundary) && this.deferredUser.length) { this.items.push(...this.deferredUser); this.deferredUser.length = 0 }
    if ((!this.stepOpen || !this.toolResultsPending) && !(this.block && awaitingItemResults(this.block))) this.block = undefined
  }


  advance(index: number, event: HistoryFact): void {
    if (!this.visibility.selected(event)) return
    // Admissions remain readable even when their model-visible range is hidden.
    if (event.type === "agent/input/admitted") this.admissions.set(event.inputId!, index)
    if (!this.visibility.lifecycle(event)) return
    if (event.type === "user/message") {
      const admissionIndex = this.admissions.get(event.inputId ?? event.imageInputId ?? "")
      const imageAdmissionIndex = event.imageInputId === undefined ? undefined : this.admissions.get(event.imageInputId)
      const imageAdmission = imageAdmissionIndex === undefined ? undefined : this.archive.get(imageAdmissionIndex)
      const images = event.imageInputId === undefined ? event.images : imageAdmission?.type === "agent/input/admitted" ? imageAdmission.images : undefined
      if (event.imageInputId !== undefined && !images) throw new Error(`image admission not found for user/message: ${event.imageInputId}`)
      const item = this.makeItem("input", index, "message", admissionIndex, imageAdmissionIndex)
      if (event.preparedRawMessageSeq !== undefined) addItemSource(item, this.sources.ref(event.preparedRawMessageSeq, 'message'))
      if (imageAdmissionIndex !== undefined && imageAdmissionIndex !== admissionIndex) addItemSource(item, this.sources.ref(imageAdmissionIndex, 'admission'))
      if (event.images && event.imageInputId === undefined) addItemSource(item, this.sources.ref(index, 'image'))
      item.recipes.push({ kind: "input", index })
      if (this.stepOpen && (this.pendingCalls || this.toolResultsPending)) this.deferredUser.push(item)
      // A stepless input keeps its historical position. A call bundle split by
      // this independent input is unresolved, even if a later result is known.
      else { this.flushToolBlock(undefined, true); this.block = undefined; this.items.push(item) }
    } else if (event.type === "assistant/message") {
      if (this.legacy.suppressedAssistants.has(index)) { this.auditItem(index, "message"); return }
      if (this.stepOpen && this.pendingCalls) {
        this.toolResultsPending = true
        this.flushToolBlock(index)
      } else {
        this.flushToolBlock()
        const item = this.block && awaitingItemResults(this.block) ? this.block : this.makeItem("exchange", index, "message")
        addItemSource(item, this.sources.ref(index, "message"))
        item.recipes.push({ kind: "assistant", index })
        if (item !== this.block) { this.items.push(item); this.block = undefined }
      }
    } else if (event.type === "step/start") this.stepOpen = true
    else if (event.type === "turn/start") { this.stepOpen = false; this.toolResultsPending = false }
    else if (event.type === 'compaction/replacement') {
      const item = this.makeItem('summary', index, 'message')
      item.recipes.push({ kind: 'summary', index })
      this.items.push(item)
    } else if (event.type === "compaction/summary") {
      this.flushToolBlock(undefined, true)
      this.block = undefined
      const item = this.makeItem("summary", index, "message")
      item.recipes.push({ kind: "summary", index })
      this.items.push(item)
    } else if (event.type === "tool/call") {
      if (!this.legacy.results.has(event.callId!) || this.legacy.suppressedCalls.has(event.callId!)) { this.addCall(this.auditItem(index, "call"), index); return }
      if (!this.block) { this.block = this.makeItem("exchange", index, "call"); this.items.push(this.block) }
      this.addCall(this.block, index)
      if (this.block.step?.acceptance) this.explicitCalls.set(event.callId!, this.block)
      this.pendingCalls ??= []
      this.pendingCalls.push(index)
    } else if (event.type === "tool/result") {
      if (this.legacy.suppressedCalls.has(event.callId!) || this.legacy.unacceptedResults.has(index)) return
      const acceptedOwner = this.explicitCalls.get(event.callId!)
      if (acceptedOwner && acceptedOwner !== this.block) { this.flushToolBlock(undefined, true); this.block = acceptedOwner }
      if (!this.block) { this.block = this.makeItem("legacy-fragment", index, "result"); this.items.push(this.block) }
      const resultSource = this.sources.ref(index, "result")
      addItemSource(this.block, resultSource)
      this.block.receivedResults.add(resultSource.id)
      this.pendingResults.push({ kind: 'result', index })
      if (event.images) {
        addItemSource(this.block, this.sources.ref(index, 'image'))
        const companions = this.pendingToolImages.get(this.block) ?? []
        companions.push({ kind: 'images', index })
        this.pendingToolImages.set(this.block, companions)
      }
    } else if (event.type === "step/end" || event.type === "step/failed") {
      this.stepOpen = false
      this.toolResultsPending = false
      this.flushToolBlock(undefined, true)
      this.block = undefined
    }
  }

  finish() {
    this.flushToolBlock(undefined, true)
    for (const [owner, images] of this.pendingToolImages) owner.recipes.push(...images)
    return { items: this.items, diagnostics: this.diagnostics }
  }
}

/** The index and projection consume the same logical descriptors/recipes. */
export function groupConversationHistory(archive: HistoryArchive, throughSeq?: number) {
  const grouping = new HistoryGrouping(archive, throughSeq)
  for (const [index, fact] of historyEntries(archive)) grouping.advance(index, fact)
  return grouping.finish()
}
