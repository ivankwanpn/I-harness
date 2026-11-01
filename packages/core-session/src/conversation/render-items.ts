import type { PreparedPrunedResult, ConversationSourceCoordinateView } from './restoration-types.ts'
import type { PruneRecord } from '../projection/pruning.ts'
import { runtimeContextDigest, renderRuntimeContext } from '../events/runtime-context.ts'
import type { ConversationEventArchive } from './archive.ts'
import type { SessionView, SessionEventView } from '../managed/types.ts'
import type { ConversationProjection, ConversationDiagnostic } from './types.ts'
import type { LLMMessage } from '../projection/types.ts'
import type { HistoryItem, HistoryRecipe } from './history/types.ts'
import { archiveConversationSources } from './sources.ts'
import { finishItem } from './exchange.ts'
import { copyConversationData, copyConversationMessage } from './render.ts'
import { createConversationPayloadReader, projectToolResult, projectPrunedResultProjection, type ConversationPayloadCapture } from './payload.ts'
import { archivePruneSubstitutes } from '../projection/pruning.ts'
import { resultIsError } from '../results/projection.ts'
import { validatePreparedInputText } from './input-preparation.ts'

/** Payload-only rendering consumes the sole history owner's complete recipes.
 * It never establishes groups, closure, source unions, order or visibility. */
export function renderConversationItems(archive: ConversationEventArchive, history: { items: HistoryItem[]; diagnostics: ConversationDiagnostic[]; current?: import('./history/types.ts').HistoryCurrent }, options: { ownerSessionId?: string; throughSeq?: number; capturePayload?: ConversationPayloadCapture; header?: SessionView['header']; candidate?: { id: string; baseCount: number }; sourceCoordinates?: ConversationSourceCoordinateView; pruneSubstitutes?: ReadonlyMap<string,PruneRecord>; prunedResults?: ReadonlyMap<number,PreparedPrunedResult> } = {}): ConversationProjection {
  const diagnostics: ConversationDiagnostic[] = []
  const readPayload = createConversationPayloadReader(options.capturePayload)
  const sources = archiveConversationSources(archive, options.ownerSessionId, diagnostics, { ...options, coordinates:options.sourceCoordinates, ...(options.capturePayload ? { readPayload } : {}) })
  const source = (ref: { eventIndex: number; part: string }) => sources.ref(ref.eventIndex, ref.part)
  const pruned = options.pruneSubstitutes ?? archivePruneSubstitutes(archive)
  const results = new Map<number, ReturnType<typeof projectToolResult>>()
  const payload = <T extends object, K extends keyof T>(event: T, key: K, index: number, part: string) => copyConversationData(readPayload(event, key, sources.ref(index, part)))
  // The source index already checked preparation structure. Validate selected
  // complete payload relationships before provenance or wire formatting reads
  // them; all subsequent consumers share the same owned slot captures.
  if (options.capturePayload) for (const item of history.items) for (const recipe of item.recipes) {
    if (recipe.kind !== 'input') continue
    const index = recipe.index!, event = archive.get(index)
    if (event.type !== 'user/message' || !event.inputPreparation) continue
    const link = event.inputPreparation, resultIndex = sources.indexOfSeq(link.resultSeq), result = archive.get(resultIndex)
    if (result?.type !== 'agent/input/preparation' || result.op !== 'completed') throw new TypeError('Invalid selected preparation')
    const derived = 'rawMessageSeq' in link
    const originalIndex = derived ? resultIndex : sources.indexOfSeq(result.admissionSeq)
    const admitted = derived ? undefined : archive.get(originalIndex)
    const original = derived ? result.observations[link.observationIndex] : admitted?.type === 'agent/input/admitted' ? admitted : undefined
    if (!original) throw new TypeError('Invalid selected preparation text')
    validatePreparedInputText(event, original, derived ? result.observations[link.observationIndex]!.producer : undefined,
      value => readPayload(value, 'text', sources.ref(value === event ? index : originalIndex, value === event ? 'message' : derived ? 'preparation' : 'admission')))
  }
  const result = (index: number) => {
    const previous = results.get(index)
    if (previous) return previous
    const selected = options.prunedResults?.get(index)
    if (selected) { const rendered = projectPrunedResultProjection(selected, sources.ref(index,'result'), sources.ref(index,'image'), options.capturePayload); results.set(index,rendered); return rendered }
    const event = archive.get(index) as Extract<SessionEventView, { type: 'tool/result' }>
    const rendered = projectToolResult(event, pruned.get(event.callId), sources.ref(index, 'result'), sources.ref(index, 'image'), options.capturePayload)
    results.set(index, rendered)
    return rendered
  }
  const render = (recipe: HistoryRecipe, item: HistoryItem): LLMMessage => {
    const index = recipe.index!
    const selectedResult = index === undefined ? undefined : options.prunedResults?.get(index)
    const event = index === undefined || selectedResult ? undefined : archive.get(index)
    if (recipe.kind === 'input') {
      if (event?.type !== 'user/message') throw new Error('Invalid input recipe')
      const admission = item.imageAdmissionIndex === undefined ? undefined : archive.get(item.imageAdmissionIndex)
      const images = event.imageInputId === undefined ? payload(event, 'images', index, 'image') : admission?.type === 'agent/input/admitted' ? payload(admission, 'images', item.imageAdmissionIndex!, 'admission') : undefined
      const text = payload(event, 'text', index, 'message')
      return images?.length ? { role: 'user', content: [{ type: 'text', text }, ...images.map(image => ({ type: 'image' as const, image }))] } : { role: 'user', content: text }
    }
    if (recipe.kind === 'summary') {
      if (event?.type !== 'compaction/summary' && event?.type !== 'compaction/replacement') throw new Error('Invalid summary recipe')
      return { role: 'user', content: payload(event, 'text', index, 'message') }
    }
    if (recipe.kind === 'result') {
      if (selectedResult) return {role:'tool',toolCallId:selectedResult.callId,content:result(index).content,...(selectedResult.isError?{isError:true}:{})}
      if (event?.type !== 'tool/result') throw new Error('Invalid result recipe')
      return { role: 'tool', toolCallId: event.callId, content: result(index).content, ...((event.envelope ? resultIsError(event.envelope) : event.isError === true) ? { isError: true } : {}) }
    }
    if (recipe.kind === 'images') {
      const images = result(index).images ?? []
      return { role: 'user', content: [{ type: 'text', text: 'Attached image(s) from tool result:' }, ...images.map(image => ({ type: 'image' as const, image }))] }
    }
    const thinkingBlocks = event?.type === 'assistant/message' ? payload(event, 'thinkingBlocks', index, 'message') : undefined
    const providerContinuation = event?.type === 'assistant/message' ? payload(event, 'providerContinuation', index, 'message') : undefined
    const toolCalls = recipe.calls?.map(callIndex => {
      const call = archive.get(callIndex)
      if (call?.type !== 'tool/call') throw new Error('Invalid call recipe')
      return { id: call.callId, name: call.name, args: payload(call, 'args', callIndex, 'call') }
    })
    return { role: 'assistant', content: event?.type === 'assistant/message' ? payload(event, 'text', index, 'message') : '', ...(toolCalls ? { toolCalls } : {}), ...(thinkingBlocks?.length ? { thinkingBlocks } : {}), ...(providerContinuation ? { providerContinuation } : {}) }
  }
  const current = history.current && (() => {
    const index = history.current.index, event = archive.get(index)
    if (event.type !== 'runtime/context') throw new TypeError('Invalid current context descriptor')
    const sections = payload(event, 'sections', index, 'runtime-context'), text = renderRuntimeContext(sections)
    return Object.freeze({ kind: 'runtime-context' as const, version: 1 as const, source: sources.ref(index, 'runtime-context'), sections,
      semanticDigest: runtimeContextDigest(sections), messages: text ? [{ role: 'user' as const, content: text }] : [] })
  })()
  const items = history.items.map(item => {
    const establishment = source(item.establishment)
    const own = options.prunedResults?.has(item.establishmentIndex) ? undefined : archive.get(item.establishmentIndex)
    const seedRecipe = item.recipes.find(recipe => recipe.kind === 'seed-item')
    const seedItem = own?.type === 'conversation/seed-group' && seedRecipe ? own.group.items[seedRecipe.item!] : undefined
    const rendered = finishItem({ ...item, id: `${establishment.id}:${item.kind}`, establishment, sources: item.sources.map(source), provenance: sources.provenance(item.establishmentIndex, item.establishment.part, item.admissionIndex),
      ...(item.stepSource ? { stepSource: source(item.stepSource) } : {}),
      ...(item.unitInfo ? { unitInfo: Object.freeze({ source: source(item.unitInfo.source), state: item.unitInfo.state }) } : {}),
      calls: item.calls.map(call => ({ ...call, ...(call.call ? { call: source(call.call) } : {}), ...(call.result ? { result: source(call.result) } : {}), ...(call.dispatch ? { dispatch: source(call.dispatch) } : {}) })),
      receivedResults: new Set([...item.receivedResults].map(id => { const ref = item.sources.find(candidate => candidate.id === id); return ref ? source(ref).id : id })),
      messages: seedItem ? readPayload(seedItem, 'messages', sources.ref(item.establishmentIndex, item.establishment.part)).map(copyConversationMessage) : item.recipes.map(recipe => render(recipe, item)),
    })
    return Object.freeze({ ...rendered, extent: item.extent,
      ...(seedItem?.kind === 'exchange' ? { exchange: Object.freeze({ ...rendered.exchange!, acceptance: 'inherited-observation' as const }) } : {}),
      ...(own?.type === 'compaction/replacement' ? { replacement: Object.freeze({ replacementId: own.replacementId, coverage: own.coverage, insertBefore: own.insertBefore }) } : {}) })
  })
  // Structural diagnostics use owner-neutral IDs; source them from this view.
  for (const diagnostic of history.diagnostics) if (!['missing-source-seq', 'invalid-source-seq', 'duplicate-source-seq'].includes(diagnostic.code)) diagnostics.push({ ...diagnostic, sourceIds: diagnostic.sourceIds.map(id => {
    const [_, coordinate, part] = JSON.parse(id) as [unknown, number | string, string]
    const index = typeof coordinate === 'number' ? sources.indexOfSeq(coordinate) : Number(coordinate.slice(6))
    return sources.ref(index, part).id
  }) })
  return Object.freeze({ version: 1, ...(current ? { current } : {}), ...(options.ownerSessionId === undefined ? {} : { ownerSessionId: options.ownerSessionId }), archiveEventCount: options.candidate?.baseCount ?? archive.length,
    ...(options.throughSeq === undefined ? {} : { throughSeq: options.throughSeq }), items: Object.freeze(items), diagnostics: Object.freeze(diagnostics.map(diagnostic => Object.freeze({ ...diagnostic, sourceIds: Object.freeze(diagnostic.sourceIds) }))) })
}
