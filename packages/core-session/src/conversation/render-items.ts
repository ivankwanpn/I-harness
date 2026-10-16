import type { SessionView, SessionEventView } from '../managed/types.ts'
import type { ConversationProjection, ConversationDiagnostic } from './types.ts'
import type { LLMMessage } from '../projection/types.ts'
import type { HistoryItem, HistoryRecipe } from './history/types.ts'
import { conversationSources } from './sources.ts'
import { finishItem } from './exchange.ts'
import { copyConversationData } from './render.ts'
import { readConversationPayload, projectToolResult, type ConversationPayloadCapture } from './payload.ts'
import { derivePruneSubstitutes } from '../projection/pruning.ts'

/** Payload-only rendering consumes the sole history owner's complete recipes.
 * It never establishes groups, closure, source unions, order or visibility. */
export function renderConversationItems(session: SessionView, history: { items: HistoryItem[]; diagnostics: ConversationDiagnostic[] }, options: { ownerSessionId?: string; throughSeq?: number; capturePayload?: ConversationPayloadCapture } = {}): ConversationProjection {
  const diagnostics: ConversationDiagnostic[] = []
  const sources = conversationSources(session, options.ownerSessionId, diagnostics)
  const source = (ref: { eventIndex: number; part: string }) => sources.ref(ref.eventIndex, ref.part)
  const pruned = derivePruneSubstitutes(session)
  const results = new Map<number, ReturnType<typeof projectToolResult>>()
  const payload = <T, K extends keyof T>(event: T, key: K, index: number, part: string) => copyConversationData(readConversationPayload(event, key, sources.ref(index, part), options.capturePayload))
  const result = (index: number) => {
    const previous = results.get(index)
    if (previous) return previous
    const event = session.events[index] as Extract<SessionEventView, { type: 'tool/result' }>
    const rendered = projectToolResult(event, pruned.get(event.callId), sources.ref(index, 'result'), sources.ref(index, 'image'), options.capturePayload)
    results.set(index, rendered)
    return rendered
  }
  const render = (recipe: HistoryRecipe, item: HistoryItem): LLMMessage => {
    const index = recipe.index!
    const event = session.events[index]
    if (recipe.kind === 'input') {
      if (event?.type !== 'user/message') throw new Error('Invalid input recipe')
      const admission = session.events[item.imageAdmissionIndex ?? -1]
      const images = event.imageInputId === undefined ? payload(event, 'images', index, 'image') : admission?.type === 'agent/input/admitted' ? payload(admission, 'images', item.imageAdmissionIndex!, 'admission') : undefined
      return images?.length ? { role: 'user', content: [{ type: 'text', text: event.text }, ...images.map(image => ({ type: 'image' as const, image }))] } : { role: 'user', content: event.text }
    }
    if (recipe.kind === 'summary') {
      if (event?.type !== 'compaction/summary' && event?.type !== 'compaction/replacement') throw new Error('Invalid summary recipe')
      return { role: 'user', content: event.text }
    }
    if (recipe.kind === 'result') {
      if (event?.type !== 'tool/result') throw new Error('Invalid result recipe')
      return { role: 'tool', toolCallId: event.callId, content: result(index).content, ...(event.isError === true ? { isError: true } : {}) }
    }
    if (recipe.kind === 'images') {
      const images = result(index).images ?? []
      return { role: 'user', content: [{ type: 'text', text: 'Attached image(s) from tool result:' }, ...images.map(image => ({ type: 'image' as const, image }))] }
    }
    const thinkingBlocks = event?.type === 'assistant/message' ? payload(event, 'thinkingBlocks', index, 'message') : undefined
    const providerContinuation = event?.type === 'assistant/message' ? payload(event, 'providerContinuation', index, 'message') : undefined
    const toolCalls = recipe.calls?.map(callIndex => {
      const call = session.events[callIndex]
      if (call?.type !== 'tool/call') throw new Error('Invalid call recipe')
      return { id: call.callId, name: call.name, args: payload(call, 'args', callIndex, 'call') }
    })
    return { role: 'assistant', content: event?.type === 'assistant/message' ? event.text : '', ...(toolCalls ? { toolCalls } : {}), ...(thinkingBlocks?.length ? { thinkingBlocks } : {}), ...(providerContinuation ? { providerContinuation } : {}) }
  }
  const items = history.items.map(item => {
    const establishment = source(item.establishment)
    const own = session.events[item.establishmentIndex]
    const rendered = finishItem({ ...item, id: `${establishment.id}:${item.kind}`, establishment, sources: item.sources.map(source), provenance: sources.provenance(item.establishmentIndex, item.establishment.part, item.admissionIndex),
      ...(item.stepSource ? { stepSource: source(item.stepSource) } : {}),
      calls: item.calls.map(call => ({ ...call, ...(call.call ? { call: source(call.call) } : {}), ...(call.result ? { result: source(call.result) } : {}), ...(call.dispatch ? { dispatch: source(call.dispatch) } : {}) })),
      receivedResults: new Set([...item.receivedResults].map(id => { const ref = item.sources.find(candidate => candidate.id === id); return ref ? source(ref).id : id })),
      messages: item.recipes.map(recipe => render(recipe, item)),
    })
    return own?.type === 'compaction/replacement' ? Object.freeze({ ...rendered, replacement: Object.freeze({ replacementId: own.replacementId, coverage: own.coverage, insertBefore: own.insertBefore }) }) : rendered
  })
  // Structural diagnostics use owner-neutral IDs; source them from this view.
  for (const diagnostic of history.diagnostics) if (!['missing-source-seq', 'invalid-source-seq', 'duplicate-source-seq'].includes(diagnostic.code)) diagnostics.push({ ...diagnostic, sourceIds: diagnostic.sourceIds.map(id => {
    const [_, coordinate, part] = JSON.parse(id) as [unknown, number | string, string]
    const index = typeof coordinate === 'number' ? session.events.findIndex(event => event.seq === coordinate) : Number(coordinate.slice(6))
    return sources.ref(index, part).id
  }) })
  return Object.freeze({ version: 1, ...(options.ownerSessionId === undefined ? {} : { ownerSessionId: options.ownerSessionId }), archiveEventCount: session.events.length,
    ...(options.throughSeq === undefined ? {} : { throughSeq: options.throughSeq }), items: Object.freeze(items), diagnostics: Object.freeze(diagnostics.map(diagnostic => Object.freeze({ ...diagnostic, sourceIds: Object.freeze(diagnostic.sourceIds) }))) })
}
