import type { SessionEventView } from '../../managed/types.ts'
import type { ConversationCoverage, ConversationItemRef } from '../../events/replacement.ts'
import { outcomeField } from '../payload.ts'
import { resultDisposition, resultIsError } from '../../results/projection.ts'
import { resultFactMetadata, type ResultFactMetadata } from './result-metadata.ts'

/** Only structural metadata. No text, arguments, result/native/image bodies,
 * request attribution or receipts are retained by the history index. */
export interface HistoryFact extends ResultFactMetadata {
  readonly seedResults?: readonly import('../selected-results-types.ts').SelectedResultRow[]
  readonly seedArtifacts?: readonly import('../../results/types.ts').ManagedArtifactRef[]
  readonly seedArtifactIndices?: readonly number[]
  readonly seedTurns?: import('../seed-types.ts').SeedTurnDomain
  readonly seedExtent?: import('../seed-types.ts').TurnExtent
  readonly seedItems?: readonly {
    kind: 'input' | 'summary' | 'exchange'; scope: 'turn' | 'session'; extent: import('../seed-types.ts').TurnExtent
    calls: readonly { id: string; name: string; outcome: 'success' | 'error' | 'not-dispatched'; result: number }[]
    resultCount: number; mediaCount: number
    resultUses: readonly { result: number; slot: 'sourceRetention.artifact' | 'dependencies.artifact'; artifact: number; use: import('../selected-results-types.ts').ResultUse }[]
  }[]
  readonly deliveryDependencies?: readonly number[]
  readonly deliveryGeneration?: string
  readonly deliveryOperation?: 'open'|'close'
  readonly deliverySourceSeq?: number
  readonly legacyRuntimeContext?: boolean
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

export function historyFact(event: SessionEventView, index: number, inheritedBoundary = 0): HistoryFact {
  const base = { index, type: event.type, ...(event.seq === undefined ? {} : { seq: event.seq }), ...resultFactMetadata(event) }
  switch (event.type) {
    case 'agent/delivery-generation': return {...base, deliveryOperation:event.op, ...(event.op==='open'?{deliveryGeneration:event.generationId,deliveryDependencies:[event.originInputSeq]}:{})}
    case 'agent/delivery-source': return {...base,deliveryGeneration:event.generationId,deliveryDependencies:event.kind==='subagent'?[event.callSeq,event.startSeq]:[event.callSeq]}
    case 'agent/delivery-handoff': return {...base,deliveryDependencies:[event.sourceSeq]}
    case 'exec/end': return {...base,deliveryDependencies:[event.sourceSeq]}
    case 'agent/delivery-received': return {...base,inputId:event.inputId,deliverySourceSeq:event.sourceSeq,deliveryDependencies:[event.sourceSeq,event.terminalSeq,event.seq!+1]}
    case 'conversation/seed-manifest': return { ...base, seedArtifacts: event.artifacts.map(artifact => ({ ...artifact.ref })), seedTurns: { ...event.turns, completed: event.turns.completed.map(interval => [...interval] as const) } }
    case 'conversation/seed-results': return { ...base, seedExtent: { ...event.page.extent }, seedResults: structuredClone(event.page.rows) }
    case 'conversation/seed-group': return { ...base,
      seedArtifactIndices: event.group.items.flatMap(item => item.kind !== 'exchange' ? [] : item.results.flatMap(result => result.kind !== 'envelope' ? [] : [
        ...(result.sourceRetention.kind === 'artifact' ? [result.sourceRetention.artifact] : []),
        ...(result.dependencies?.kind === 'catalog' ? [result.dependencies.artifact] : []),
      ])), seedExtent: { ...event.group.extent }, seedItems: event.group.items.map(item => ({ kind: item.kind, scope: item.scope, extent: { ...item.extent },
      calls: item.kind === 'exchange' ? item.calls.map(call => ({ id: call.id, name: call.name, outcome: call.outcome, result: call.result })) : [],
      resultCount: item.kind === 'exchange' ? item.results.length : 0,
      resultUses: item.kind !== 'exchange' ? [] : item.results.flatMap((result, ordinal) => result.kind !== 'envelope' ? [] : [
        ...(result.sourceRetention.kind === 'artifact' ? [{ result: ordinal, slot: 'sourceRetention.artifact' as const, artifact: result.sourceRetention.artifact, use: { kind: 'result' as const } }] : []),
        ...(result.dependencies?.kind === 'catalog' ? [{ result: ordinal, slot: 'dependencies.artifact' as const, artifact: result.dependencies.artifact, use: { kind: 'dependency-catalog' as const, count: result.dependencies.count } }] : []),
      ]), mediaCount: item.kind === 'input' ? item.input.media.length : item.kind === 'exchange' ? item.results.reduce((count, result) => count + result.media.length, 0) : 0 })) }
    case 'step/start': return { ...base, actionId: event.actionId, attemptId: event.attemptId }
    case 'model/exchange-accepted': return { ...base, exchangeId: event.exchangeId, stepStartSeq: event.stepStartSeq, assistantSeq: event.assistantSeq, callSeqs: [...event.callSeqs] }
    case 'tool/call': return { ...base, callId: event.callId, name: event.name }
    case 'tool/dispatch': return { ...base, callId: event.callId, eventSeq: event.eventSeq }
    case 'tool/result': {
      if (event.envelope) return { ...base, callId: event.callId, name: event.name, error: resultIsError(event.envelope), images: event.envelope.media.length > 0, disposition: resultDisposition(event.envelope) }
      const output = outcomeField(event, 'output'), code = outcomeField(output, 'code')
      return { ...base, callId: event.callId, name: event.name, error: event.isError === true,
        images: Array.isArray(outcomeField(output, 'images')) && (outcomeField(output, 'images') as unknown[]).length > 0,
        ...(event.isError && code === 'TOOL_OUTCOME_UNKNOWN' && outcomeField(output, 'replay') === false ? { disposition: 'unknown' as const }
          : event.isError && (code === 'TOOL_ABORTED_BEFORE_DISPATCH' || code === 'TOOL_CANCELLED_BY_SIBLING') ? { disposition: 'not-dispatched' as const } : {}) }
    }
    case 'user/message': return { ...base, legacyRuntimeContext: index >= inheritedBoundary && (event.provenance ?? event.input?.provenance)?.kind !== 'inherited' && event.internal === true && event.source?.kind === 'plugin' && event.source.plugin === 'i-harness/runtime-context', inputId: event.input?.inputId, imageInputId: event.imageInputId,
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
