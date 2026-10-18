import type { SessionEventView } from '../../managed/types.ts'
import type { ConversationCoverage, ConversationItemRef } from '../../events/replacement.ts'
import { outcomeField } from '../payload.ts'

/** Only structural metadata. No text, arguments, result/native/image bodies,
 * request attribution or receipts are retained by the history index. */
export interface HistoryFact {
  readonly index: number; readonly type: SessionEventView['type']; readonly seq?: number
  readonly callId?: string; readonly name?: string; readonly eventSeq?: number
  readonly actionId?: string; readonly attemptId?: string; readonly exchangeId?: string
  readonly stepStartSeq?: number; readonly assistantSeq?: number; readonly callSeqs?: readonly number[]
  readonly inputId?: string; readonly imageInputId?: string; readonly images?: boolean; readonly sessionScope?: boolean
  readonly preparedRawMessageSeq?: number
  readonly error?: boolean; readonly disposition?: 'unknown' | 'not-dispatched'
  readonly shadowedSeqs?: readonly number[]; readonly removedSeqs?: readonly number[]; readonly anchorSeq?: number
  readonly replacementId?: string; readonly coverage?: readonly ConversationCoverage[]; readonly insertBefore?: ConversationItemRef
}
export interface HistoryArchive { readonly length: number; get(index: number): HistoryFact }

export function historyFact(event: SessionEventView, index: number): HistoryFact {
  const base = { index, type: event.type, ...(event.seq === undefined ? {} : { seq: event.seq }) }
  switch (event.type) {
    case 'step/start': return { ...base, actionId: event.actionId, attemptId: event.attemptId }
    case 'model/exchange-accepted': return { ...base, exchangeId: event.exchangeId, stepStartSeq: event.stepStartSeq, assistantSeq: event.assistantSeq, callSeqs: [...event.callSeqs] }
    case 'tool/call': return { ...base, callId: event.callId, name: event.name }
    case 'tool/dispatch': return { ...base, callId: event.callId, eventSeq: event.eventSeq }
    case 'tool/result': {
      const output = outcomeField(event, 'output'), code = outcomeField(output, 'code')
      return { ...base, callId: event.callId, name: event.name, error: event.isError === true,
        images: Array.isArray(outcomeField(output, 'images')) && (outcomeField(output, 'images') as unknown[]).length > 0,
        ...(event.isError && code === 'TOOL_OUTCOME_UNKNOWN' && outcomeField(output, 'replay') === false ? { disposition: 'unknown' as const }
          : event.isError && (code === 'TOOL_ABORTED_BEFORE_DISPATCH' || code === 'TOOL_CANCELLED_BY_SIBLING') ? { disposition: 'not-dispatched' as const } : {}) }
    }
    case 'user/message': return { ...base, inputId: event.input?.inputId, imageInputId: event.imageInputId,
      ...(event.inputPreparation && 'rawMessageSeq' in event.inputPreparation ? { preparedRawMessageSeq: event.inputPreparation.rawMessageSeq } : {}),
      ...(event.seedInputContext ? { preparedRawMessageSeq: event.seedInputContext.rawMessageSeq } : {}),
      images: Array.isArray(outcomeField(event, 'images')) && event.images!.length > 0,
      sessionScope: (event.provenance ?? event.input?.provenance)?.scope === 'session' || event.input?.synthetic?.scope === 'session' }
    case 'agent/input/admitted': return { ...base, inputId: event.inputId, images: !!event.images?.length, sessionScope: event.provenance?.scope === 'session' || event.synthetic?.scope === 'session' }
    case 'agent/input/promoted': case 'agent/input/cancelled': return { ...base, inputId: event.inputId }
    case 'compaction/summary': return { ...base, shadowedSeqs: [...event.shadowedSeqs] }
    case 'compaction/reset': return { ...base, removedSeqs: [...event.removedSeqs ?? []] }
    case 'rewind/point': return { ...base, anchorSeq: event.anchorSeq }
    case 'compaction/replacement': return { ...base, replacementId: event.replacementId,
      coverage: event.coverage.map(entry => ({ item: { kind: entry.item.kind, at: { ...entry.item.at } }, sources: entry.sources.map(at => ({ ...at })) })),
      insertBefore: { kind: event.insertBefore.kind, at: { ...event.insertBefore.at } } }
    default: return base
  }
}

export function* historyEntries(archive: HistoryArchive): Generator<[number, HistoryFact]> {
  for (let index = 0; index < archive.length; index++) yield [index, archive.get(index)]
}
export function* historyFacts(archive: HistoryArchive): Generator<HistoryFact> {
  for (let index = 0; index < archive.length; index++) yield archive.get(index)
}
